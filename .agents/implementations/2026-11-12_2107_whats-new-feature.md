# 2026-11-12T21:07+08:00 — Release notes on the first start after an upgrade (/whats-new)

New `whats-new` feature (`src/features/whats-new/`) plus the release-side changelog promotion that feeds it.

- `session_start(reason="startup")` in the TUI is the only trigger. `reload`/`new`/`resume`/`fork` never replay; print/json/rpc sessions do **not** consume the notice, so the first interactive start still shows it.
- State: `<agent-dir>/pi-toolkits-whats-new.json` (`enabled`, `lastSeenVersion`). Fresh install records the version silently (nothing to compare against); only a strictly higher version announces; downgrades do not touch the record; turning notes off still records the version so re-enabling cannot replay it.
- Content: bundled `CHANGELOG.md`, filtered to `lastSeen < version <= running`, newest first, capped at 4 versions × 6 notes in the startup notice.
- Presentation: a custom session entry (`whats-new:notice`) — survives `ui.invalidate()`, stays out of the model context; falls back to `ctx.ui.notify` when the host has no entry renderer or outside the TUI.
- `/whats-new` (notes up to the running version), `/whats-new all` (every bundled release), `/whats-new off|on` (persisted).

## Release integration

`scripts/lib/changelog.mjs` + `scripts/publish.mjs`: `pnpm release` renames the `## Unreleased` heading in `CHANGELOG.md` to `## <next> — <date>` and commits it with the version bump. The gate aborts when the section is missing or has no top-level `- ` bullets, and when `package.json.files` does not include `CHANGELOG.md` (`--skip-changelog` is the explicit bypass). `--dry-run` reports the note count. The release-script helper has its own tests (`scripts/lib/changelog.test.mjs`).

## Evidence

- `pnpm typecheck` green; `pnpm test` **50 files / 897 tests** (whats-new 33 + release-helper 7).
- `node scripts/publish.mjs patch --dry-run` → `CHANGELOG.md：1 条待发布 → ## 0.13.1`.
- Real pi 1.5.2, tmux, isolated `PI_CODING_AGENT_DIR`, `-ne -e ./src/index.ts`:
  - seeded `lastSeenVersion=0.12.0` → first start renders `pi-toolkits updated 0.12.0 → 0.13.0` with the 0.13.0/0.12.3 sections; state becomes 0.13.0;
  - second start in the same dir: no notice;
  - `/whats-new` lists every bundled release up to 0.13.0; `/whats-new off` persists `enabled:false`;
  - `pi -p` with a seeded upgrade leaves the state at 0.12.0 (notice not consumed).
- `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'` → `OK`, no extension warning.
- `npm pack --dry-run` includes `CHANGELOG.md`.
- `pnpm check:compat --versions 0.99.0,1.0.0 --skip-tests` green (oldest probed hosts still typecheck with the new feature).
