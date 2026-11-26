# Changelog

Notable, user-visible changes to `@andares/pi-toolkits`. After an upgrade, the
first interactive `pi` start shows the sections between the version you last ran
and the one just installed, once. This file keeps the full history.

Before releasing, add top-level `- ` bullets under `## Unreleased`. `pnpm release`
renames that heading to the version being published and refuses an empty section
(`--skip-changelog` bypasses the gate).
## Unreleased

<!-- Notes for the next release go here; `pnpm release` renames this heading. -->

- **release** — `pnpm release` now validates every release material before it runs a single gate: uncommitted work, an empty `## Unreleased`, a `package.json` without `CHANGELOG.md`, or a tag that already exists for the target version each stop it in seconds with a list of what to fix, instead of surfacing after the two-minute test run.
- **changelog** — released sections no longer keep the "notes for the next release go here" comment that used to be promoted along with them.

## 1.2.3 — 2026-11-26

- **spec/talk** — the contents panel keeps every heading row at its full height (a document with ~19 headings no longer squashes the rows into each other) and scrolls to the section you are reading when it opens.
- **talk** — when a new reply replaces the snapshot, a draft still waiting to be saved belongs to the old reply and is dropped, so it no longer lands in the new one.
- **release** — `pnpm release` reports a failed remote-tag probe as unknown with recovery steps instead of calling the tag missing, and every child process it spawns directly now has a deadline.

## 1.2.2 — 2026-11-26

- **release** — `pnpm release` now treats a green `publish` workflow run as the release's success criterion and stops there: no more polling npm for the version and its attestation, just a summary with the tag, the run URL, the Release URL and a package-page link. Every child process it spawns has a deadline (ssh included), so the wait can no longer sit silently on a dead connection.
- **quit-guard** — removed: `/quit-guard`, its settings file and the hang reports are gone. Force-exiting a hung shutdown never fixed the hang and hid the real cause, so pi is left to hang instead.

## 1.2.1 — 2026-11-26

- **spec/talk** — both pages have a confirmed **Close** action that stops the review server without sending a decision or a reply, including a closed-state fallback when the server is already gone.

## 1.2.0 — 2026-11-26

- **talk** — `/ask-talk` opens the agent's last reply in the review page: one note per block plus a composer, and `Continue` sends just the notes and your message back — the reply itself is not re-quoted.
- **spec** — the review page gets a contents strip at the reading column's edge: point at it to open a heading index, click a heading to jump; it follows the section you are reading.
- **spec** — a `Back to top` button appears once the right-hand column has scrolled out of view, and stays above the footer.

## 1.1.0 — 2026-11-25

- **spec** — running `/ask-spec` without arguments while a spec review is active now leaves the phase; `/ask-spec off` still works.
- **spec** — after feedback, the next submitted revision starts a new review server and opens a new window instead of printing a dead URL; reopening a closed review restarts it, and the revision history is preserved.
- **keep** — `/keep-quit` marks the current session unfinished and quits in one step; `/keep-load` lists that backlog, already-loaded rows dimmed but still selectable, and `/keep-drop` (or `ctrl+r` in the list) removes one.
- **keep** — the next interactive start reports how many kept sessions are still unloaded (`2 not loaded · /keep-load`).
- **keep** — a loaded session begins with the note you left at quit time, delivered as a message the model can read without triggering a turn.
- **keep** — the backlog is an append-only ledger: two pi processes can write at once, and a `load` left behind by a killed process is repaired on the next read.

## 1.0.2 — 2026-11-24

- **host compatibility** — verified against every published pi release from 0.99.0 through 1.6.0 (window 1.3–1.6); the declared range stays `pi >= 0.99.0` with no upper bound, and the package loads cleanly on 1.6.0.

## 1.0.1 — 2026-11-17

- **ask-spec** — the browser review command is now `/ask-spec` (`/ask-plan` still works as an alias), the submit tool is `spec_submit`, and an untitled review defaults to `specs/spec.md` instead of `specs/plan.md`.
- **spec review page** — a new two-column page: warm paper/rose palette, the spec on the left, revision stats and a clickable annotation index on the right; global notes stay visible above the blocks.
- **spec review page** — the decision bar now carries *Only changed* and *Global notes* on the left and the total note count in the middle, with the explanatory footer text removed.
- **ask-spec** — existing `<agent-dir>/ask-plan/` review histories are migrated to `<agent-dir>/ask-spec/` on first use.

## 1.0.0 — 2026-11-15

- **quit-guard** — a forced exit can no longer be defeated by a deadlock inside `process.exit` itself: after the report is written, a same-loop SIGKILL timer and then an independent worker thread guarantee the process ends (real hang observed 2026-11-13, process stuck 18 min with the pty already deleted).
- **quit-guard** — a new arm-time watchdog thread covers shutdown deadlocks that kill the main event loop *before* the fire deadline: the main loop beats a 1 Hz heartbeat, and a worker that sees it stop restores the terminal, writes a `quit-hang-*-thread.json` report and SIGKILLs; healthy quits, TUI restarts and Ctrl+Z resume are unaffected.
- **ask-init** — re-running it now compares the project's framework text with the installed version, repairs missing or stale framework-owned files when safe, and says explicitly when nothing needs changing; hand-edited files stay untouched.
- **ask-init** — the workflow marker matcher no longer mistakes inline examples or fenced snippets for the managed block; ambiguous marker pairs are reported and left untouched.
- **ask-init** — `refresh --adopt` takes ownership of framework files written by an older tool without a template anchor, after you review them; a normal refresh still leaves them alone.
- **ask** — phase guards: ask refuses to start on top of a plan review or the UAT page, a review exits ask mode and refuses while a plan is under review, and `/ask-init` refuses mutating runs while another phase owns the tree.
- **init** — the audit now distinguishes a stale framework file from a hand edit, reports a missing workflow block, and treats bare legacy paths as a warning once the legacy directories are gone.

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

