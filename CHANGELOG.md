# Changelog

Notable, user-visible changes to `@andares/pi-toolkits`. After an upgrade, the
first interactive `pi` start shows the sections between the version you last ran
and the one just installed, once. This file keeps the full history.

Before releasing, add top-level `- ` bullets under `## Unreleased`. `pnpm release`
renames that heading to the version being published and refuses an empty section
(`--skip-changelog` bypasses the gate).

## Unreleased

- **whats-new** — the first interactive `pi` start after an upgrade shows what changed since the version you last ran, once, without registering a slash command.
- **permission** — fewer false-positive prompts for quoted grep patterns, literal shell loops, `env`, `curl` data flags and read-only container inspection; multi-line commands are now split correctly.

## 0.13.0 — 2026-11-12

- `/ask-plan` — plan first, review in the browser, then implement: research the task, write a spec, annotate it paragraph by paragraph in a local page, and only get permission to code after approval.
- `/ask-uat` and the `record_change` tool — change records are clustered into user-facing acceptance items and ticked off on a local page, so "shipped but not verified" is visible instead of implied.
- `/ask-init refresh` — refresh the framework-owned files of an already-adopted project in place (idempotent, safe).
- Releases are published by GitHub Actions with npm trusted publishing and carry a provenance attestation.

## 0.12.3 — 2026-11-10

- quit-guard also arms on a quit event, so a signal-triggered shutdown that hangs before the TUI teardown is still forced out — with the terminal restored first.
- The watchdog deadline defaults to 8 s (was 10 s); `/quit-guard <ms>` still overrides it.

## 0.12.0 — 2026-11-06

- `/quit-guard` — force-exit a hung interactive shutdown and give the shell prompt back; a JSON hang report is written first when the deadline passes.
- Every runtime-facing string is in English.

## 0.11.0 — 2026-10-26

- `/ask-init` — install or adopt the agent memory framework (`AGENTS.md`, `specs/`, `.agents/`) with a snapshot, a coverage table, and a later drift audit.

## 0.10.0 — 2026-10-24

- permission — a capped rolling JSONL approval log records each ask, its parsed units and your answer; `pnpm approval-report` turns it into rule candidates.
