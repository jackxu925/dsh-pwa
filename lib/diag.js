// Connection diagnostics for the mobile PWA.
//
// The phone has no transport log: a dropped WebSocket only flips the offline
// strip, and an iOS home-screen app cannot be inspected after the fact. This
// module gives the page a small authenticated drain for transport metadata and
// watches the HTTP upgrade for /api/remote.mux, so both sides of a drop land on
// one timeline:
//
//   POST /api/pwa.diag   { events: [{ id, t, kind, ... }] }
//     → one JSON line per event under $DSH_HOME/state/dsh-pwa-diag.ndjson
//
// It records transport metadata only — close codes, visibility, network type,
// timing — never message text, session ids, cookies or tokens. The route sits
// inside Connection's auth fence, and the NDJSON log stays on this machine.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Authenticated host route the mobile page posts batches to. */
export const DIAG_PATH = '/api/pwa.diag'
/** NDJSON file name under the harness state root. */
export const DIAG_LOG_NAME = 'dsh-pwa-diag.ndjson'

/** Largest request body accepted from the page. */
const MAX_BODY_BYTES = 64 * 1024
/** Largest number of events in one batch. */
const MAX_EVENTS = 50
/** Largest serialized event accepted; keeps one bad event from bloating a line. */
const MAX_EVENT_CHARS = 2048
/** Rotate to `<log>.1` once the next append would pass this size. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
/** Bounded client-event dedupe window (beacons may be replayed after reload). */
const MAX_SEEN_IDS = 5000
/** The host's single multiplexed WebSocket; only upgrades on this path are watched. */
const REMOTE_MUX_PATH = '/api/remote.mux'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/** Resolve the NDJSON path beside the harness state (or ~/.dsh/state). */
export function resolveDiagLogPath(ctx) {
  try {
    const home = ctx && typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof home === 'function') return path.join(home('state'), DIAG_LOG_NAME)
  } catch { /* fall through to the default home */ }
  return path.join(os.homedir(), '.dsh', 'state', DIAG_LOG_NAME)
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** Serialize appends through one queue and rotate before the file passes the cap. */
function createWriter(logPath, maxBytes) {
  let queue = Promise.resolve()
  async function append(records) {
    if (records.length === 0) return
    const text = records.map((record) => JSON.stringify(record) + '\n').join('')
    await mkdir(path.dirname(logPath), { recursive: true })
    let size = 0
    try {
      size = (await stat(logPath)).size
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
      try {
        await rename(logPath, logPath + '.1')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    await appendFile(logPath, text, 'utf8')
  }
  return {
    append(records) {
      const run = queue.then(() => append(records))
      // Keep the chain alive after a failed append so a later batch can succeed.
      queue = run.catch(() => {})
      return run
    },
    drain() { return queue },
  }
}

/**
 * Create the diagnostics sink.
 *
 * `record` writes batches (used by the upgrade watcher too), `mount` registers
 * the authenticated page route, `watchServer` attaches a passive upgrade/close
 * observer to the host HTTP server, and `drain`/`dispose` are for tests and
 * plugin unload.
 *
 * @param {object} options
 * @param {string} options.logPath - NDJSON destination.
 * @param {number} [options.maxBytes] - rotation threshold.
 */
export function createDiagService({ logPath, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const target = logPath || path.join(os.homedir(), '.dsh', 'state', DIAG_LOG_NAME)
  const writer = createWriter(target, maxBytes)
  const seen = new Set()
  const seenOrder = []
  let watch = null

  /** Drop client events already written (a beacon replay after reload is expected). */
  function dedupe(records) {
    const unique = []
    for (const record of records) {
      const id = record && record.event && record.event.id
      if (typeof id === 'string') {
        if (seen.has(id)) continue
        seen.add(id)
        seenOrder.push(id)
        if (seenOrder.length > MAX_SEEN_IDS) seen.delete(seenOrder.shift())
      }
      unique.push(record)
    }
    return unique
  }

  function record(records) {
    const unique = dedupe(records)
    return writer.append(unique).catch((error) => {
      // A failed append must not poison the dedupe window: let the page retry.
      for (const record of unique) {
        const id = record && record.event && record.event.id
        if (typeof id !== 'string') continue
        seen.delete(id)
        const index = seenOrder.indexOf(id)
        if (index >= 0) seenOrder.splice(index, 1)
      }
      throw error
    })
  }

  /** Register the authenticated page drain. Returns the route disposer. */
  function mount(connection) {
    return connection.fetch.register({
      path: DIAG_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let bytes
        try {
          bytes = Buffer.from(await request.arrayBuffer())
        } catch {
          return json(400, { error: 'bad-body' })
        }
        if (bytes.byteLength === 0) return json(400, { error: 'empty-body' })
        if (bytes.byteLength > MAX_BODY_BYTES) return json(413, { error: 'too-large' })
        let body
        try {
          body = JSON.parse(bytes.toString('utf8'))
        } catch {
          return json(400, { error: 'bad-json' })
        }
        const events = body && Array.isArray(body.events) ? body.events : null
        if (!events || events.length === 0) return json(400, { error: 'missing-events' })
        if (events.length > MAX_EVENTS) return json(413, { error: 'too-many-events' })
        const receivedAt = Date.now()
        const ua = String(request.headers.get('user-agent') || '').slice(0, 300)
        const records = []
        for (const event of events) {
          if (!event || typeof event !== 'object' || Array.isArray(event)) continue
          if (typeof event.kind !== 'string' || event.kind.length === 0 || event.kind.length > 40) continue
          let line
          try {
            line = JSON.stringify(event)
          } catch {
            continue
          }
          if (line.length > MAX_EVENT_CHARS) continue
          records.push({ receivedAt, ua, event })
        }
        if (records.length === 0) return json(400, { error: 'no-valid-events' })
        try {
          await record(records)
        } catch {
          return json(500, { error: 'write-failed' })
        }
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      },
    })
  }

  /**
   * Watch `/api/remote.mux` upgrades on the host HTTP server. The gateway owns
   * the WebSocket (Node calls every `upgrade` listener), so this is read-only:
   * it timestamps the upgrade and the raw socket close, with byte counters.
   * It never reads or writes the socket, and heartbeat terminations from the
   * gateway surface as an ordinary socket close.
   */
  function watchServer(webServer) {
    const raw = webServer && webServer.server ? webServer.server : webServer
    if (!raw || typeof raw.on !== 'function' || typeof raw.off !== 'function') return false
    if (watch && watch.raw === raw) return true
    if (watch) watch.dispose()
    let counter = 0
    const onUpgrade = (request, socket) => {
      let pathname
      try {
        pathname = new URL(request.url || '/', 'http://localhost').pathname
      } catch {
        return
      }
      if (pathname !== REMOTE_MUX_PATH) return
      const start = Date.now()
      const id = 'srv:' + (++counter) + ':' + Math.random().toString(16).slice(2)
      const headers = request.headers || {}
      const rawUa = typeof headers.get === 'function' ? headers.get('user-agent') : headers['user-agent']
      const ua = typeof rawUa === 'string' ? rawUa.slice(0, 300) : ''
      record([{ receivedAt: start, ua, event: { id, t: start, kind: 'srv_upgrade' } }]).catch(() => {})
      if (typeof socket.once !== 'function') return
      let closed = false
      const onClose = () => {
        if (closed) return
        closed = true
        const now = Date.now()
        record([{
          receivedAt: now,
          ua,
          event: {
            id: id + ':close',
            t: now,
            kind: 'srv_close',
            dur: now - start,
            br: Number(socket.bytesRead) || 0,
            bw: Number(socket.bytesWritten) || 0,
          },
        }]).catch(() => {})
      }
      if (socket.destroyed) onClose()
      else socket.once('close', onClose)
    }
    raw.on('upgrade', onUpgrade)
    watch = { raw, dispose: () => raw.off('upgrade', onUpgrade) }
    return true
  }

  return {
    record,
    mount,
    watchServer,
    drain: () => writer.drain(),
    dispose() {
      if (watch) {
        watch.dispose()
        watch = null
      }
    },
  }
}
