<img width="1200" height="630" alt="og-image" src="assets/og-image.png" />

# dsh-pwa

English | [中文](README.zh.md)

**DeepSeek Harness in your pocket.** A phone-first PWA for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): it mounts at `/m` on your `dsh web` server — streaming chat, approvals and questions, plus a reminder center, deliverable files with share/AirDrop, full-text session search, and message feedback. No app install: open it in mobile Safari/Chrome → *Add to Home Screen* → full-screen app. iOS and Android.

[![npm version](https://img.shields.io/npm/v/dsh-pwa)](https://www.npmjs.com/package/dsh-pwa)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PWA ready](https://img.shields.io/badge/PWA-ready-brightgreen)](web/manifest.webmanifest)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

![dsh-pwa sessions and chat on a phone](assets/screenshot-sessions.png)

## Why a PWA instead of a native app?

| | **dsh-pwa** | saya-ch/dsh-mobile | Official web UI over Tailscale |
|---|---|---|---|
| Form | PWA, zero install on the phone | Native Android app + plugin | Desktop-first web UI |
| iOS | ✅ (Safari → Add to Home Screen) | ❌ (Android only) | ✅ (browser) |
| Android | ✅ | ✅ | ✅ |
| Remote access | Inherits `dsh web` (LAN / Tailscale / any reverse proxy) | Built-in: LAN, Tailscale Funnel, cpolar, cloudflared, FRP | Manual `tailscale serve` |
| Push notifications | ❌ (iOS PWA limits) | ✅ (Android system notifications) | ❌ |
| Security model | Same origin + dsh `trusted-host` fence | Cert pinning + device pairing | `trusted-host` fence |
| Maintenance surface | Static files only — speaks the same `/api` as the desktop GUI | Native app + plugin to maintain | None (official UI) |

If you want Android system notifications and certificate-pinned device pairing, check out [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile). If you want the lightest thing that works on **both** iOS and Android with nothing to install on the phone, you're in the right place.

## Features

- 🎛 **Three-mode switcher (Text | Read | Voice)**: a small icon + current-mode capsule in the chat header opens a three-way picker — it sits quietly in one button slot instead of stretching a segmented control across the bar. **Read mode** = keyboard input, auto-spoken replies: the screen keeps the original markup while the audio follows an LLM-rewritten spoken script (lists become ordinals, tables become key-points, code is described, numbers are written the way they are said). The floating player has just play/pause, rate and stop; when it finishes it stays as "播报完成" with ▶ to replay, and "View script" in the ⋯ menu compares the on-screen text with what was actually spoken. **Voice mode (walkie-talkie)** = hold to talk, release to send, swipe up to cancel, hold to barge in, tap to pause. Both modes share one playback pipeline (rewrite → parallel cloud synthesis → gapless playback with pitch-preserving rate changes; falls back to the system voice without a key). Voice mode also keeps **full-screen state colors**: recording red / transcribing purple / thinking amber / speaking blue. The capture pipeline fights wind noise (100 Hz high-pass + automatic level normalization), a visible 2-minute cap auto-sends, and an ASR failure keeps the audio — tap to retry. Connection drops never replay the previous reply: history re-sync only redraws the timeline, it does not restart speech.
- 📋 **Session list** with last-message previews, unread dots, day grouping, workspace grouping, pull-to-refresh, a "needs attention" filter (pending approvals / questions), and a per-card ⋯ menu for pin / unpin, rename (inline in the card, no second sheet) / fork / archive
- 👀 **Hold-to-preview sessions**: hold a session card for 0.38 s to expand it into a near-full-screen preview of the latest messages; keep holding and swipe up to open or down to close, or release in the middle to cancel. A tap still opens the session directly.
- 👥 **Agent Teams & sub-sessions**: a team signal on the Lead's session card, an in-chat team band that opens a read-only roster + task board (with write-scope overlap hints), and member child sessions with lineage, real mode chips (continuable / one-shot) and teammate relay bubbles — no new home tab; one-shot children and continuable children whose direct parent is offline stay read-only
- 🗂 **Session info menu**: the ⋯ sheet shows the session title, Session ID and working path (tap either to copy), with settings grouped into chat / content / manage sections
- 🔎 **Global search**: local title/path filtering plus a phone-side content index with literal substring recall (CJK included — `旺佳旺` finds `海口万达旺佳旺超市`), highlighted snippets that jump straight to the session, and progressive results while the index builds
- 💬 **Streaming chat**: optimistic send, per-day dividers, timestamps, code-copy buttons, full-screen image viewer; dual send modes — queue while running, long-press to steer — and queued messages can be edited / steered / removed; while the agent is replying and the composer is empty the send button drops to its disabled state, and typing / attaching an image / adding a quote lights it up again; the composer clears on send, even when an IME commit echoes the text back; the composer can expand into a full-width, near-full-screen editor with the collapse key at the top
- ✅ Approvals & ❓ agent questions as tappable cards (dangerous commands get a red double-confirm)
- 📦 **Deliverables & workspace files**: files the agent `present`s become timeline cards (inline image and video preview, direct text read) with share/AirDrop and open-on-Mac actions; the ⋯ menu browses the whole session workspace with per-turn change hints
- ⏰ **Reminder center**: a third home tab lists every reminder your agents created — humanized schedules, next-fire countdowns, delivery history; delete in place or jump back to the origin session to reschedule
- 👍👎 **Message feedback**: thumbs up/down on any assistant message (tap again to retract), synced live with the desktop feedback store
- 🧠 **Context transparency**: per-turn stats (duration / TTFT / decode speed / tokens), a reasoning drawer, read-aloud/spoken replies (rewritten script), and **compaction markers** — when older context is condensed into a summary, the timeline says so and shows the summary
- 🎯 **Goal management**: banner + action panel (pause / resume / edit / delete) with timeline markers
- 🖼️ Send images from camera / photo library / clipboard paste (auto-compressed to the model's limits)
- 🔐 **In-app re-login**: when auth expires, paste the `dsh web` startup link (or bare token) to mint a fresh login inside the app — no reinstall needed despite iOS home-screen apps having an isolated cookie jar from Safari
- ➕ New sessions with agent-preset picker
- 📳 Haptics, dark/light themes, draft autosave per session, connection-status pill with manual reconnect
- ⚙️ Desktop GUI gets a *Settings → 手机端* entry showing the phone URL + copy button (no typing URLs on a phone keyboard)

The full UX audit trail lives in [docs/AUDIT.md](docs/AUDIT.md) — 157 items, all fixed, each with the root cause.

## Quick start

Prerequisite: desktop `dsh` CLI installed.

**1.** Create (or reuse) a web profile, `~/.dsh/profiles/web/package.json`:

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-pwa": "latest"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-pwa"
      ]
    }
  }
}
```


**2.** Install and start (add your access domain to the trust fence when the phone connects from outside):

```bash
cd ~/.dsh/profiles/web && npm install
dsh --profile web --host 0.0.0.0 --port 3080 --trusted-host <your-access-domain>
```

**3.** On your phone, open `http://<host>:3080/m/` → *Share → Add to Home Screen* for the full-screen PWA.
   - Same LAN/Wi-Fi: `<host>` is the server's LAN IP.
   - Away from home: use [Tailscale](https://tailscale.com) — add your Tailscale hostname to `--trusted-host` in step 2 (Tailscale must be running on both the server and the phone, logged into the same account), then open `http://<tailscale-hostname>:3080/m/`.

Upgrade later with `npm update dsh-pwa` and a `dsh web` restart. The plugin mounts the static surface plus one authenticated streaming route for large deliverable files; the page speaks DSH's own `/api`, so it moves with your DSH version (developer-preview caveat in the FAQ below).

> **Voice mode prerequisite**: speech recognition and synthesis use DeepSeek's `tools/asr` / `tools/tts`. The host resolves `DEEPSEEK_API_KEY` from the environment or the DSH credential store (`~/.dsh/.credentials.yaml`) — set it once and the `/api/pwa.asr|tts` routes authenticate for you; nothing to configure on the phone. The spoken-script rewrite uses whichever model your harness routes the task to.

> **Global search index**: the phone keeps its own literal content index, seeded from session history on first use and then refreshed only for changed Sessions, so it does not need the host's `session-query-sqlite` full-text index (`openAt` may stay `never`). This is deliberate: the shipped host backend's FTS5 `unicode61` tokenizer cannot recall CJK substrings, and its cold build fails while any session is still writing. The cache lives at `~/.dsh/cache/dsh-pwa-search.json`; delete it to force a rebuild. Message text only (user/assistant); tool output is not indexed, and internal agent/ticket workspaces under `~/.dsh/state` are skipped because they churn while a task runs.

## How it works

- The server does exactly one thing: mount `web/` as static files at `/m` (`lib/routes.js`, self-healing if the webServer instance is recreated).
- The page talks directly to DSH's own `/api` — the identical protocol the desktop GUI uses (`POST /api/<ns>/<method>`, `POST /api/respond`, `ws://…/api/events.mux` downstream frames). Zero business-logic duplication.
- Tailscale works out of the box because it reuses the existing `trusted-host` fence.
- Connection diagnostics: the page batches transport metadata (WebSocket close code/reason, lifetime, visibility, network type, reconnect count) to `/api/pwa.diag`; the plugin appends NDJSON to `$DSH_HOME/state/dsh-pwa-diag.ndjson` and records `/api/remote.mux` upgrades/closes. Transport metadata only — no message text. Delete the file to clear it.

Iterating on the UI needs no restart: files are re-read per request, just refresh the page.

## Screenshots

| Sessions | Chat |
|---|---|
| ![session list](assets/screenshot-sessions.png) | ![chat](assets/screenshot-chat.png) |

| Voice mode: mode capsule + hold-to-talk | State colors: record / transcribe / think / speak |
|---|---|
| ![voice mode switch](assets/screenshot-voice-switch.png) | ![voice state colors](assets/screenshot-voice-states.png) |

## Roadmap

Contributor-friendly next steps (from [docs/AUDIT.md](docs/AUDIT.md) §"still needs protocol/server support"):

- [x] Cancel / edit queued messages (`session/updateQueue`)
- [x] Mobile session management: rename / fork / archive
- [ ] Last-message preview + unread counts in `session/list`
- [ ] Web Push: system notifications for approvals & questions while in background (the https prerequisite is now met via `tailscale serve`)
- [ ] Service-worker offline shell

Full list: [docs/ROADMAP.md](docs/ROADMAP.md). Grab one, open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Vanilla JS, no build step, no framework. `web/` is the app, `lib/` is the mount, `client/` injects the desktop settings entry. Details in [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — especially the roadmap items above.

## FAQ

**Does it work on iPhone?** Yes — that's the point. Safari → Share → Add to Home Screen.

**Do I install anything on the phone?** No. It's a web page.

**Is it safe to expose?** Same threat model as `dsh web` itself: anyone who can reach the URL (your tailnet / LAN) can drive your agent. Keep it inside a trusted network; don't put it on the public internet.

**Does it work offline?** No — it needs a live connection to your `dsh` server.

**What happens when auth expires?** The page shows a "re-login" dialog: paste the startup link `dsh web` printed on your Mac (or the bare token) and the app mints a fresh login in place — no reinstall required.

**Will a DSH update break it?** The page speaks the same `/api` as the desktop GUI and ships no protocol logic of its own, so it moves with your DSH version. That said, DSH is still in developer preview and its API may change in breaking ways — if that happens, the plugin will need a matching update.

## License

MIT — see [LICENSE](LICENSE).
