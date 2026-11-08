// Authenticated large-file streaming route for the mobile surface.
//
// The host's /api/file serves images bounded by the attachment image cap
// (20 MiB by default), so deliverables like a 22 MB MP4 come back 413 — the
// preview sheet cannot play them and the share flow cannot even read the
// bytes. This route lives inside Connection's auth fence (same owner cookie
// and Host/Origin fence as /api/file), streams through the configured
// filesystem seam in bounded chunks, and answers HTTP Range requests so
// mobile browsers can start playback and seek without buffering the whole
// file in the host process.
import path from 'node:path'

/** Exact authenticated route the page fetches and plays. */
export const MEDIA_PATH = '/api/pwa.file'

/** Bytes read from the filesystem seam per stream pull. */
const CHUNK_BYTES = 4 * 1024 * 1024

const BASE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
}

/** Extension → media type for the bytes the page plays or shares. */
const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Filesystem errors the host route vocabulary already assigns statuses to. */
const FS_STATUS = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_TOO_LARGE: 413,
  FS_ABORTED: 499,
}

/**
 * Register the media route inside Connection's authentication fence.
 * @param connection - authenticated exact-route registry (ctx.connection).
 * @param fs - filesystem seam (ctx.fs) used for resolve/stat/readByteRange.
 * @returns the registration disposer owned by the calling context.
 */
export function mountMediaRoutes({ connection, fs }) {
  return connection.fetch.register({
    path: MEDIA_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: (request) => serveMedia(request, fs),
  })
}

/**
 * Serve one absolute file path, honoring one HTTP Range window.
 * @param request - authenticated Fetch request from the browser or a video element.
 * @param fs - filesystem seam.
 * @returns headers plus a bounded streaming body.
 */
export async function serveMedia(request, fs) {
  const signal = request.signal
  const rawPath = new URL(request.url).searchParams.get('path')
  if (rawPath === null || rawPath.length === 0) return fail(400, 'missing path')
  if (rawPath.includes('\0') || !path.isAbsolute(rawPath)) return fail(400, 'absolute path required')

  let target, info
  try {
    target = await fs.resolve(rawPath, { signal })
    info = await fs.stat(target, signal)
  } catch (error) {
    return failure(error, signal)
  }
  if (info === undefined) return fail(404, 'not found')
  if (info.type !== 'file') return fail(403, 'not a regular file')

  const size = typeof info.size === 'number' ? info.size : undefined
  const mediaType = mimeOf(rawPath)

  if (request.method === 'HEAD') {
    const headers = { ...BASE_HEADERS, 'content-type': mediaType, 'accept-ranges': 'bytes' }
    if (size !== undefined) headers['content-length'] = String(size)
    return new Response(null, { status: 200, headers })
  }

  const rangeHeader = request.headers.get('range')
  if (rangeHeader !== null && size !== undefined) {
    const range = parseRange(rangeHeader, size)
    if (range === 'invalid' || range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...BASE_HEADERS, 'content-range': 'bytes */' + size },
      })
    }
    if (range !== null) {
      return new Response(streamWindow(fs, target, range.start, range.end, signal), {
        status: 206,
        headers: {
          ...BASE_HEADERS,
          'content-type': mediaType,
          'accept-ranges': 'bytes',
          'content-range': 'bytes ' + range.start + '-' + range.end + '/' + size,
          'content-length': String(range.end - range.start + 1),
        },
      })
    }
  }

  const headers = { ...BASE_HEADERS, 'content-type': mediaType, 'accept-ranges': 'bytes' }
  if (size === undefined) {
    return new Response(streamWindow(fs, target, 0, Infinity, signal), { status: 200, headers })
  }
  headers['content-length'] = String(size)
  if (size === 0) return new Response(null, { status: 200, headers })
  return new Response(streamWindow(fs, target, 0, size - 1, signal), { status: 200, headers })
}

/** Plain refusal with the shared defensive headers. */
function fail(status, text) {
  return new Response(text, { status, headers: BASE_HEADERS })
}

/** Map a filesystem or client-abort failure onto an HTTP status without leaking paths. */
function failure(error, signal) {
  if (signal && signal.aborted) return new Response(null, { status: 499 })
  const code = error && typeof error === 'object' ? error.code : undefined
  const status = code !== undefined && Object.hasOwn(FS_STATUS, code) ? FS_STATUS[code] : undefined
  return fail(status ?? 500, status === undefined ? 'file unavailable' : 'file unavailable: ' + code)
}

/**
 * Parse one `bytes=` range the way mobile media players use it.
 * @param header - raw Range header value.
 * @param size - complete file size in bytes.
 * @returns inclusive window, 'invalid' / 'unsatisfiable', or null when absent/unsupported.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return null
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return 'invalid'

  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    if (size === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return 'invalid'
    if (start >= size) return 'unsatisfiable'
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

/**
 * Stream `[start, end]` through the filesystem seam, one bounded window per pull.
 * Backpressure comes from the Response consumer; cancellation rides request.signal.
 */
function streamWindow(fs, target, start, end, signal) {
  let offset = start
  return new ReadableStream({
    async pull(controller) {
      try {
        if (signal && signal.aborted) {
          controller.close()
          return
        }
        if (offset > end) {
          controller.close()
          return
        }
        const remaining = end === Infinity ? CHUNK_BYTES : Math.min(CHUNK_BYTES, end - offset + 1)
        const bytes = await fs.readByteRange(target, { offset, length: remaining }, signal)
        if (bytes === undefined || bytes.byteLength === 0) {
          controller.close()
          return
        }
        offset += bytes.byteLength
        controller.enqueue(bytes)
      } catch (error) {
        // The browser hanging up mid-video is ordinary; only real I/O failures error the stream.
        if (signal && signal.aborted) controller.close()
        else controller.error(error)
      }
    },
  })
}

/** Media type from the path's extension; unknown binaries stay octet-stream. */
function mimeOf(file) {
  const match = String(file).split('/').pop().match(/\.([A-Za-z0-9]+)$/)
  if (match === null) return 'application/octet-stream'
  return MIME[match[1].toLowerCase()] || 'application/octet-stream'
}
