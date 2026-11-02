# Roadmap

Good first issues live here. Everything below is grounded in real usage and the audit trail in [AUDIT.md](AUDIT.md) ("still needs protocol/server support" section). Items are ordered roughly by value/effort.

## P0 — high value, self-contained

1. **Cold-session previews + unread counts.** The PWA now renders the last-message preview from the host's `turnOutline` projection when present, groups the time view by day, and shows unread dots. Sessions without a live projection still fall back to their workspace name, and unread is still a dot rather than a count. Needs a cached preview (or a cheap per-row tail read) for those cold sessions.
2. **Session management on mobile.** Long-press a session card → sheet with Archive / Rename / Delete. Needs the host to expose these mutations to the mobile surface.
3. **Cancel / edit queued messages.** The queue chip shows what's waiting; users can't take anything back. Cancel is the 80% case, edit is the stretch.

## P1 — bigger lifts

4. **Web Push for approvals & questions.** The killer mobile feature: approve a `rm -rf` from the lock screen. Needs: push subscription plumbing on the server side + a visible-notification UX that never leaks prompt content on the lock screen (redacted text like the Android-app approach).
5. **Service-worker offline shell.** Currently blocked on https — the main access path is `http://<tailscale>:<port>` (non-secure context, SW can't register). Worth doing once https is in place; until then, don't bother.

## How to claim one

Comment on (or open) the tracking issue, then PR against `main`. Small, reviewable diffs beat rewrites — see [CONTRIBUTING.md](../CONTRIBUTING.md).
