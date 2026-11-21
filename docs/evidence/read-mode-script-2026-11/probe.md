# Read-mode spoken-script truncation — measurements (2026-11-21)

The sheet screenshots are intentionally not committed: the reply that triggered
the report is a private customer session. The numbers below are from the real
model API and from a real `dsh web` host, and are enough to reproduce the
before/after difference with any long reply.

## v1.21.0 settings — `maxTokens: 1500`, model default reasoning (`high`)

Direct DeepSeek Messages API runs on the same reply that was being read when
the truncation was reported (1155 CJK characters):

| run | visible script | finish | thinking tokens |
| --- | --- | --- | --- |
| 1 | 317 chars | `max_tokens` | 1304 |
| 2 | 678 chars | `max_tokens` | 1080 |
| 3 | 413 chars | `max_tokens` | 1244 |

Every run was cut mid-sentence; 1080–1304 of the 1500-token budget was spent
on hidden reasoning, leaving only ~200–600 characters of script. The sheet
only ever showed the first one or two paragraphs.

## v1.21.1 settings — `maxTokens: 8192`, `reasoningEffort: low`

Same reply through a real `dsh web` host running the patched plugin:

| run | served bytes | finish | time |
| --- | --- | --- | --- |
| 1 | 2191 | `end_turn` | 12.4 s |
| 2 | 2128 | `end_turn` | 19.4 s |
| 3 | 2117 | `end_turn` | 15.2 s |

All three ended on a complete sentence. A retry at 16384 tokens covers the
rare run that still hits the cap; if that fails too the route returns 502 and
the client reads the complete on-screen text instead of a half script.

## Client completeness guard (Chromium, patched `web/app.js`)

Mocked `/api/pwa.tts-script` responses for a two-paragraph reply:

- `"只有第一段"` (no terminal punctuation) → client ignored it and used
  `ttsPrepare(original)` → 2 complete paragraphs were queued.
- `"完整口语稿。"` → used as-is → one paragraph, no fallback.

`node test/smoke.mjs` passes (includes `test/voice.mjs`: completeness gate,
max-token retry, unsupported-effort retry, HTTP 502 fallback, input validation).
