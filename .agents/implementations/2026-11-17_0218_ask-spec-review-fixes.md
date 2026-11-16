# 2026-11-17T02:18+08:00 — ask-spec review: fix rename compatibility and history errors

Third-party review fixes for the ask-spec rename/redesign round:

- Restored `${session.dir}` in the empty-session error and `${path}` in the non-object state error in `src/features/spec/store.ts`; both had been lost during mechanical renaming.
- `toolSetWithSubmit` / `toolSetWithoutSubmit` now remove both `spec_submit` and the legacy `plan_submit` marker, preventing stale phase state after the rename.
- `listSpecSessions` now includes both store roots when a partially migrated agent dir contains both `ask-spec/` and `ask-plan/`; it does not merge or overwrite either directory.
- Removed the inaccurate `latest revision` suffix from the history summary and synced `design/ask-spec.ptr`.
- Corrected the stale `src/features/plan/server.ts` reference in the Vite config comment.

Regression coverage added for path-bearing errors, current+legacy marker cleanup, and dual-store listing. The new tests failed before the fixes and passed after them.

Validation: `pnpm typecheck`; `pnpm test` (53 files / 950 tests); `pnpm ui:typecheck`; `pnpm ui:build`; `git diff --check`; paintress validate 0 errors / 0 warnings and screenshot reviewed. Generated minified-bundle diagnostics were reviewed as tooling false positives, not source defects.
