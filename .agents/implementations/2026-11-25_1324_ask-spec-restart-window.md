# 2026-11-25T13:24+08:00 — ask-spec: reopen a new review window after feedback

Fixed the reported flow break: after feedback the agent's next revision produced no window.

Root cause (matches the failure report): `/api/decide` marks the review server as closing and closes the port 1.5 s later, but the extension kept the handle. `spec_submit` then saw a non-null `server` and took the `broadcast("revision")` branch — sending into a socket that no page was listening to — and returned the old, dead URL. `/ask-spec open` had the same flaw.

Changes:
- `src/features/spec/server.ts`: the handle now exposes `active()`, false from the moment a decision is accepted and after `close()`; `close()` is idempotent so decision, `/ask-spec off` and teardown can all call it.
- `src/features/spec/index.ts`: extracted `startReviewServer()` and `ensureReviewServer()`. A live handle is reused and broadcasts the revision; a dead one is replaced by a new server that opens its own window. `/ask-spec open` restarts a closed server instead of re-opening a dead URL. A server that cannot bind now comes back as a tool message (`Cannot open the review page: …`) instead of throwing inside the tool.
- Port pool confirmed and now covered by a test: 20 ports walked upward from `portStart` (default 3401), so concurrent reviews and restarts never share an address (`portAttempts` is injectable for tests only).
- State continuity confirmed: a restart replaces only the HTTP server. Versions, annotations and decisions stay in the in-memory `SpecSession` and are persisted per submission to `<agent-dir>/ask-spec/<slug>/state.json` plus `vNNN.md`, so the history drawer and `?version=N` keep working.

Tests: new integration case denies v1, waits for the port to close, submits v2 and asserts a different URL, a second `openBrowser` call, `totalVersions: 2` and history `[2, 1]` from the new server; a second case reopens a closed review via `/ask-spec open`. I verified the first case fails against the old behaviour (same URL, no new window) before the fix. `src/features/spec/server.test.ts` gained port-walk, `active()`-after-decision and idempotent-close cases.

Note: I initially overwrote the existing `server.test.ts` instead of extending it; the restored file plus three new cases gives 17 tests.

Docs: AGENTS.md (spec section: decision-then-restart contract, state continuity, port pool), README + README.zh-CN, CHANGELOG.

Verification: `pnpm typecheck` green; `pnpm test` 54 files / 1002 tests green.
