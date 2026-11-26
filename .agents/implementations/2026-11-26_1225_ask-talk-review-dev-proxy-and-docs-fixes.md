# 2026-11-26T12:25+08:00 — Review fixes: dev proxies and docs follow the 7600–7699 pool

Third-party review corrections for the ask-talk / shared-port round.

Confirmed and fixed within this round's scope:
- `ui/vite.config.ts` and `ui/vite.config.uat.ts` still proxied `/api` to 3401 after the production pool moved to 7600–7699. Both now proxy to 7600, so `ui:dev` / `dev:uat` can reach a live server using the default port.
- Both READMEs still described a 20-port spec pool; they now describe the shared 7600–7699 pool. The `SpecOptions.portAttempts` comment no longer claims a default of 20.
- Restored indentation in `src/features/talk/index.ts` and `src/features/talk/server.test.ts`; no behavior change.

Review coverage checked all seven requirements (window opening, session title, shared port pool, outline visibility/scrolling, back-to-top alignment, composer blur height, host compatibility). No remaining runtime defect was confirmed in those changes. Residual risks recorded in the review response: UI geometry fixes are covered by the performed Playwright checks but not by committed browser regression tests, and an already-open talk tab does not live-update if the session is renamed without reopening/refreshing it.

Verification after the fixes: `pnpm test` (61 files / 1064 tests), `pnpm typecheck`, `pnpm ui:typecheck`, `pnpm ui:build`, and `git diff --check` all passed. The earlier full compatibility matrix remained green for 1.3.0–1.6.1.
