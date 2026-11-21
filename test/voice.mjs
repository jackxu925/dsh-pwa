// Unit tests for the spoken-script rewrite gate.
// Run: node test/voice.mjs   (CI runs this via test/smoke.mjs)
//
// v1.21.1 regression: the rewrite model ran with high reasoning effort and a
// 1500-token cap, so read mode sometimes received a script cut off mid-sentence
// (only the first paragraph was spoken). The route now caps reasoning, detects
// an incomplete script (max-tokens / mid-sentence) and fails loudly so the
// client can fall back to the complete on-screen text.
import assert from 'node:assert/strict'
import { SCRIPT_PATH, isCompleteScript, mountVoiceRoutes, rewriteScript } from '../lib/voice.js'

/* ------------------------------------------------------------- helpers ---- */

function chunks(text, finish) {
  return (async function* () {
    if (text) yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: finish || { kind: 'stop' } }
  })()
}

function fakeLlm(replies) {
  const calls = []
  const models = () => [{ id: 'deepseek-flash' }]
  return {
    calls,
    listProviders: () => [{ id: 'deepseek-official' }],
    listModels: async () => models(),
    stream(options) {
      calls.push(options)
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
      if (reply instanceof Error) throw reply
      if (typeof reply === 'function') return reply()
      return chunks(reply.text, reply.finish)
    },
  }
}

function captureRoutes(llm) {
  const routes = new Map()
  const connection = {
    fetch: {
      register({ path, fetch }) { routes.set(path, fetch); return () => routes.delete(path) },
    },
  }
  const dispose = mountVoiceRoutes({ connection, llm })
  return { routes, dispose }
}

function scriptRequest(text) {
  return new Request('http://localhost' + SCRIPT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

/* -------------------------------------------------------------- checks ---- */

// A script is complete only on terminal punctuation and a clean finish.
assert.equal(isCompleteScript('实测完了。', { kind: 'stop' }), true)
assert.equal(isCompleteScript('实测完了。', null), true)
assert.equal(isCompleteScript('他说：“可以。”', null), true)
assert.equal(isCompleteScript('实测完了', { kind: 'stop' }), false)
assert.equal(isCompleteScript('实测完了。', { kind: 'max-tokens' }), false)
assert.equal(isCompleteScript('实测完了。', { kind: 'aborted' }), false)
assert.equal(isCompleteScript('', null), false)
assert.equal(isCompleteScript('   ', { kind: 'stop' }), false)

// Happy path: collect the whole script, cap reasoning, leave room for output.
{
  const llm = fakeLlm([{ text: '完整口语稿。' }])
  const out = await rewriteScript(llm, { provider: 'deepseek-official', model: 'deepseek-flash' }, 'system', '原文')
  assert.equal(out, '完整口语稿。')
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.ok(llm.calls[0].maxTokens > 1500, 'the output budget must not fit only a first paragraph')
}

// A truncated first attempt is retried with a bigger budget, not returned.
{
  const llm = fakeLlm([
    { text: '这是第一段被', finish: { kind: 'max-tokens' } },
    { text: '这是第一段被截断，但这次写完了。' },
  ])
  const out = await rewriteScript(llm, { provider: 'deepseek-official', model: 'deepseek-flash' }, 'system', '原文')
  assert.equal(out, '这是第一段被截断，但这次写完了。')
  assert.equal(llm.calls.length, 2)
  assert.ok(llm.calls[1].maxTokens > llm.calls[0].maxTokens)
}

// A mid-sentence stop without the max-tokens reason is still incomplete.
{
  const llm = fakeLlm([
    { text: '第一段还没说完' },
    { text: '第一段现在说完了。' },
  ])
  const out = await rewriteScript(llm, { provider: 'deepseek-official', model: 'deepseek-flash' }, 'system', '原文')
  assert.equal(out, '第一段现在说完了。')
}

// An adapter without the reasoning seam is retried without the effort level.
{
  const unsupported = Object.assign(new Error('model does not support reasoning effort "low"'), { code: 'UNSUPPORTED_REASONING_EFFORT' })
  const llm = fakeLlm([unsupported, { text: '没有推理参数的适配器也能改写。' }])
  const out = await rewriteScript(llm, { provider: 'zai', model: 'glm-5.3' }, 'system', '原文')
  assert.equal(out, '没有推理参数的适配器也能改写。')
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.equal(llm.calls[1].reasoningEffort, undefined)
}

// The same refusal can arrive in-band as a terminal error finish.
{
  const refusal = { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'does not support reasoning effort "low"' } }
  const llm = fakeLlm([{ text: '', finish: refusal }, { text: '带内报错也会去掉推理参数重试。' }])
  const out = await rewriteScript(llm, { provider: 'zai', model: 'glm-5.3' }, 'system', '原文')
  assert.equal(out, '带内报错也会去掉推理参数重试。')
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[1].reasoningEffort, undefined)
}

// Never returns a partial script: the HTTP route says 502 and the client falls
// back to reading the full on-screen text.
{
  const llm = fakeLlm([{ text: '只有第一段', finish: { kind: 'max-tokens' } }])
  const { routes, dispose } = captureRoutes(llm)
  const res = await routes.get(SCRIPT_PATH)(scriptRequest('完整原文'))
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error, 'script-incomplete')
  dispose()
}

// A complete rewrite is served as plain text.
{
  const llm = fakeLlm([{ text: '第一段说完了。第二段也说完了。' }])
  const { routes, dispose } = captureRoutes(llm)
  const res = await routes.get(SCRIPT_PATH)(scriptRequest('完整原文'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(await res.text(), '第一段说完了。第二段也说完了。')
  dispose()
}

// Input validation stays intact.
{
  const llm = fakeLlm([{ text: '不会用到。' }])
  const { routes, dispose } = captureRoutes(llm)
  const route = routes.get(SCRIPT_PATH)
  assert.equal((await route(scriptRequest('   '))).status, 400)
  const bad = await route(new Request('http://localhost' + SCRIPT_PATH, { method: 'POST', body: '{' }))
  assert.equal(bad.status, 400)
  const noLlm = captureRoutes(null)
  const noLlmRes = await noLlm.routes.get(SCRIPT_PATH)(scriptRequest('原文'))
  assert.equal(noLlmRes.status, 503)
  noLlm.dispose()
  dispose()
}

console.log('voice: OK (script completeness gate, retries, HTTP fallback)')
