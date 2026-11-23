// dsh-pwa host entry: serves the phone-optimized web surface at /m.
// The surface itself talks to the harness's standard /api (same origin, same
// trust fence as the desktop GUI). Besides the static assets — with a
// self-healing mount in case the webServer instance is re-created after us
// (pattern cribbed from dsh-feishu-chat) — the plugin adds one authenticated
// streaming route for files beyond the host's /api/file image cap.
import { mountRoutes } from './routes.js'
import { mountMediaRoutes, MEDIA_PATH } from './media.js'
import { mountVoiceRoutes, ASR_PATH, SCRIPT_PATH, TTS_PATH } from './voice.js'
import { SEARCH_PATH, mountSearchRoutes, createSearchService, resolveIndexPath, resolveStatePath } from './search.js'
import { DIAG_PATH, createDiagService, resolveDiagLogPath } from './diag.js'

export async function apply(ctx) {
  const TAG = '[dsh-pwa]'
  let disposed = false
  const log = (...a) => { if (!disposed) console.log(TAG, ...a) }
  const logErr = (...a) => { if (!disposed) console.error(TAG, ...a) }

  // Connection diagnostics (2026-11-23): the phone had no transport log for
  // WebSocket drops. The page batches close codes / visibility / network type
  // to an authenticated route; this side also watches /api/remote.mux upgrades
  // so a client close can be lined up with its server socket. Stored under
  // $DSH_HOME/state, transport metadata only — see diag.js.
  const diag = createDiagService({ logPath: resolveDiagLogPath(ctx) })

  let routesState = { server: null, dispose: null }
  function serverKey(server) {
    // ctx.get returns a fresh tracing proxy per call, so object identity is
    // never stable; the underlying node http.Server is the per-instance
    // identity and changes only when the webServer is truly re-created.
    try {
      if (server && server.server) return server.server
    } catch (e) { /* fall through */ }
    return server
  }
  function tryMountRoutes() {
    if (disposed) return
    const server = ctx.get('webServer')
    if (!server) return
    try {
      diag.watchServer(server)
    } catch (e) {
      logErr('diag watcher failed:', String(e))
    }
    const key = serverKey(server)
    if (routesState.server === key && routesState.dispose) return
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    try {
      const dispose = mountRoutes({ webServer: server })
      routesState = { server: key, dispose }
      log('🌐 mobile surface mounted at /m')
    } catch (e) {
      logErr('mount routes failed:', String(e))
    }
  }
  tryMountRoutes()
  const routesTimer = setInterval(tryMountRoutes, 5000)
  if (routesTimer.unref) routesTimer.unref()

  // Connection diagnostics drain: the PWA batches transport events (WebSocket
  // close code/reason/lifetime, visibility, network type, reconnect count) here.
  // No message content; the route is inside Connection's auth fence.
  ctx.inject(['connection'], (diagCtx) => {
    try {
      const dispose = diag.mount(diagCtx.connection)
      diagCtx.effect(() => () => { try { dispose() } catch (e) { /* ignore */ } }, 'dsh-pwa: diag route cleanup')
      log('🩺 connection diagnostics mounted at ' + DIAG_PATH)
    } catch (e) {
      logErr('mount diag route failed:', String(e))
    }
  })

  // Deliverable videos routinely exceed the host's 20 MiB /api/file cap, so the
  // preview/share path needs its own Range-capable route. Register it once the
  // Connection auth fence and filesystem seam exist; the injected scope owns the
  // route, so a Connection re-creation or plugin dispose unregisters it.
  ctx.inject(['connection', 'fs'], (mediaCtx) => {
    try {
      mountMediaRoutes({ connection: mediaCtx.connection, fs: mediaCtx.fs })
      log('🎞 media route mounted at ' + MEDIA_PATH)
    } catch (e) {
      logErr('mount media route failed:', String(e))
    }
  })

  // Voice mode (2026-11-15): three authenticated routes for the mobile
  // walkie-talkie surface — ASR transcription (DeepSeek), spoken-script rewrite
  // (streamed through the harness LLM service), and TTS synthesis (DeepSeek).
  // Needs DEEPSEEK_API_KEY for ASR/TTS; the rewrite works with any mounted provider.
  ctx.inject(['connection', 'llm'], (voiceCtx) => {
    try {
      const dispose = mountVoiceRoutes({ connection: voiceCtx.connection, llm: voiceCtx.llm })
      voiceCtx.effect(() => () => { dispose() }, 'dsh-pwa: voice routes cleanup')
      log('🎙 voice routes mounted: ' + ASR_PATH + ' · ' + SCRIPT_PATH + ' · ' + TTS_PATH)
    } catch (e) {
      logErr('mount voice routes failed:', String(e))
    }
  })

  // Content search for the mobile list (2026-11-21): the host's SQLite FTS5
  // cannot recall CJK substrings (unicode61 keeps a whole Chinese run as one
  // token) and its cold index build fails when any session is still writing.
  // The phone keeps its own literal index of message text instead, refreshed
  // from Session revisions and persisted under the harness home.
  ctx.inject(['connection', 'sessionQuery', 'sessions'], (searchCtx) => {
    const sessionPersistence = searchCtx.get('sessionPersistence')
    if (!sessionPersistence) {
      log('🔎 content search not mounted: no session persistence')
      return
    }
    try {
      const service = createSearchService({
        sessionQuery: searchCtx.sessionQuery,
        sessionPersistence,
        sessions: searchCtx.sessions,
        sessionController: searchCtx.get('sessionController'),
        indexPath: resolveIndexPath(searchCtx),
        skipCwd: resolveStatePath(searchCtx),
        log: (...a) => log('search:', ...a),
      })
      const dispose = mountSearchRoutes({ connection: searchCtx.connection, service })
      searchCtx.effect(() => () => {
        try { dispose() } catch (e) { /* ignore */ }
        service.close().catch(() => {})
      }, 'dsh-pwa: search route cleanup')
      service.warm()
      log('🔎 content search mounted at ' + SEARCH_PATH)
    } catch (e) {
      logErr('mount search route failed:', String(e))
    }
  })

  log('🚀 dsh-pwa starting')

  ctx.effect(() => () => {
    disposed = true
    diag.dispose()
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    clearInterval(routesTimer)
    log('🛑 dsh-pwa disposed')
  }, 'dsh-pwa: cleanup')
}
