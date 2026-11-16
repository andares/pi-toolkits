# 2026-11-17T01:44+08:00 — ask-spec: rename the browser review and rebuild the review page

- Renamed the feature module to `src/features/spec/`. The public command is `/ask-spec`; `/ask-plan` stays registered as an alias pointing at the same handler. The submit tool is now `spec_submit`; an untitled invocation defaults to `specs/spec.md` instead of `specs/plan.md`.
- `src/lib/phases.ts` exports `SPEC_PHASE_TOOL` and also recognises the legacy `plan_submit` marker, so a session that started before the rename does not look like "no spec phase". UAT and review use the shared `specPhaseActive` helper.
- Review history moves from `<agent-dir>/ask-plan/` to `<agent-dir>/ask-spec/`; `storeRoot()` migrates the old directory on first use and falls back to it if the rename fails.
- Rebuilt the review page (`ui/src/App.tsx`, `styles.css`, `i18n.ts`): warm paper/rose palette, P052 display serif, two-column layout (spec | revision stats + clickable annotation index), status bars/badges, global-notes card visible above the blocks, and a floating decision bar. `Only changed` / `Global notes` now sit on the left of that bar and the total note count sits in the middle; the old explanatory cards and the red hint text are gone.
- Annotation-list entries jump to their block (revealing collapsed unchanged blocks first); global notes scroll to the global card. Plurals are handled for blocks/notes ("1 block changed").
- Docs: AGENTS.md feature section, README/README.zh-CN feature table and section, the init workflow template, the project workflow block, CHANGELOG Unreleased, and the feature spec renamed to `specs/ask-spec.md`.
- Design: `design/ask-spec.ptr` now matches the shipped page (global card, annotation index, footer controls, no explanatory cards); the `design/` convention is documented in AGENTS.md.

## Evidence

- `pnpm typecheck` — clean.
- `pnpm test` — 53 files / 947 tests, including spec 110; new tests cover the `/ask-plan` alias, the `specs/spec.md` default, and the legacy store migration.
- `pnpm ui:typecheck` — clean; `pnpm ui:build` updated `src/features/spec/assets/` (the `ui:check` git-clean assertion needs the assets committed).
- Real pi 1.5.2 smoke: `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'` → `OK`.
- Playwright + mock review state: two-column page, global notes card, annotation index jump targets, editor, footer layout at 1440px.
- `paintress_validate` on `design/ask-spec.ptr` — 0 errors / 0 warnings; screenshots at `C:\src\tmp\ask-spec-ui.png` and `C:\src\tmp\ask-spec-design.png`.
