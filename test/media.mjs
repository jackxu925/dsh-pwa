// Unit test for the PWA's authenticated large-file media route.
// Run: node test/media.mjs   (CI runs this on every push/PR)
import assert from 'node:assert/strict'
import { MEDIA_PATH, mountMediaRoutes, serveMedia } from '../lib/media.js'

const CHUNK = 4 * 1024 * 1024

// 8 byte fixture exercises ranges without allocating; a chunk-crossing fixture
// proves the response streams through the filesystem seam in bounded windows.
const small = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
const big = Buffer.alloc(CHUNK + 3, 9)
const files = new Map([
  ['/tmp/clip.mp4', big],
  ['/tmp/counts.csv', small],
  ['/tmp/blob.bin', small],
])
const dirs = new Set(['/tmp/folder'])
const reads = []

const fs = {
  async resolve(p) { return { targetKey: p, displayPath: p } },
  async stat(target) {
    if (target.targetKey === '/tmp/denied.mp4') throw Object.assign(new Error('denied'), { code: 'FS_PERMISSION_DENIED' })
    if (dirs.has(target.targetKey)) return { type: 'directory', version: 1 }
    if (!files.has(target.targetKey)) return undefined
    return { type: 'file', size: files.get(target.targetKey).length, version: 1 }
  },
  async readByteRange(target, { offset, length }, signal) {
    reads.push(length)
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { code: 'FS_ABORTED' })
    return files.get(target.targetKey).subarray(offset, offset + length)
  },
}

let route
const connection = {
  fetch: {
    register(r) {
      route = r
      return () => { route = undefined }
    },
  },
}

// 1. registration shape
const dispose = mountMediaRoutes({ connection, fs })
assert.equal(route.path, MEDIA_PATH)
assert.equal(route.path, '/api/pwa.file')
assert.deepEqual(route.methods, ['GET', 'HEAD'])
assert.equal(route.requestBody, 'buffered')

const mediaRequest = (p, init) => new Request('http://dsh.internal' + MEDIA_PATH + '?path=' + encodeURIComponent(p), init)
const request = (p, init) => route.fetch(mediaRequest(p, init))
const bodyOf = async (res) => Buffer.from(await res.arrayBuffer())

// 2. bad coordinates
assert.equal((await route.fetch(new Request('http://dsh.internal' + MEDIA_PATH))).status, 400)
assert.equal((await request('relative/clip.mp4')).status, 400)
assert.equal((await request('/tmp/missing.mp4')).status, 404)
assert.equal((await request('/tmp/folder')).status, 403)

// 3. complete response streams in bounded chunks with the right media type
reads.length = 0
let res = await request('/tmp/clip.mp4')
assert.equal(res.status, 200)
assert.equal(res.headers.get('content-type'), 'video/mp4')
assert.equal(res.headers.get('accept-ranges'), 'bytes')
assert.equal(res.headers.get('content-length'), String(big.length))
assert.equal(res.headers.get('cache-control'), 'private, no-store')
assert.deepEqual(await bodyOf(res), big)
assert.ok(reads.length >= 2, 'expected multiple stream pulls')
assert.ok(reads.every((n) => n <= CHUNK), 'stream pull exceeded the chunk bound')

// 4. Range windows: explicit, open-ended, suffix, unsatisfiable
res = await request('/tmp/clip.mp4', { headers: { range: 'bytes=0-3' } })
assert.equal(res.status, 206)
assert.equal(res.headers.get('content-range'), 'bytes 0-3/' + big.length)
assert.equal(res.headers.get('content-length'), '4')
assert.deepEqual(await bodyOf(res), Buffer.from([9, 9, 9, 9]))

res = await request('/tmp/clip.mp4', { headers: { range: 'bytes=' + CHUNK + '-' } })
assert.equal(res.status, 206)
assert.equal(res.headers.get('content-range'), 'bytes ' + CHUNK + '-' + (big.length - 1) + '/' + big.length)
assert.deepEqual(await bodyOf(res), Buffer.from([9, 9, 9]))

res = await request('/tmp/clip.mp4', { headers: { range: 'bytes=-2' } })
assert.equal(res.status, 206)
assert.equal(res.headers.get('content-range'), 'bytes ' + (big.length - 2) + '-' + (big.length - 1) + '/' + big.length)
assert.deepEqual(await bodyOf(res), Buffer.from([9, 9]))

res = await request('/tmp/clip.mp4', { headers: { range: 'bytes=' + (big.length + 5) + '-' } })
assert.equal(res.status, 416)
assert.equal(res.headers.get('content-range'), 'bytes */' + big.length)

// 5. HEAD has headers but no body
res = await request('/tmp/clip.mp4', { method: 'HEAD' })
assert.equal(res.status, 200)
assert.equal(res.headers.get('content-length'), String(big.length))
assert.equal((await res.arrayBuffer()).byteLength, 0)

// 6. mime falls back to octet-stream; csv stays text
assert.equal((await request('/tmp/blob.bin')).headers.get('content-type'), 'application/octet-stream')
assert.equal((await request('/tmp/counts.csv')).headers.get('content-type'), 'text/csv; charset=utf-8')

// 7. filesystem failures map to their status without leaking paths
res = await request('/tmp/denied.mp4')
assert.equal(res.status, 403)
assert.equal(await res.text(), 'file unavailable: FS_PERMISSION_DENIED')

dispose()
assert.equal(route, undefined)

// 8. direct handler entry stays callable without the registry (host seam)
res = await serveMedia(mediaRequest('/tmp/counts.csv'), fs)
assert.equal(res.status, 200)
assert.deepEqual(await bodyOf(res), small)

console.log('media: OK (route auth shape, 200/206/416/HEAD, bounded streaming, mime, fs failures)')
