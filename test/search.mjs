// Unit test for the PWA-local content index (the phone's CJK-safe search).
// Run: node test/search.mjs   (CI imports this from test/smoke.mjs)
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SEARCH_PATH,
  createSearchService,
  mountSearchRoutes,
  queryMatcher,
  resolveIndexPath,
  snippetAround,
  stableRevision,
} from '../lib/search.js'

/* ---------------------------------------------------------------- fixtures */

const documents = {
  's-1': ['我们门店和海口万达旺佳旺超市对接了销售数据。', '今天继续抓销售。'],
  's-2': ['明天处理竞对数据。'],
  's-3': ['旺佳旺的门店库存要补一下。'],
  // Internal agent/ticket workspace: huge, actively written, not a phone conversation.
  'internal-1': ['内部任务也会出现 旺佳旺，但不该进索引'],
  // A custom harness home: filtered by the explicit state root, not the .dsh regex.
  'skip-1': ['自定义 home 的内部任务 旺佳旺'],
}
const revisions = { 's-1': 'file:1', 's-2': 'file:1', 's-3': 'file:1', 'internal-1': 'file:1', 'skip-1': 'file:1' }
const activity = { 's-1': 300, 's-2': 200, 's-3': 100, 'internal-1': 500, 'skip-1': 600 }
const cwdById = { 'internal-1': '/Users/someone/.dsh/state/superagent/work/ticket-1', 'skip-1': '/tmp/skip-state/work/ticket-2' }
let filterCalls = 0
let liveSessions = []

const sessionQuery = {
  async filterEvents(id) {
    filterCalls++
    const docs = documents[id] || []
    return docs.map((text, seq) => ({ sessionId: id, seq, type: 'user/message', time: activity[id] || 0, surface: 'current', text }))
  },
  async listSessions() {
    return Object.keys(documents).map((id) => ({ header: { id, cwd: cwdById[id] || '/tmp/work', createdAt: activity[id] || 0 }, live: false, persisted: true }))
  },
}
const sessionPersistence = {
  async list() {
    return Object.keys(documents).map((id) => ({ header: { id, cwd: cwdById[id] || '/tmp/work' }, revision: revisions[id] }))
  },
}
const sessions = { list: () => liveSessions }
const sessionController = {
  async list() {
    return Object.keys(documents)
      .map((id) => ({ sessionId: id, updatedAt: activity[id] || 0, cwd: cwdById[id] || '/tmp/work' }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  },
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-pwa-search-'))
const indexPath = path.join(tmp, 'index.json')

/* ------------------------------------------------------------- pure helpers */

assert.ok(queryMatcher('旺佳旺'), 'CJK query must produce a matcher')
assert.equal(queryMatcher('x'), null, 'one character is below the search floor')
assert.ok(queryMatcher('foo bar').test('prefix foo\n  bar suffix'), 'words may be separated by any whitespace')
const snippet = snippetAround('前缀' + '旺佳旺'.repeat(3) + '后缀', 2, 3)
assert.ok(snippet.includes('旺佳旺'), 'snippet keeps the hit')

/* --------------------------------------------------------------- build/search */

const service = createSearchService({
  sessionQuery,
  sessionPersistence,
  sessions,
  sessionController,
  indexPath,
  skipCwd: '/tmp/skip-state',
  log: () => {},
})
await service.refresh()

// Regression for the host FTS bug: 旺佳旺 is inside a longer CJK run in s-1,
// which unicode61 tokenization can never match.
let result = await service.search('旺佳旺')
assert.deepEqual(result.items.map((h) => h.sessionId), ['s-1', 's-3'], 'substring matches, newest session first')
assert.equal(result.building, false)
assert.equal(result.total, 3)
assert.equal(result.indexed, 3)
assert.ok(result.items[0].snippet.includes('旺佳旺'), 'hit carries a snippet around the match')

// Two-character CJK query (the UI floor) and a different substring.
assert.equal((await service.search('佳旺')).items.length, 2)
assert.equal((await service.search('海口万达')).items.length, 1)

// Whitespace-flexible, case-insensitive ASCII.
documents['s-2'] = ['Inventory Sync is ready.']
revisions['s-2'] = 'file:2'
await service.refresh()
assert.equal((await service.search('inventory sync')).items[0].sessionId, 's-2')

// Incremental refresh only re-reads the changed session.
const callsBefore = filterCalls
await service.refresh()
assert.equal(filterCalls, callsBefore, 'unchanged revisions must not be read again')

// Historical-format revisions append a corpus suffix that drifts between
// processes; only the durable file identity may trigger a re-read.
assert.equal(stableRevision('10:20:30:40:50:corpus-a'), '10:20:30:40:50')
revisions['s-3'] = '10:20:30:40:50:corpus-a'
await service.refresh()
const callsBeforeSuffix = filterCalls
revisions['s-3'] = '10:20:30:40:50:corpus-b'
await service.refresh()
assert.equal(filterCalls, callsBeforeSuffix, 'a corpus suffix change alone must not re-read the session')

// A removed session disappears from results.
delete documents['s-1']
await service.refresh()
assert.equal((await service.search('海口万达')).items.length, 0)

// A live session uses its log length as the change token.
liveSessions = [{ id: 'live-1', snapshotEvents: () => new Array(7) }]
documents['live-1'] = ['live 会话也有关键词 旺佳旺']
activity['live-1'] = 400
await service.refresh()
assert.equal((await service.search('旺佳旺')).items[0].sessionId, 'live-1')
liveSessions = []
delete documents['live-1']
delete activity['live-1']
await service.refresh()

/* ---------------------------------------------------------------- persistence */

await service.close()
await new Promise((resolve) => setTimeout(resolve, 100))
const reloaded = createSearchService({
  sessionQuery,
  sessionPersistence,
  sessions,
  sessionController,
  indexPath,
  skipCwd: '/tmp/skip-state',
  log: () => {},
})
filterCalls = 0
await reloaded.refresh()
assert.equal(filterCalls, 0, 'a warm index must reuse the persisted snapshot')
assert.equal((await reloaded.search('旺佳旺')).items.length, 1)
const cache = JSON.parse(await readFile(indexPath, 'utf8'))
assert.equal(cache.version, 1)
assert.ok(cache.sessions['s-3'], 'cache file keeps per-session text')

// A no-op refresh must not rewrite the (potentially large) cache every poll.
// Let any save scheduled by the load-time refresh settle before the baseline.
await new Promise((resolve) => setTimeout(resolve, 2200))
const beforeStat = await stat(indexPath)
await reloaded.refresh()
await new Promise((resolve) => setTimeout(resolve, 2200))
const afterStat = await stat(indexPath)
assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'an unchanged refresh must not rewrite the index')

// The persisted index survives a rebuild of the service and stays small.
await reloaded.close()

/* ---------------------------------------------------------------- route shape */

let route
const connection = {
  fetch: {
    register(reg) {
      route = reg
      return () => { route = undefined }
    },
  },
}
const routeService = createSearchService({
  sessionQuery,
  sessionPersistence,
  sessions,
  sessionController,
  indexPath: path.join(tmp, 'route.json'),
  skipCwd: '/tmp/skip-state',
  log: () => {},
})
await routeService.refresh()
const dispose = mountSearchRoutes({ connection, service: routeService })
assert.equal(route.path, SEARCH_PATH)
assert.equal(route.path, '/api/pwa.search')
assert.deepEqual(route.methods, ['POST'])
assert.equal(route.requestBody, 'buffered')

const call = (body) => route.fetch(new Request('http://dsh.internal/api/pwa.search', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}))
let response = await call({ query: '旺佳旺' })
assert.equal(response.status, 200)
let payload = await response.json()
assert.equal(payload.items.length, 1)
assert.equal(payload.items[0].sessionId, 's-3')
assert.equal(payload.building, false)

assert.equal((await call('not json')).status, 400)
response = await call({ query: 'x' })
assert.equal(response.status, 200)
assert.deepEqual((await response.json()).items, [])
response = await call({ query: 'q'.repeat(201) })
assert.equal(response.status, 400)

dispose()
assert.equal(route, undefined, 'dispose unregisters the route')
await routeService.close()

/* ---------------------------------------------------------------- path resolver */

const fakeCtx = { get: (name) => name === 'dshHomePath' ? (...parts) => path.join('/tmp/dsh-home', ...parts) : undefined }
assert.equal(resolveIndexPath(fakeCtx), path.join('/tmp/dsh-home', 'cache', 'dsh-pwa-search.json'))
assert.ok(resolveIndexPath({ get: () => undefined }).endsWith(path.join('.dsh', 'cache', 'dsh-pwa-search.json')))

await rm(tmp, { recursive: true, force: true })
console.log('search: OK (CJK substring, incremental revisions, persisted cache, route auth shape)')
