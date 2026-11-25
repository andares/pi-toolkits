# 2026-11-25T11:37+08:00 — Bare /ask-spec toggles out of spec mode

Implemented the requested toggle for accidental spec-mode entry.

- In `src/features/spec/index.ts`, an active review plus an empty argument now calls the existing `leave()` path before the busy-agent check. It closes the review server, removes `spec_submit`, restores the previous permission policy when appropriate, and preserves the draft path in the notification.
- Explicit `/ask-spec off` and `/ask-spec open` are unchanged; a non-empty repeated topic still gets the existing “already reviewing” warning.
- The `/ask-plan` alias shares the same handler and therefore gets the same bare-command toggle.
- Added `src/features/spec/index.test.ts` coverage for active → bare command exits, permission restore/tool removal, no extra kickoff, and the next bare command starts a fresh default-topic review.
- Updated command help, both READMEs, AGENTS.md, and CHANGELOG.md.

Verification: focused spec tests 27 passed; full `pnpm typecheck` green and `pnpm test` 54 files / 997 tests green.
