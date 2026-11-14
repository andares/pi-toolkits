# Changelog

Notable, user-visible changes to `@andares/pi-toolkits`. After an upgrade, the
first interactive `pi` start shows the sections between the version you last ran
and the one just installed, once. This file keeps the full history.

Before releasing, add top-level `- ` bullets under `## Unreleased`. `pnpm release`
renames that heading to the version being published and refuses an empty section
(`--skip-changelog` bypasses the gate).
## Unreleased

- **quit-guard** — a forced exit can no longer be defeated by a deadlock inside `process.exit` itself: after the report is written, a same-loop SIGKILL timer and then an independent worker thread guarantee the process ends (real hang observed 2026-11-13, process stuck 18 min with the pty already deleted).
- **quit-guard** — a new arm-time watchdog thread covers shutdown deadlocks that kill the main event loop *before* the fire deadline: the main loop beats a 1 Hz heartbeat, and a worker that sees it stop restores the terminal, writes a `quit-hang-*-thread.json` report and SIGKILLs; healthy quits, TUI restarts and Ctrl+Z resume are unaffected.
- **ask-init** — re-running it now compares the project's framework text with the installed version, repairs missing or stale framework-owned files when safe, and says explicitly when nothing needs changing; hand-edited files stay untouched.
- **ask-init** — the workflow marker matcher no longer mistakes inline examples or fenced snippets for the managed block; ambiguous marker pairs are reported and left untouched.
- **ask-init** — `refresh --adopt` takes ownership of framework files written by an older tool without a template anchor, after you review them; a normal refresh still leaves them alone.
- **ask** — phase guards: ask refuses to start on top of a plan review or the UAT page, a review exits ask mode and refuses while a plan is under review, and `/ask-init` refuses mutating runs while another phase owns the tree.
- **init** — the audit now distinguishes a stale framework file from a hand edit, reports a missing workflow block, and treats bare legacy paths as a warning once the legacy directories are gone.

<!-- Notes for the next release go here; `pnpm release` renames this heading. -->

## 0.14.0 — 2026-11-13

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

