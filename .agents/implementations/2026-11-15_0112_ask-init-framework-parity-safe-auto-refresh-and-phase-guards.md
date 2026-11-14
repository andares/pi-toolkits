# 2026-11-15T01:12+08:00 — ask-init: framework parity, safe auto-refresh, and phase guards

Implemented the P0 half of the /ask-init closed-loop review.

What changed:
- `refresh` now matches the AGENTS.md workflow markers only when they occupy a whole line, outside fenced code blocks, and form exactly one begin/end pair. Inline examples and fenced snippets are ignored; malformed or hand-written layouts are reported and never rewritten. This fixes a real corruption path in this repo's own AGENTS.md.
- Added framework parity (`src/features/init/parity.ts`): managed files are classified as current/stale/missing/hand-edited/unverifiable; the workflow block as current/stale/missing/malformed/hand-written/missing-agents; required files (AGENTS, core seeds, specs/PLAN.md) are checked. New audit codes: W-FW-02/03/04, I-FW-01, W-PATH-01.
- `/ask-init` now runs the refresh step on every invocation: audit-only runs compare/repair first and say `framework files are already current` when nothing drifted; full runs refresh after apply and before dispatch. `refresh` remains a standalone command; `refresh --adopt` explicitly takes ownership of a legacy file without a template anchor.
- Mechanical repair: layoutOk requires AGENTS, core memory seeds and specs/PLAN.md; a reconcile with no prose tasks applies creates/moves and skips the model turn (`tasks.length === 0`).
- Added a tolerant `frameworkReadiness` predicate (state.toml + AGENTS.md + memory contract + implementations dir). `/ask-uat`, `record_change` and the plan approval's record recommendation use it; small content edits do not block the loop, missing pieces are named in the refusal.
- Phase guards: ask refuses on top of plan/UAT (and while the agent is running); plan refuses while UAT is open and checks idle; review exits ask and refuses during planning; init refuses mutating runs while any phase is active.
- E-PATH-01 is an error only while a legacy directory still exists; once it is gone the same references are W-PATH-01 (nothing would break on a move).

Docs: README EN/ZH init/plan/uat/ask/review sections, complete grouped audit-code list, project structure, CHANGELOG Unreleased, package description/keywords, shipped memory contract, and internal AGENTS notes/counters.

Evidence:
- `pnpm typecheck` green.
- `pnpm test`: 53 files / 937 tests green (init 11 files / 119 tests; new parity + marker + phase + readiness tests).
- `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'` → `OK`.
- Read-only dry run on this repo: `refreshFramework(dryRun)` reports `block: "inserted"` (no prose damage) and would create `.agents/uat/README.md`; `audit` is now 0 errors, with W-FW-03 / W-PATH-01 / I-UAT-01 as expected.
- Known boundary: this repo's installed contract is from 0.11 and has no template anchor; `/ask-init` reports I-FW-01 and leaves it alone until `refresh --adopt` is run. New projects get anchors from the start.
