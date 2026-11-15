// Voice-mode host routes: ASR transcription, spoken-script rewrite, and TTS synthesis.
//
// All three live inside Connection's auth fence (same owner cookie as /api/file,
// pattern cribbed from media.js). Keys never reach the browser:
//   DEEPSEEK_API_KEY        — DeepSeek ASR + TTS (https://api-docs.deepseek.com)
//   VOICE_TTS_VOICE         — 'stella' (default) | 'tide'
//   VOICE_SCRIPT_PROVIDER   — optional rewrite-model override, e.g. 'zai'
//   VOICE_SCRIPT_MODEL      — optional rewrite-model override, e.g. 'glm-5.3-flash'
// The rewrite stream goes through the harness LLM service (ctx.llm), so it uses
// whatever provider the profile already has configured when the overrides are unset.
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'

export const ASR_PATH = '/api/pwa.asr'
export const SCRIPT_PATH = '/api/pwa.tts-script'
export const TTS_PATH = '/api/pwa.tts'

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1/tools'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
/** Max characters of reply text fed to the rewrite model. */
const SCRIPT_INPUT_CAP = 15000
/** Rewrite output token cap. */
const SCRIPT_MAX_TOKENS = 1500

/** Register the three voice routes inside Connection's authentication fence. */
export function mountVoiceRoutes({ connection, llm }) {
  const disposers = []
  disposers.push(connection.fetch.register({ path: ASR_PATH, methods: ['POST'], requestBody: 'buffered', fetch: (request) => serveAsr(request) }))
  disposers.push(connection.fetch.register({ path: SCRIPT_PATH, methods: ['POST'], requestBody: 'buffered', fetch: (request) => serveScript(request, llm) }))
  disposers.push(connection.fetch.register({ path: TTS_PATH, methods: ['POST'], requestBody: 'buffered', fetch: (request) => serveTts(request) }))
  return async () => { for (const d of disposers) { try { await d() } catch { /* best effort */ } } }
}

/* ---------------------------------------------------------------- ASR ---- */

/* DeepSeek key resolution: env first, then the harness credential store
 * (refs.DEEPSEEK_API_KEY in ~/.dsh/.credentials.yaml — the same secret the
 * profile's apiKeyEnv references resolve to, so the key never needs a
 * separate setup step for this plugin). */
let cachedKey
let cachedKeyAt = 0
async function deepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  if (cachedKey && Date.now() - cachedKeyAt < 60000) return cachedKey
  try {
    const { readFile } = await import('node:fs/promises')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const src = await readFile(path2.join(os2.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(src)
    cachedKey = m ? m[1] : null
  } catch { cachedKey = null }
  cachedKeyAt = Date.now()
  return cachedKey
}

/** Transcribe one recorded utterance. Body: raw audio bytes (iOS m4a/AAC or WAV/Opus). */
async function serveAsr(request) {
  const key = await deepseekKey()
  if (!key) return json(503, { error: 'no-key', message: '宿主未配置 DEEPSEEK_API_KEY（语音识别需要）' })
  const buf = Buffer.from(await request.arrayBuffer())
  if (buf.byteLength === 0) return json(400, { error: 'empty-body' })
  if (buf.byteLength > 8 * 1024 * 1024) return json(413, { error: 'too-large', message: '录音超过 8 MiB 上限' })

  // DeepSeek ASR accepts 16-bit PCM WAV or Ogg Opus only. iOS MediaRecorder gives
  // audio/mp4 (AAC), so transcode through macOS afconvert; non-mac hosts fall
  // through to passthrough for already-supported formats.
  let payload = buf
  let fname = 'speech.wav'
  const head = buf.subarray(0, 4).toString('latin1')
  const isWav = head === 'RIFF'
  const isOgg = head === 'OggS'
  if (!isWav && !isOgg) {
    try {
      payload = await toWav(buf)
    } catch (e) {
      return json(400, { error: 'bad-format', message: '音频转码失败：' + String(e && e.message || e) })
    }
  } else {
    fname = isOgg ? 'speech.opus' : 'speech.wav'
  }
  if (fname === 'speech.wav') payload = toPlainPcmWav(payload)   // afconvert 会产 EXTENSIBLE(tag 65534)，DeepSeek 只认标准 PCM(tag 1)

  const form = new FormData()
  form.append('file', new Blob([payload]), fname)
  try {
    const r = await fetch(DEEPSEEK_BASE + '/asr', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key },
      body: form,
      signal: request.signal,
    })
    const out = await r.json().catch(() => null)
    if (!r.ok) return json(r.status === 429 ? 429 : 502, { error: 'asr-upstream', message: 'DeepSeek ASR ' + r.status, detail: out })
    return json(200, { text: String((out && out.text) || ''), durationMs: (out && out.duration_ms) || null })
  } catch (e) {
    if (request.signal && request.signal.aborted) return new Response(null, { status: 499 })
    return json(502, { error: 'asr-failed', message: String(e && e.message || e) })
  }
}

/** afconvert m4a/webm-ish → 16 kHz mono 16-bit WAV; resolves with the WAV bytes. */
function toWav(buf) {
  return new Promise((resolve, reject) => {
    mkdtemp(path.join(os.tmpdir(), 'dshm-voice-')).then((dir) => {
      const inPath = path.join(dir, 'in.m4a')
      const outPath = path.join(dir, 'out.wav')
      writeFile(inPath, buf).then(() => {
        const p = spawn('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inPath, outPath])
        let stderr = ''
        p.stderr.on('data', (d) => { stderr += String(d) })
        p.on('error', (e) => { rm(dir, { recursive: true, force: true }).catch(() => {}); reject(e) })
        p.on('close', (code) => {
          if (code !== 0) { rm(dir, { recursive: true, force: true }).catch(() => {}); reject(new Error(stderr.trim() || 'afconvert exit ' + code)); return }
          readFile(outPath).then((wav) => {
            rm(dir, { recursive: true, force: true }).catch(() => {})
            resolve(wav)
          }, (e) => { rm(dir, { recursive: true, force: true }).catch(() => {}); reject(e) })
        })
      }, reject)
    }, reject)
  })
}

/** Canonicalize a RIFF/WAVE buffer to a plain-PCM (format tag 1, 16-byte fmt) WAV.
 *  afconvert emits WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE) headers that DeepSeek ASR
 *  rejects; this rebuilds the minimal canonical layout from the fmt/data chunks. */
function toPlainPcmWav(buf) {
  try {
    if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') return buf
    let off = 12
    let fmt = null, data = null
    while (off + 8 <= buf.byteLength) {
      const id = buf.subarray(off, off + 4).toString('latin1')
      const size = buf.readUInt32LE(off + 4)
      if (id === 'fmt ') fmt = buf.subarray(off + 8, off + 8 + Math.min(size, 40))
      else if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break }
      off += 8 + size + (size % 2)
    }
    if (!fmt || fmt.byteLength < 16 || !data) return buf
    const tag = fmt.readUInt16LE(0)
    const channels = fmt.readUInt16LE(2)
    const sampleRate = fmt.readUInt32LE(4)
    const bits = fmt.readUInt16LE(14)
    if (tag === 1 && fmt.byteLength === 16) return buf   // 已是标准 PCM
    if (tag !== 1 && tag !== 0xFFFE && tag !== 3) return buf   // 非 PCM 家族：不动
    const blockAlign = (bits / 8) * channels
    const out = Buffer.alloc(44 + data.byteLength)
    out.write('RIFF', 0, 'latin1'); out.write('WAVE', 8, 'latin1')
    out.write('fmt ', 12, 'latin1'); out.writeUInt32LE(16, 16)
    out.writeUInt16LE(1, 20)                    // PCM
    out.writeUInt16LE(channels, 22)
    out.writeUInt32LE(sampleRate, 24)
    out.writeUInt32LE(sampleRate * blockAlign, 28)
    out.writeUInt16LE(blockAlign, 32)
    out.writeUInt16LE(bits, 34)
    out.write('data', 36, 'latin1'); out.writeUInt32LE(data.byteLength, 40)
    data.copy(out, 44)
    return out
  } catch { return buf }
}

/* ------------------------------------------------------------- rewrite ---- */

/** Rewrite one assistant reply into a speakable script, streaming plain text. */
async function serveScript(request, llm) {
  if (!llm) return json(503, { error: 'no-llm', message: '宿主没有可用的 LLM 服务（改写不可用）' })
  let body
  try { body = await request.json() } catch { return json(400, { error: 'bad-json' }) }
  const raw = String((body && body.text) || '')
  if (!raw.trim()) return json(400, { error: 'empty-text' })
  const truncated = raw.length > SCRIPT_INPUT_CAP
  const text = truncated ? raw.slice(0, SCRIPT_INPUT_CAP) : raw

  const route = await resolveScriptRoute(llm).catch(() => null)
  if (!route) return json(503, { error: 'no-model', message: '没有已注册的 LLM provider（改写不可用）' })

  const system = [
    '你是手机语音播报的口语稿编辑。用户正在走路或开车，只能听、不能看屏幕。',
    '把给你的 AI 助手书面回复改写成适合念出来的口语播报稿。要求：',
    '1) 忠实：结论、数字、步骤、风险、待办一条不能丢，也不能编造新内容。',
    '2) 口语：像聪明的朋友在耳边讲，短句为主，自然连接词（先说结论/重点是/然后/另外），轻松但不夸张。',
    '3) 结构转述：列表念出条数和序号（一共三点，第一…）；标题、表格、代码块不念原文，用一两句说清是什么、要点是什么，细节提示回屏幕上看。',
    '4) 代码与链接：代码块只讲它做什么、怎么用，不念代码；链接只说链接在屏幕上。',
    '5) 数字与缩写写成容易念的形式（百分之…、大约…；API 念 A-P-I）。',
    '6) 只输出纯文本：无 markdown 符号、无列表符号、无引号装饰、无 emoji；中文标点；按自然段落分行；长度与原文相当或更短。',
    truncated ? '原文过长已截断，请在稿子开头自然交代后面还有内容。' : '',
  ].filter(Boolean).join('\n')

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      let sent = 0
      try {
        for await (const chunk of llm.stream({
          provider: route.provider,
          model: route.model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          temperature: 0.6,
          maxTokens: SCRIPT_MAX_TOKENS,
          signal: request.signal,
        })) {
          if (chunk.type === 'text-delta' && chunk.text) {
            controller.enqueue(enc.encode(chunk.text))
            sent += chunk.text.length
          } else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
            throw new Error(chunk.reason.failure && chunk.reason.failure.message || 'llm finish error')
          }
        }
        if (sent === 0) controller.enqueue(enc.encode(text))   // 模型空输出：兜底原文，客户端照播
        controller.close()
      } catch (e) {
        // 已发出一部分就静默收尾（宁缺毋滥，客户端拿到的部分仍是完整句），否则给可见错误
        if (sent > 0) controller.close()
        else { try { controller.error(e) } catch { /* already closed */ } }
      }
    },
  })
  return new Response(stream, { status: 200, headers: { ...JSON_HEADERS, 'content-type': 'text/plain; charset=utf-8' } })
}

let scriptRouteCache = null
let scriptRouteAt = 0
/** Provider/model for the rewrite pass: env override → flash-like model → first offered. */
async function resolveScriptRoute(llm) {
  if (process.env.VOICE_SCRIPT_PROVIDER && process.env.VOICE_SCRIPT_MODEL) {
    return { provider: process.env.VOICE_SCRIPT_PROVIDER, model: process.env.VOICE_SCRIPT_MODEL }
  }
  if (scriptRouteCache && Date.now() - scriptRouteAt < 5 * 60 * 1000) return scriptRouteCache
  const providers = (llm.listProviders && llm.listProviders()) || []
  if (providers.length === 0) return null
  let picked = null
  for (const p of providers) {
    let models = []
    try { models = (await llm.listModels(p.id)) || [] } catch { /* provider without catalog: skip */ }
    const fast = models.find((m) => /flash|lite|air|mini|swift|speed/i.test(String(m.id)))
    if (fast) { picked = { provider: p.id, model: fast.id }; break }
    if (!picked && models.length) picked = { provider: p.id, model: models[0].id }
  }
  if (!picked) picked = { provider: providers[0].id, model: 'glm-5.3-flash' }   // 目录拉不到时的保守默认
  scriptRouteCache = picked
  scriptRouteAt = Date.now()
  return picked
}

/* ---------------------------------------------------------------- TTS ---- */

/** Synthesize one paragraph via DeepSeek TTS; streams audio/wav back. */
async function serveTts(request) {
  const key = await deepseekKey()
  if (!key) return json(503, { error: 'no-key', message: '宿主未配置 DEEPSEEK_API_KEY（语音合成需要）' })
  let body
  try { body = await request.json() } catch { return json(400, { error: 'bad-json' }) }
  const text = String((body && body.text) || '').trim()
  if (!text) return json(400, { error: 'empty-text' })
  const voice = body.voice === 'tide' ? 'tide' : 'stella'
  try {
    const r = await fetch(DEEPSEEK_BASE + '/tts', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voice, format: 'wav', filter_markdown: true }),
      signal: request.signal,
    })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      return json(r.status === 429 ? 429 : 502, { error: 'tts-upstream', message: 'DeepSeek TTS ' + r.status + ' ' + detail.slice(0, 200) })
    }
    return new Response(r.body, {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    })
  } catch (e) {
    if (request.signal && request.signal.aborted) return new Response(null, { status: 499 })
    return json(502, { error: 'tts-failed', message: String(e && e.message || e) })
  }
}

/* -------------------------------------------------------------- utils ---- */

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}
