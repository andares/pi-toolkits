# 2026-11-12T21:08+08:00 — Permission parser: approval-log false positives 52 → 16

Rule/parser optimization driven by the local approval log (`~/.pi/agent/approval-log/audit-000001.jsonl`: 491 records, 61 asks, 2026-10-26 → 2026-11-12).

**Method**: replay every logged ask command through the current `parseCommandUnits` + `decideProgram` with the record's modes/roots and an empty grant table. Baseline: **52 of 61 would still ask**. After the fixes: **16**, all of them intentional.

**Fixes (all in `src/features/permission/units.ts`)**

1. Lone `$` at the end of a double-quoted string (`grep "</div>\s*$"`) — shell-quote calls the env proxy with an empty key; it now yields a literal `$` instead of the unresolved-variable sentinel (5 asks).
2. Quote-aware substitution extraction: a backtick inside single quotes is pattern text, not an unterminated substitution (1 ask).
3. Unquoted newlines become `;` (backslash-newline is a continuation). shell-quote treats a newline as whitespace, so `ls⏎rm -rf x` used to parse as one `ls` unit — a **missed write**, not just a false positive. This is the safety fix of the round.
4. Assignment-only segments produce no unit (they touch nothing); literal single-word assignments are remembered and substituted into later units.
5. Literal `for NAME in w1 w2 …` loops are expanded (brace- and cross-products capped at 64; unknown lists, `$(…)` values and values containing whitespace stay opaque). `for f in a b; do grep x "$f"; done` and `for d in /a /b; do git -C "$d" status; done` now resolve real paths.
6. `env` / `env FOO=1` is a read, not an opaque "wrapper runs no visible command" (5 asks).
7. grep-family first positional operand is the pattern, not a path/glob — `grep -n '<STable($|[^A-Za-z])'` no longer creates a bogus target (or an opaque path when the pattern had `$`).
8. `looksLikePath` no longer treats a bare backslash as a path separator (`\s*`, `%{http_code}\n`); absolute Windows drive/UNC paths are still recognized. Relative `dir\file` joins the documented read blind spot.
9. Declared data flags (`DATA_VALUE_OPTS`: `curl -w/-H/-d/…`) are not path operands.
10. An unresolved **input** redirect on a read command no longer fails the whole unit (same blind spot as a bare filename operand); unresolved **output** redirects still fail closed.
11. Container inspection subcommands (`docker`/`podman` `ps`, `logs`, `inspect`, `images`, `compose ps/logs/config`, …) are reads; `exec`, `run`, `rm`, `build` and unlisted ones stay writes.

**Remaining 16** (deliberate asks): `docker exec` with an unresolved path, `node -e` / `python3 -` / ssh with nested quoting, unknown output targets from `$(basename)`, `sed -i $FILES` with a substitution value, process substitution, `cd -`, `sudo`, mysql heredoc (real write SQL).

## Evidence

- `pnpm typecheck` green; `pnpm test` **50 files / 897 tests** (permission 138, including the new `approval-log regressions` block of 16 cases — one per class above).
- Replay script output: `asked in log: 61, would still ask now: 16`.
- `node scripts/publish.mjs patch --dry-run` unaffected.
