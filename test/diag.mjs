// Unit test for the phone connection diagnostics sink (lib/diag.js).
// Run: node test/diag.mjs   (CI imports this from test/smoke.mjs)
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DIAG_LOG_NAME, DIAG_PATH, createDiagService, resolveDiagLogPath } from '../lib/diag.js'

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-pwa-diag-'))

function stubConnection() {
  const routes = new Map()
  return {
    routes,
    connection: {
      fetch: {
        register({ path: routePath, methods, requestBody, fetch }) {
          assert.equal(routePath, DIAG_PATH)
          assert.deepEqual(methods, ['POST'])
          assert.equal(requestBody, 'buffered')
          routes.set(routePath, fetch)
          return () => routes.delete(routePath)
        },
      },
    },
  }
}

function post(route, events, ua = 'diag-test') {
  return route(new Request('http://localhost' + DIAG_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: typeof events === 'string' ? events : JSON.stringify({ events }),
  }))
}

async function lines(logPath) {
  try {
    return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/* ------------------------------------------------------------ page route */
{
  const { routes, connection } = stubConnection()
  const logPath = path.join(tmp, 'batch', DIAG_LOG_NAME)
  const service = createDiagService({ logPath })
  const dispose = service.mount(connection)
  const route = routes.get(DIAG_PATH)
  assert.equal(typeof route, 'function')

  const event = { id: 'page-1:1', sid: 'page-1', t: 1, kind: 'ws_close', code: 1006, reason: '', clean: 0, dur: 8123, retry: 1, vis: 'visible', on: 1 }
  let res = await post(route, [event])
  assert.equal(res.status, 204)
  await service.drain()
  let records = await lines(logPath)
  assert.equal(records.length, 1)
  assert.equal(records[0].event.code, 1006)
  assert.equal(records[0].ua, 'diag-test')
  assert.equal(typeof records[0].receivedAt, 'number')

  // A beacon replay after reload must not duplicate the line.
  res = await post(route, [event])
  assert.equal(res.status, 204)
  await service.drain()
  assert.equal((await lines(logPath)).length, 1)

  res = await post(route, 'not-json')
  assert.equal(res.status, 400)
  res = await post(route, [])
  assert.equal(res.status, 400)
  res = await post(route, Array.from({ length: 51 }, (_, i) => ({ id: 'many:' + i, t: i, kind: 'ws_close' })))
  assert.equal(res.status, 413)
  res = await post(route, 'x'.repeat(70 * 1024))
  assert.equal(res.status, 413)
  // Oversized single events are skipped; the batch still succeeds if one remains.
  res = await post(route, [{ id: 'big:1', t: 1, kind: 'ws_close', reason: 'x'.repeat(3000) }, { id: 'small:1', t: 2, kind: 'vis' }])
  assert.equal(res.status, 204)
  await service.drain()
  assert.equal((await lines(logPath)).some((record) => record.event.id === 'big:1'), false)
  assert.equal((await lines(logPath)).some((record) => record.event.id === 'small:1'), true)

  dispose()
  assert.equal(routes.size, 0)
  await service.drain()

  // Rotation keeps the file bounded and leaves the previous generation at .1.
  const rotatePath = path.join(tmp, 'rotate', DIAG_LOG_NAME)
  const rotator = createDiagService({ logPath: rotatePath, maxBytes: 400 })
  const { routes: rotateRoutes, connection: rotateConnection } = stubConnection()
  rotator.mount(rotateConnection)
  const rotateRoute = rotateRoutes.get(DIAG_PATH)
  for (let i = 0; i < 4; i++) {
    const res2 = await post(rotateRoute, [{ id: 'rot:' + i, t: i, kind: 'ws_close', reason: 'r'.repeat(60) }])
    assert.equal(res2.status, 204)
    await rotator.drain()
  }
  const current = await lines(rotatePath)
  const previous = await lines(rotatePath + '.1')
  assert.ok(current.length + previous.length >= 2, 'rotation kept records somewhere')
  assert.ok(await stat(rotatePath + '.1').then(() => true, () => false), 'rotation created .1')
}

/* ------------------------------------------------------ server-side watch */
{
  const logPath = path.join(tmp, 'watch', DIAG_LOG_NAME)
  const service = createDiagService({ logPath })
  const raw = new EventEmitter()
  assert.equal(service.watchServer({ server: raw }), true)
  // Same server again is a no-op, not a duplicate listener.
  assert.equal(service.watchServer({ server: raw }), true)

  const socket = new EventEmitter()
  socket.bytesRead = 11
  socket.bytesWritten = 22
  raw.emit('upgrade', { url: '/api/remote.mux', headers: { 'user-agent': 'ios-pwa' } }, socket)
  raw.emit('upgrade', { url: '/api/other', headers: {} }, new EventEmitter())
  socket.emit('close')
  await service.drain()
  const records = await lines(logPath)
  const upgrade = records.find((record) => record.event.kind === 'srv_upgrade')
  const close = records.find((record) => record.event.kind === 'srv_close')
  assert.ok(upgrade, 'upgrade recorded')
  assert.ok(close, 'close recorded')
  assert.equal(upgrade.ua, 'ios-pwa')
  assert.equal(close.event.br, 11)
  assert.equal(close.event.bw, 22)
  assert.ok(close.event.dur >= 0)
  assert.equal(records.some((record) => record.event.kind === 'srv_upgrade' && record.event.id.includes('srv:2')), false)

  service.dispose()
  raw.emit('upgrade', { url: '/api/remote.mux', headers: {} }, new EventEmitter())
  await service.drain()
  assert.equal((await lines(logPath)).length, records.length)
}

/* --------------------------------------------------------------- paths */
{
  const home = path.join(tmp, 'home')
  const custom = { get: (key) => (key === 'dshHomePath' ? (...parts) => path.join(home, ...parts) : undefined) }
  assert.equal(resolveDiagLogPath(custom), path.join(home, 'state', DIAG_LOG_NAME))
  assert.equal(resolveDiagLogPath({}), path.join(os.homedir(), '.dsh', 'state', DIAG_LOG_NAME))
}

await rm(tmp, { recursive: true, force: true })
console.log('diag: OK (route, dedupe, limits, rotation, upgrade watch, paths)')
