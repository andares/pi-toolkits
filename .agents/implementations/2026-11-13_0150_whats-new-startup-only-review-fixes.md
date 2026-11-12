# 2026-11-13T01:50+08:00 — Startup-only release notes and permission safety review fixes

Removed `/whats-new` completely at the operator's request. The feature is startup-only: no `registerCommand`, no on/off toggle, no replay command. The persisted state is only `lastSeenVersion`; the unused `enabled` setting and command-only rendering helpers were removed.

`AGENTS.md` now has an explicit maintainer/agent workflow: before releasing, add English top-level `- ` bullets under `CHANGELOG.md`'s existing `## Unreleased`; do not rename the heading manually. `pnpm release` promotes it to the new version and opens a fresh Unreleased section. Empty/missing sections abort unless `--skip-changelog` is explicit.

## Confirmed review findings fixed

1. **Literal loop expansion could use the wrong binding.** A prior `f=/proj` overrode `for f in /etc`, and outer-first expansion mishandled nested loops with the same variable name. Expansion is now innermost-first, ordinary assignments are not persisted, and loop expansion stops after reassignment or a mutating builtin (`read`, `unset`, `export`, `eval`, etc.).
2. **Conditional/stale assignments were treated as executed.** `false && d=/proj; rm "$d/x"` and `d=/proj; read d; rm "$d/x"` previously resolved to `/proj/x`; both now remain opaque and ask.
3. **Nested `do for` headers were not recognized.** Leading `do` is removed before `for`/`done` handling.
4. **Unresolved input redirects bypassed strict read modes.** `cat < "$UNKNOWN"` returned allow even with `outRead=deny`. The relaxation was reverted; input and output redirects both fail closed. A policy test covers `ask` and `deny`.
5. Added a separated-form `docker compose config --output FILE` regression assertion so read-only container classification cannot hide a known output write.

## Evidence

- `pnpm typecheck` green; `pnpm test`: **50 files / 898 tests**.
- Adversarial probes now produce the actual outside target or an opaque ask for every confirmed case.
- Original approval-log replay: **61 logged asks; 21 would still ask** after these corrections (the earlier 16 relied on unsafe relaxations).
- Real pi 1.5.2, isolated agent dir: seeded 0.12.0 → notice `pi-toolkits updated 0.12.0 → 0.13.0`, state 0.13.0; second start silent. Unit regression asserts no command registration.
- `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'` → `OK`.
- `node scripts/publish.mjs patch --dry-run` → 2 notes pending for 0.13.1; `npm pack --dry-run` includes `CHANGELOG.md`.

## Pre-existing issue noted, not changed

The generic operand scanner does not split `--output=/path`: it can treat the entire token as a fake in-project path. This predates this round and affects more than the new container table; it needs a shared equals-form option parser, not a container-specific patch.
