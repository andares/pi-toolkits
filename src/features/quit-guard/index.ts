/**
 * quit-guard feature — quit watchdog (`/quit-guard`).
 *
 * Problem this solves: pi's interactive `/quit` stops the TUI, then awaits
 * `runtimeHost.dispose()` — every extension's `session_shutdown` handler,
 * one after another, with no timeout (upstream issue #9997; still unbounded
 * in 1.5.1 and on main — 1.5.1 added `await session.abort()` before the
 * handler loop and `await settleCredentialWrites()` after it, i.e. more awaits
 * in the same untimed chain, which makes the failure mode more likely, not
 * less). One handler that never settles leaves the process
 * alive at 0% CPU, the terminal already restored and the final frame
 * reprinted: the screen looks like a frozen "exit screen" and the shell
 * prompt never comes back. The `isShuttingDown` latch in the host then
 * swallows Ctrl+C / SIGTERM / SIGHUP, so only `kill -9` helps.
 *
 * The guard watches the terminal instead of the event stream, because the
 * event stream is exactly what can hang (a handler loaded before ours never
 * returns, so our own `session_shutdown` never runs). It arms when the TUI
 * writes its teardown sequence, and disarms if the TUI comes back (mode
 * switch, Ctrl+Z suspend/resume). If the deadline passes while pi is still
 * alive, it writes a JSON hang report and forces `process.exit(0)`.
 *
 * Wiring:
 *  - one global `process.stdout.write` wrapper per process (survives
 *    `/reload`; the shared state object is the source of truth, so a reload
 *    only refreshes config/settings, never double-wraps);
 *  - one `SIGCONT` listener: a resume must never be mistaken for a quit;
 *  - `/quit-guard` — status / `on` / `off` / `<timeoutMs>`, persisted to
 *    `<agent-dir>/pi-toolkits-quit-guard.json`.
 *
 * Settings file (all fields optional, defaults shown):
 *   { "enabled": true, "timeoutMs": 10000, "report": true }
 */
import { appendFileSync, existsSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	QUIT_GUARD_FILE,
	QUIT_GUARD_REPORT_DIR,
} from "./constants.js";
import { QuitGuard, type GuardFireInfo } from "./guard.js";
import {
	collectHangReport,
	formatHangReportSummary,
	writeHangReport,
} from "./report.js";
import {
	QuitGuardStore,
	normalizeTimeoutMs,
	type QuitGuardConfig,
} from "./store.js";

/** Process-wide key; `/reload` re-imports the module but keeps this state. */
const STATE_KEY = Symbol.for("@andares/pi-toolkits/quit-guard/state");

interface QuitGuardState {
	store: QuitGuardStore;
	guard: QuitGuard;
	config: QuitGuardConfig;
	reportDir: string;
	installed: boolean;
}

function sharedState(): QuitGuardState | undefined {
	// SAFETY: `globalThis` is an untyped property bag; the symbol key is the
	// private contract and this module is the only writer.
	return (
		globalThis as unknown as Record<symbol, QuitGuardState | undefined>
	)[STATE_KEY];
}

function storeSharedState(state: QuitGuardState): void {
	// SAFETY: same contract as `sharedState`; the value shape is checked by this
	// module, not by the property bag.
	(
		globalThis as unknown as Record<symbol, QuitGuardState | undefined>
	)[STATE_KEY] = state;
}

function fire(state: QuitGuardState, info: GuardFireInfo): void {
	const timeoutMs = state.guard.getTimeoutMs();
	const elapsedMs = Math.round(info.elapsedMs);
	let reportPath: string | undefined;
	let summary: string | undefined;
	if (state.config.report) {
		// Diagnostics only: a throwing report (deleted cwd, unreadable home, ...)
		// must never keep the user from getting the prompt back.
		try {
			const report = collectHangReport({
				timeoutMs,
				elapsedMs,
				marker: info.marker,
			});
			summary = formatHangReportSummary(report);
			reportPath = writeHangReport(state.reportDir, report);
		} catch {
			summary = undefined;
			reportPath = undefined;
		}
	}
	const line = summary
		? `[pi-toolkits/quit-guard] ${summary}${reportPath ? ` — report: ${reportPath}` : ""}; forcing exit.`
		: `[pi-toolkits/quit-guard] no exit ${elapsedMs}ms after the TUI teardown started (limit ${timeoutMs}ms); forcing exit.`;
	// stderr write is synchronous on POSIX; on failure the exit still happens.
	try {
		writeSync(2, `\n${line}\n`);
	} catch {
		// The terminal is gone or blocked; the report (if any) still exists.
	}
	// `process.exit(0)` is normally immediate, but every step of it is host
	// code: an `exit` listener (or a patched `reallyExit`) can turn it into a
	// no-op or throw — one such case was observed while testing this feature.
	// The SIGKILL fallback guarantees the prompt comes back; the report is
	// already on disk and session entries are appended as they happen, so
	// nothing recoverable is lost.
	const hardKill = setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
	try {
		process.exit(0);
	} catch {
		// Fall through to the hard kill.
	}
	clearTimeout(hardKill);
	process.kill(process.pid, "SIGKILL");
}

function installProcessHooks(state: QuitGuardState): void {
	if (state.installed) return;
	state.installed = true;

	const originalWrite = process.stdout.write;
	// Capture the overload parameters once, then forward the exact same tuple:
	// no casts, and every `write(chunk)` / `write(chunk, cb)` / `write(chunk,
	// encoding, cb)` call site keeps working.
	const wrapped = (...args: Parameters<typeof process.stdout.write>): boolean => {
		try {
			state.guard.observeOutput(args[0]);
		} catch {
			// Never let observation break terminal output.
		}
		return originalWrite.apply(process.stdout, args);
	};
	// SAFETY: the forwarded tuple is exactly what the original function receives
	// (Node normalizes the (chunk, cb) form itself); the cast only restores
	// Writable.write's two overloads, which `Parameters<...>` collapses into one.
	process.stdout.write = wrapped as unknown as typeof process.stdout.write;

	// Ctrl+Z resume: `handleCtrlZ()` calls ui.stop() (teardown marker), then
	// SIGCONT calls ui.start() (restart marker). Both cancel; this listener
	// additionally disarms synchronously so an already-expired timer cannot
	// win the race against the resume. Windows cannot deliver SIGCONT at all.
	if (process.platform !== "win32") {
		process.on("SIGCONT", () => state.guard.resume());
	}
}

function latestReportName(dir: string): string | undefined {
	try {
		if (!existsSync(dir)) return undefined;
		const names = readdirSync(dir)
			.filter(
				(name) => name.startsWith("quit-hang-") && name.endsWith(".json"),
			)
			.sort();
		return names.length > 0 ? names[names.length - 1] : undefined;
	} catch {
		return undefined;
	}
}

function statusText(state: QuitGuardState): string {
	const config = state.config;
	const last = latestReportName(state.reportDir);
	const parts = [
		`quit guard: ${config.enabled ? "on" : "off"}`,
		`timeout ${config.timeoutMs}ms`,
		`report ${config.report ? "on" : "off"}`,
		`last hang: ${last ?? "none"}`,
	];
	return parts.join(" · ");
}

function buildState(agentDir: string): QuitGuardState {
	const store = new QuitGuardStore(join(agentDir, QUIT_GUARD_FILE));
	const config = store.get();
	let state: QuitGuardState | undefined;
	// PI_QUIT_GUARD_DEBUG points at a file that receives one line per
	// arm/disarm/fire. It exists because the failure being debugged happens
	// after the TUI is gone: there is no other channel left to observe.
	const debugPath = process.env.PI_QUIT_GUARD_DEBUG;
	const guard = new QuitGuard(config.timeoutMs, {
		onFire: (info) => {
			if (state) fire(state, info);
		},
		// Raw mode is the independent "TUI still running" signal; see guard.ts.
		isTuiActive: () => process.stdin.isRaw === true,
		onEvent: debugPath
			? (event, detail) => {
					try {
						appendFileSync(
							debugPath,
							`${new Date().toISOString()} ${event} ${detail}\n`,
						);
					} catch {
						// Debug output must never affect the guard.
					}
				}
			: undefined,
	});
	state = {
		store,
		guard,
		config,
		reportDir: join(agentDir, QUIT_GUARD_REPORT_DIR),
		installed: false,
	};
	return state;
}

export interface QuitGuardOptions {
	/** pi config directory; defaults to `getAgentDir()` (tests inject a temp dir). */
	readonly agentDir?: string;
}

export function registerQuitGuard(
	pi: ExtensionAPI,
	options: QuitGuardOptions = {},
): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const state = sharedState() ?? buildState(agentDir);
	storeSharedState(state);

	// A reload rebuilds the extension instance: refresh settings from disk and
	// start unarmed. Any watchdog armed by the previous instance belonged to a
	// teardown that has already been replaced.
	state.store = new QuitGuardStore(join(agentDir, QUIT_GUARD_FILE));
	state.config = state.store.get();
	state.reportDir = join(agentDir, QUIT_GUARD_REPORT_DIR);
	state.guard.resume();
	state.guard.setEnabled(state.config.enabled);
	state.guard.setTimeoutMs(state.config.timeoutMs);

	installProcessHooks(state);
	if (process.env.PI_QUIT_GUARD_DEBUG) {
		try {
			appendFileSync(
				process.env.PI_QUIT_GUARD_DEBUG,
				`${new Date().toISOString()} register agentDir=${agentDir} enabled=${state.config.enabled} timeout=${state.config.timeoutMs}\n`,
			);
		} catch {
			// ignore
		}
	}

	pi.registerCommand("quit-guard", {
		description:
			"Quit watchdog: force-exit when pi's shutdown hangs (/quit-guard [on|off|<timeoutMs>])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim();
			if (raw.length === 0) {
				ctx.ui.notify(statusText(state), "info");
				return;
			}
			const token = raw.toLowerCase();
			if (token === "on" || token === "off") {
				const enabled = token === "on";
				state.config = state.store.update({ enabled });
				state.guard.setEnabled(enabled);
				ctx.ui.notify(
					enabled
						? `quit guard ON — force exits ${state.config.timeoutMs}ms after a stuck shutdown.`
						: "quit guard OFF — a stuck shutdown will keep hanging until kill -9.",
					"info",
				);
				return;
			}
			if (/^[0-9]+$/.test(token)) {
				const timeoutMs = normalizeTimeoutMs(Number(token));
				state.config = state.store.update({ timeoutMs });
				state.guard.setTimeoutMs(timeoutMs);
				ctx.ui.notify(
					`quit guard timeout ${timeoutMs}ms (allowed range ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}ms).`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				"Usage: /quit-guard (status) | /quit-guard on|off | /quit-guard <timeoutMs>",
				"error",
			);
		},
	});
}
