# 2026-11-26T12:47+08:00 — ask-spec and ask-talk: confirmed manual close without replying

Added a deliberate no-reply exit to both browser review modes.

**UI**
- `ClosePageButton` in `ui/src/shared.tsx` sits immediately after the existing language switch in `SpecView` and `TalkPage`. It reuses the `ghost` button styling and native `window.confirm` for the required second step; there was no existing dialog component to reuse.
- Confirmation calls `postClose()`. Cancellation performs no request. The button is guarded against double submission.
- On success or an unreachable server, the page unsubscribes SSE so EventSource cannot reconnect forever. Talk also clears a pending notes-save debounce. The original review controls are replaced by `ManualCloseNotice`, which distinguishes "server closed" from "server unreachable" and never claims a dead server was stopped.
- `window.close()` is attempted, but externally launched tabs may refuse it; the notice is the reliable terminal fallback. The close request has a 3-second abort timeout for broken network routes.

**Server**
- Both `src/features/spec/server.ts` and `src/features/talk/server.ts` now accept authenticated, same-origin `POST /api/close` through the existing HTTP shell. The route marks the handle inactive, returns `{ok:true}`, and closes the port on the next tick so the response can flush.
- This route does not call `onDecision` or `onContinue`, does not invoke `sendUserMessage`, does not record a spec decision, and does not set talk's `sent` flag or alter its draft. Closing a spec page does not leave the spec phase; `/ask-spec open` or another `/ask-talk` can start a fresh server for the same state. It never exits the pi process.

**Coverage**
- Four new regressions: spec and talk route tests prove no decision/Continue callback and actual port shutdown; command-level tests prove no additional `sendUserMessage` and successful reopening.
- Playwright against the built assets covered both pages: dismiss confirmation → no close request; accept → closed state and `window.close()` called, mock log contains only close and no decision/Continue; server stopped before confirmation → unreachable fallback, no new request.
- `pnpm typecheck`, `pnpm ui:typecheck`, `pnpm test` (61 files / 1068 tests), `pnpm ui:build`, and `git diff --check` passed. Real pi smoke returned `OK`. No host API usage changed, so the existing green 1.3.0–1.6.1 compatibility result was not rerun.
- Updated both READMEs, AGENTS.md, CHANGELOG.md's Unreleased section, and rebuilt the committed review-page assets.
