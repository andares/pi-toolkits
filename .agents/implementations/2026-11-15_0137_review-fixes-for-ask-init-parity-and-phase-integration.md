# 2026-11-15T01:37+08:00 — Review fixes for ask-init parity and phase integration

Third-party review of the ask-init parity/phase-guard round, limited to the current uncommitted diff.

Confirmed and fixed:
1. `refreshFramework` used the same "no template anchor" skip reason for both genuinely hand-edited files and legacy files without anchors. The reason now depends on whether an anchor exists; regression assertion added in `refresh.test.ts`.
2. `frameworkReadiness` used existsSync for every path, so an AGENTS.md directory or an implementations file could be judged ready. It now requires regular files for state/AGENTS/contract and a real directory for implementations; `missingRequired` uses the same regular-file check. Regression test added in `parity.test.ts`.
3. `/ask-init refresh --dry-run` emitted a /reload reminder despite writing nothing. The reminder is now suppressed for dry runs; command test added.
4. A direct refresh with missing AGENTS.md could report framework text as current. `describeRefresh` now reports the missing file and points to full `/ask-init`; the command marks it as a warning. Regression test added.
5. Added missing behavioral coverage for review exiting ask mode and plan refusing to start while the agent is busy.
6. Plan readiness used the worktree cwd while record_change/UAT resolve the main checkout. Both plan checks now use `resolveProjectRoot`, with a real git linked-worktree regression test.
7. Corrected README wording that implied a no-op audit writes nothing at all (it still writes its runtime report), and clarified the init no-UI/migration comment.

Evidence: pnpm typecheck green; pnpm test 53 files / 943 tests green; pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK' returned OK; git diff --check clean.

Not changed: refresh remains sequential and state is written last (no refresh snapshot/atomic transaction); this is the already-deferred P1 hardening item. The full host compatibility matrix was not rerun in this review; only the real installed-host smoke was repeated.
