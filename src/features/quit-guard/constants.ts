/**
 * quit-guard feature — constants and the rationale behind them.
 *
 * WHY a terminal-sequence trigger instead of `session_shutdown`: pi runs
 * extension shutdown handlers one after another without a timeout. If a
 * handler loaded BEFORE ours never settles, our own `session_shutdown` never
 * runs, so a watchdog armed from that event would miss exactly the hangs it
 * is meant to catch. The teardown sequence below is written by the TUI
 * before that phase starts, so it arms the guard regardless of extension
 * load order (and even when the host's own writes are what hangs).
 *
 * Teardown markers (arm):
 *  - `\x1b[?2004l` — bracketed paste off, written by `ProcessTerminal.stop()`
 *    (both `regular` and `fullscreen` modes);
 *  - `\x1b[?1049l` — alternate-screen exit, written by the fullscreen
 *    renderer's `afterTerminalStop()`.
 *
 * Restart markers (disarm): a TUI that re-enters must never be killed by a
 * timer meant for a process that is leaving:
 *  - `\x1b[?2004h` — bracketed paste on, `ProcessTerminal.start()`;
 *  - `\x1b[?1049h` — alternate-screen enter, fullscreen `beforeTerminalStart()`.
 *
 * These cover the two legitimate teardown-then-restart paths: an interactive
 * TUI mode switch (`switchTuiMode()` stops the old renderer with
 * `preserveScreen`, then starts the new one) and Ctrl+Z suspend/resume
 * (`handleCtrlZ()` calls `ui.stop()`, then `ui.start()` on SIGCONT). The
 * SIGCONT listener in index.ts disarms synchronously as well, so an expired
 * timer cannot win a race against a resume.
 *
 * Scope: interactive TUI only. Print/JSON/RPC sessions never write these
 * sequences, so the guard stays inert there (documented boundary).
 */
export const QUIT_GUARD_FILE = "pi-toolkits-quit-guard.json";

/** Directory holding the JSON reports written when the guard fires. */
export const QUIT_GUARD_REPORT_DIR = "quit-guard";

/**
 * Default watchdog deadline, measured from the terminal teardown write.
 *
 * Measured on a 20-extension setup (2026-11-05): a healthy `/quit` spends
 * ~0.1–3 s between the teardown write and `process.exit(0)` (the whole
 * `runtimeHost.dispose()` / extension-shutdown phase), 5 s worst case end to
 * end, and 0.12 s with `pi -ne`. 8 s keeps ~3 s of margin over the slowest
 * healthy quit observed (enough for a memory flush or an MCP server close)
 * while returning the prompt sooner than the original 10 s when something
 * never settles. Set by the operator (2026-11-10); it is a default, not a
 * floor — `/quit-guard <ms>` still overrides it.
 */
export const DEFAULT_TIMEOUT_MS = 8_000;

/** Floor for `/quit-guard <ms>`: below this, a healthy slow quit would be cut. */
export const MIN_TIMEOUT_MS = 2_000;

/** Ceiling for `/quit-guard <ms>`: beyond this the user is better off with `kill -9`. */
export const MAX_TIMEOUT_MS = 60_000;

/** Sequences after which the interactive TUI has begun tearing down. */
export const TEARDOWN_MARKERS = ["\x1b[?2004l", "\x1b[?1049l"] as const;

/**
 * Pseudo-marker for the second, event-driven trigger.
 *
 * `shutdown({ fromSignal: true })` runs every extension's `session_shutdown`
 * handler BEFORE `ui.stop()` writes the teardown sequence (pi 1.5.1,
 * interactive-mode.js). With a handler that never settles, the marker is never
 * written and a sequence-only watchdog stays asleep: the process keeps the
 * terminal, raw mode and the frozen frame forever. `session_shutdown` with
 * reason `"quit"` is the only in-process signal available at that point, so it
 * arms the guard too. Session replacements use `"new"`/`"resume"`/`"fork"`
 * and `/reload` uses `"reload"` — those must never arm it.
 */
export const SHUTDOWN_EVENT_MARKER = "session_shutdown";

/**
 * Terminal restore written before every forced exit (writeSync(1, …), which
 * bypasses our own stdout wrapper and cannot re-arm the guard).
 *
 * The shutdown-event path needs it because nothing restored the terminal:
 * without it the prompt comes back on the alternate screen, with bracketed
 * paste on and the cursor hidden. The marker path gets it too (since
 * 2026-11-13): `ui.stop()` can also hang between its two sequences —
 * `?2004l` written, `?1049l` never — and an already-restored terminal
 * simply ignores the extra sequences. Idempotent, unlike a frozen screen.
 */
export const TERMINAL_RESTORE = "\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m\r\n";

/**
 * Grace period for the kill fallbacks that run AFTER the report is on disk
 * and "forcing exit" has been printed: `process.exit(0)` first, then, in
 * layers, a same-loop `setTimeout` SIGKILL and the independent-thread
 * SIGKILL from killer.ts (see there for why the timer alone is not enough:
 * the main thread can deadlock inside `process.exit`, where no timer runs).
 */
export const HARD_KILL_DELAY_MS = 500;

/** Sequences that mean a TUI is starting (mode switch or suspend/resume). */
export const RESTART_MARKERS = ["\x1b[?2004h", "\x1b[?1049h"] as const;
