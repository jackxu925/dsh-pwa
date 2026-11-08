// Smoke test: mount the plugin's routes on a stub webServer and hit /m/health.
// Run: node test/smoke.mjs   (CI runs this on every push/PR)
import { mountRoutes } from '../lib/routes.js'
import { readFile } from 'node:fs/promises'

const handlers = new Map()
const stubHost = {
  webServer: {
    register({ kind, path, handler }) {
      if (kind !== 'exact' || typeof path !== 'string' || typeof handler !== 'function') {
        throw new Error(`bad route registration: ${kind} ${path}`)
      }
      handlers.set(path, handler)
      return () => handlers.delete(path)
    },
  },
}

const dispose = mountRoutes(stubHost)

const expected = ['/m', '/m/', '/m/app.js', '/m/style.css', '/m/manifest.webmanifest',
  '/m/icon.svg', '/m/icon-180.png', '/m/icon-512.png', '/m/health']
for (const p of expected) {
  if (!handlers.has(p)) throw new Error(`route not mounted: ${p}`)
}

function mockRes() {
  const chunks = []
  return {
    status: null, headers: null,
    writeHead(s, h) { this.status = s; this.headers = h },
    end(b) { chunks.push(b); this.body = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString() },
  }
}

const res = mockRes()
await handlers.get('/m/health')({}, res)
if (res.status !== 200) throw new Error(`/m/health returned ${res.status}`)
const body = JSON.parse(res.body)
if (!body.ok || body.surface !== 'dsh-pwa') throw new Error(`/m/health bad body: ${res.body}`)

// index.html must reference the PWA install surface
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
for (const needle of ['manifest.webmanifest', 'apple-touch-icon', '/m/app.js']) {
  if (!html.includes(needle)) throw new Error(`index.html missing: ${needle}`)
}

dispose()
if (handlers.size !== 0) throw new Error('dispose() did not unregister routes')

console.log(`smoke: OK (${expected.length} routes, /m/health 200, dispose clean)`)

// The media route's unit test rides this existing CI step (the agent token cannot
// edit .github/workflows): importing it runs its assertions and summary here.
await import('./media.mjs')
