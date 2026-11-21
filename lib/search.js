// Phone-side content search: a local literal index over Session messages.
//
// Why this exists instead of calling the host's `session/search`:
//   1. Its SQLite FTS5 index uses the `unicode61` tokenizer, which treats a run
//      of Chinese characters as ONE token. Searching 旺佳旺 therefore cannot
//      match 海口万达旺佳旺超市; only text where the word happens to stand
//      between spaces/punctuation is found.
//   2. Its cold index build requires two identical persistence snapshots. On
//      this deployment a background agent (or any active session) writes while
//      the first scan runs, so `session/search` fails permanently with
//      "did not stabilize after one retry".
//
// The phone needs substring recall across CJK, so this module keeps its own
// index instead:
//   - `ctx.sessionQuery.filterEvents()` extracts first-party message text
//     without activating an Agent (the same semantic documents the host indexes).
//   - Revisions come from `ctx.sessionPersistence.list()`, so after the first
//     pass only sessions whose log changed are read again.
//   - The compact index is persisted under `~/.dsh/cache` and built in the
//     background: searches hit the current snapshot immediately, and the UI
//     polls while the rest is still being indexed.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Authenticated host route the mobile page calls. */
export const SEARCH_PATH = '/api/pwa.search'

/** On-disk index shape version; bump to discard an incompatible cache. */
const INDEX_VERSION = 1
/** Query length ceiling; longer input is not a search keyword. */
const MAX_QUERY_CHARS = 200
/** Per-session text ceiling, keeping one runaway session from bloating the cache. */
const MAX_TEXT_CHARS = 1_000_000
/** Parallel cold Session reads; matches the host query service's prepared cache. */
const BUILD_CONCURRENCY = 4
/** Delay after activation before the first background refresh starts. */
const WARM_DELAY_MS = 2000
/** Debounce for writing the JSON snapshot to disk. */
const SAVE_DEBOUNCE_MS = 1500
/** Serialized result page size (the page renders at most 20). */
const RESULT_LIMIT = 20

/**
 * Internal agent/ticket workspaces under `$DSH_HOME/state` churn constantly
 * (every running worker appends while we read) and their huge logs would be
 * re-read on every refresh. They are not the user's phone conversations, so
 * the content index leaves them out; the list/search UI still shows them.
 */
const INTERNAL_CWD_RE = /(?:^|\/)\.dsh\/state(?:\/|$)/

function isIndexableCwd(cwd, skipCwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return true
  if (INTERNAL_CWD_RE.test(cwd)) return false
  if (skipCwd && (cwd === skipCwd || cwd.startsWith(skipCwd + path.sep))) return false
  return true
}

/**
 * Keep the durable file identity of a persistence revision (dev:ino:size:
 * mtimeNs:ctimeNs) and drop the historical-corpus suffix. That suffix changes
 * when the process observes a different corpus, which would otherwise re-read
 * hundreds of unchanged old-format sessions after every restart.
 */
export function stableRevision(revision) {
  const parts = String(revision == null ? '' : revision).split(':')
  return parts.length >= 5 ? parts.slice(0, 5).join(':') : parts.join(':')
}

/** The two message surfaces the mobile search should look at, mirroring session/search. */
const MESSAGE_FILTERS = Object.freeze([
  Object.freeze({ kind: 'type', values: Object.freeze(['user/message', 'assistant/message']) }),
  Object.freeze({ kind: 'surface', values: Object.freeze(['current']) }),
])

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/** JSON response helper shared by the route. */
function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/** Resolve the durable index path without assuming a particular DSH home. */
export function resolveIndexPath(ctx) {
  try {
    const home = ctx && typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof home === 'function') return home('cache', 'dsh-pwa-search.json')
  } catch { /* fall through to the default home */ }
  return path.join(os.homedir(), '.dsh', 'cache', 'dsh-pwa-search.json')
}

/** Resolve the harness state root for the internal-workspace filter. */
export function resolveStatePath(ctx) {
  try {
    const home = ctx && typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof home === 'function') return home('state')
  } catch { /* fall through to the default home */ }
  return path.join(os.homedir(), '.dsh', 'state')
}

/** Escape one literal fragment for use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Build a case-insensitive, whitespace-flexible literal matcher, the same
 * semantics as the host's filterEvents text clause (words may be separated by
 * any whitespace in the indexed text).
 */
export function queryMatcher(query) {
  const trimmed = String(query || '').trim().replace(/\s+/gu, ' ')
  if (trimmed.length < 2) return null
  const pattern = trimmed.split(' ').map(escapeRegExp).join('\\s+')
  try { return new RegExp(pattern, 'iu') } catch { return null }
}

/** Collapse a matched window into a one-line snippet around the hit. */
export function snippetAround(text, index, length, before = 60, after = 120) {
  const source = String(text || '')
  if (typeof index !== 'number' || index < 0 || index >= source.length) {
    const plain = source.slice(0, before + after).replace(/\s+/gu, ' ').trim()
    return (source.length > before + after ? plain + '…' : plain)
  }
  const start = Math.max(0, index - before)
  const end = Math.min(source.length, index + Math.max(1, length) + after)
  let snippet = source.slice(start, end).replace(/\s+/gu, ' ').trim()
  if (start > 0) snippet = '…' + snippet
  if (end < source.length) snippet = snippet + '…'
  return snippet
}

/** Validate one persisted entry; malformed cache rows are dropped, not trusted. */
function validEntry(entry) {
  return !!entry && typeof entry === 'object'
    && typeof entry.revision === 'string'
    && typeof entry.text === 'string'
    && Number.isFinite(entry.updatedAt)
}

/** Run `worker` over `items` with a bounded number of concurrent calls. */
async function runPool(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

/**
 * Create the local content-search service.
 *
 * @param sessionQuery - host SessionQueryEngine (filterEvents reads message docs).
 * @param sessionPersistence - host persistence service (list gives change revisions).
 * @param sessions - host live Session store (ctx.sessions).
 * @param sessionController - optional host list controller; supplies updatedAt ordering.
 * @param indexPath - JSON cache path; pass a temp path in tests.
 * @param skipCwd - harness state root whose internal sessions are not indexed.
 * @param log - diagnostic logger.
 */
export function createSearchService({ sessionQuery, sessionPersistence, sessions, sessionController, indexPath, skipCwd, log = () => {} }) {
  /** @type {Map<string, {revision: string, updatedAt: number, text: string, error?: string}>} */
  const entries = new Map()
  let loaded = false
  let loadPromise = null
  let refreshPromise = null
  let lastRefreshAt = 0
  let disposed = false
  let saveTimer = null
  let savePromise = null
  let dirty = false
  let initialized = false
  let building = false
  let total = 0
  let lastError = null

  // Before the first list lands there is no progress to report yet, so expose
  // the warm-up as building; after that only actual per-session work counts
  // (a frequent no-op revision check must not keep the UI polling forever).
  const status = () => ({ building: building || (!initialized && refreshPromise !== null), indexed: entries.size, total, lastError })

  async function ensureLoaded() {
    if (loaded) return
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
        if (parsed && parsed.version === INDEX_VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
          for (const [id, entry] of Object.entries(parsed.sessions)) {
            if (typeof id === 'string' && id && validEntry(entry)) entries.set(id, entry)
          }
          total = entries.size
        }
      } catch (error) {
        if (error && error.code !== 'ENOENT') log('search index load failed:', String(error.message || error))
      } finally {
        loaded = true
      }
    })()
    return loadPromise
  }

  /** Atomic snapshot write; a failure leaves the previous cache intact. */
  async function saveNow() {
    if (disposed) return
    if (savePromise) {
      await savePromise
      if (!dirty || disposed) return
    }
    dirty = false
    const snapshot = {}
    for (const [id, entry] of entries) snapshot[id] = entry
    savePromise = (async () => {
      try {
        await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 })
        const tmp = indexPath + '.tmp'
        await writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, savedAt: Date.now(), sessions: snapshot }), { mode: 0o600 })
        await rename(tmp, indexPath)
      } catch (error) {
        log('search index save failed:', String(error.message || error))
      } finally {
        savePromise = null
      }
    })()
    await savePromise
    if (dirty && !disposed) return saveNow()
  }

  function scheduleSave() {
    if (disposed || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow().catch(() => {})
    }, SAVE_DEBOUNCE_MS)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  /** Newest-first visible Session list, with the activity timestamp used for ranking. */
  async function listTargets() {
    if (sessionController && typeof sessionController.list === 'function') {
      const items = await sessionController.list()
      return (Array.isArray(items) ? items : [])
        .filter((item) => item && isIndexableCwd(item.cwd, skipCwd))
        .map((item) => ({
          id: item.sessionId,
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
        }))
    }
    const records = await sessionQuery.listSessions()
    return (Array.isArray(records) ? records : [])
      .filter((record) => record && record.header && record.header.cwd !== undefined && isIndexableCwd(record.header.cwd, skipCwd))
      .map((record) => ({ id: record.header.id, updatedAt: record.header.createdAt || 0 }))
  }

  /** Live Session change token: its contiguous log length, cheap to read. */
  function liveRevision(session) {
    try { return 'live:' + session.snapshotEvents().length } catch { return undefined }
  }

  async function loadSession(item, revision) {
    if (disposed) return
    try {
      const docs = await sessionQuery.filterEvents(item.id, MESSAGE_FILTERS)
      let text = ''
      for (const doc of Array.isArray(docs) ? docs : []) {
        if (doc && typeof doc.text === 'string' && doc.text) text += (text ? '\n' : '') + doc.text
      }
      // Keep the recent tail when a session exceeds the budget: current context
      // is more likely to be the conversation the user is trying to find.
      if (text.length > MAX_TEXT_CHARS) text = text.slice(-MAX_TEXT_CHARS)
      entries.set(item.id, { revision, updatedAt: item.updatedAt, text })
      dirty = true
    } catch (error) {
      // A corrupt/unreadable session must not abort the whole build; remember
      // the revision so it is retried only after the log changes.
      entries.set(item.id, {
        revision,
        updatedAt: item.updatedAt,
        text: '',
        error: String(error && error.message || error),
      })
      dirty = true
      log('search index session failed:', item.id, String(error && error.message || error))
    }
    if (entries.size % 10 === 0) scheduleSave()
  }

  async function doRefresh() {
    await ensureLoaded()
    if (disposed) return
    lastRefreshAt = Date.now()
    let targets
    try {
      targets = await listTargets()
    } catch (error) {
      lastError = 'list: ' + String(error && error.message || error)
      log('search index list failed:', lastError)
      return
    }
    total = targets.length
    const revisions = new Map()
    try {
      const snapshots = await sessionPersistence.list()
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        if (snapshot && snapshot.header) revisions.set(snapshot.header.id, stableRevision(snapshot.revision))
      }
    } catch (error) {
      lastError = 'persistence: ' + String(error && error.message || error)
      log('search index persistence list failed:', lastError)
    }
    const live = new Map()
    try {
      for (const session of sessions.list()) live.set(session.id, session)
    } catch (error) {
      log('search index live list failed:', String(error && error.message || error))
    }
    const targetIds = new Set(targets.map((target) => target.id))
    for (const id of [...entries.keys()]) if (!targetIds.has(id)) { entries.delete(id); dirty = true }
    const pending = []
    for (const target of targets) {
      const session = live.get(target.id)
      const revision = (session && liveRevision(session)) || revisions.get(target.id)
      if (!revision) continue
      const previous = entries.get(target.id)
      if (previous && stableRevision(previous.revision) === revision) {
        if (previous.revision !== revision) { previous.revision = revision; dirty = true }
        if (previous.updatedAt !== target.updatedAt) { previous.updatedAt = target.updatedAt; dirty = true }
        continue
      }
      pending.push({ ...target, revision })
    }
    pending.sort((a, b) => b.updatedAt - a.updatedAt)
    if (!pending.length) {
      building = false
      lastError = null
      if (dirty) scheduleSave()
      return
    }
    building = true
    try {
      await runPool(pending, BUILD_CONCURRENCY, (item) => loadSession(item, item.revision))
    } finally {
      building = false
    }
    lastError = null
    if (dirty) await saveNow()
  }

  /** Single-flight refresh; callers that do not await still get progress. */
  function refresh() {
    if (refreshPromise) return refreshPromise
    refreshPromise = doRefresh()
      .catch((error) => {
        lastError = String(error && error.message || error)
        log('search index refresh failed:', lastError)
      })
      .finally(() => { refreshPromise = null; initialized = true })
    return refreshPromise
  }

  /** Kick a refresh only when the last one is stale, keeping typing cheap. */
  function maybeRefresh() {
    if (disposed || refreshPromise) return
    if (Date.now() - lastRefreshAt < 15000) return
    refresh().catch(() => {})
  }

  /**
   * Search the current snapshot. Returns immediately; a background refresh may
   * still be adding sessions, which the response exposes through `building`.
   */
  async function search(query) {
    const raw = String(query == null ? '' : query)
    if (raw.length > MAX_QUERY_CHARS) return { error: 'query too long' }
    const matcher = queryMatcher(raw)
    if (!matcher) return { items: [], hasMore: false, ...status() }
    await ensureLoaded()
    maybeRefresh()
    const matched = []
    for (const [id, entry] of entries) {
      if (!entry.text) continue
      const found = matcher.exec(entry.text)
      if (!found) continue
      matched.push({
        sessionId: id,
        updatedAt: entry.updatedAt || 0,
        snippet: snippetAround(entry.text, found.index, found[0].length),
      })
    }
    matched.sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      items: matched.slice(0, RESULT_LIMIT).map(({ sessionId, snippet }) => ({ sessionId, snippet })),
      hasMore: matched.length > RESULT_LIMIT,
      ...status(),
    }
  }

  return {
    /** Start the background build shortly after the host finishes activating. */
    warm() {
      const timer = setTimeout(() => { if (!disposed) refresh().catch(() => {}) }, WARM_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
    },
    refresh,
    search,
    status,
    async close() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      await saveNow()
      disposed = true
    },
  }
}

/** Register the authenticated search route. Returns a disposer. */
export function mountSearchRoutes({ connection, service }) {
  return connection.fetch.register({
    path: SEARCH_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { error: 'bad-json' })
      }
      const query = body && typeof body.query === 'string' ? body.query.trim() : ''
      if (query.length < 2) return json(200, { items: [], hasMore: false, building: false, indexed: 0, total: 0 })
      try {
        const result = await service.search(query)
        if (result.error) return json(400, { error: result.error })
        return json(200, result)
      } catch (error) {
        return json(500, { error: 'search-failed', message: String(error && error.message || error) })
      }
    },
  })
}
