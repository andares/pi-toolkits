/**
 * quit-guard feature — hang artifact.
 *
 * When the watchdog fires, extension cleanup was cut short. The artifact is
 * the only evidence of what the process was waiting on, so it is written
 * synchronously *before* `process.exit(0)` and never throws: a failed report
 * must not keep the user from getting the prompt back.
 *
 * Contents: the arm/fire timing, the process state (`activeHandles` /
 * `activeRequests` class names from Node's undocumented introspection helpers),
 * and the host's own libuv handle table (`process.report.getReport().libuv`).
 * Together they are enough to tell "waiting on a socket" from "waiting on a
 * thin promise that nobody will ever resolve" — the latter shows up as an
 * empty handle table with pi's extension-shutdown frames missing.
 *
 * Privacy: `argv` and `cwd` are process facts, not conversation data, but they
 * are still credential-adjacent (`pi --api-key …`, a prompt passed as an
 * argument, a path under a private tree). The file is therefore owner-only
 * (0600 in an 0700 directory, matching the approval log) and every argument
 * goes through the same redaction rules the approval log uses.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../../lib/approval-log.js";

export interface HangReport {
	version: 1;
	kind: "quit-guard";
	/** ISO timestamp of the forced exit. */
	timestamp: string;
	pid: number;
	/** Watchdog deadline that was configured at arm time. */
	timeoutMs: number;
	/** Time actually spent inside the shutdown phase. */
	elapsedMs: number;
	/** The teardown sequence that armed the guard. */
	marker: string;
	uptimeSeconds: number;
	cwd: string;
	/** Process arguments, redacted (see the privacy note above). */
	argv: string[];
	/** Constructor names of handles keeping the event loop alive. */
	activeHandles: string[];
	/** Node's pending-request list (fs, dns, zlib, ... callbacks). */
	activeRequests: string[];
	/**
	 * Host libuv handle table (trimmed). Empty but non-null means "nothing is
	 * pending that the OS knows about": the process is parked on a promise.
	 */
	libuv: unknown[];
}

interface ProcessIntrospection {
	_getActiveHandles?: () => unknown[];
	_getActiveRequests?: () => unknown[];
	report?: { getReport?: () => { libuv?: unknown[] } };
}

export interface HangReportInput {
	timeoutMs: number;
	elapsedMs: number;
	marker: string;
}

export interface HangReportOptions {
	now?: () => Date;
	pid?: number;
	cwd?: string;
	argv?: string[];
}

/** Stand-in for `process.cwd()` when the working directory no longer exists. */
const UNKNOWN_CWD = "<unknown: working directory unavailable>";

/**
 * Flags whose *next* argument is a credential. `--api-key` with a bare opaque
 * token is the common shape and matches none of the value-prefix rules, so the
 * pair has to be recognised positionally.
 */
const SECRET_ARG =
	/^--?(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|secret|client[-_]?secret|password|passwd)$/i;

/** Redact one argument list: flag/value pairs first, then the value patterns. */
export function redactArgv(argv: readonly string[]): string[] {
	let hideNext = false;
	return argv.map((arg) => {
		if (hideNext) {
			hideNext = false;
			return "[redacted]";
		}
		if (SECRET_ARG.test(arg)) {
			hideNext = true;
			return arg;
		}
		const pair = /^(--?[^=]+)=(.+)$/.exec(arg);
		if (pair && SECRET_ARG.test(pair[1] ?? "")) {
			return `${pair[1]}=[redacted]`;
		}
		return redactText(arg);
	});
}

/** Owner-only modes; the file is credential-adjacent, like the approval log. */
const REPORT_DIR_MODE = 0o700;
const REPORT_FILE_MODE = 0o600;

/** Read a process fact without letting it abort the report. */
function attempt<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		// Every field here is diagnostics; a missing one is better than no report.
		return fallback;
	}
}

function constructorNames(list: unknown[] | undefined): string[] {
	if (!Array.isArray(list)) return [];
	const names = new Set<string>();
	for (const item of list) {
		const name =
			item && typeof item === "object" && "constructor" in item
				? (item.constructor as { name?: string })?.name
				: undefined;
		names.add(
			typeof name === "string" && name.length > 0
				? name
				: typeof item === "undefined"
					? "undefined"
					: String(typeof item),
		);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/** Show this to whoever has to debug the hang: one line, no prefixes. */
export function formatHangReportSummary(report: HangReport): string {
	const handles =
		report.activeHandles.length > 0
			? report.activeHandles.join(", ")
			: "none";
	const cwd = report.cwd === UNKNOWN_CWD ? " (cwd unavailable)" : "";
	return `shutdown exceeded ${report.timeoutMs}ms (spent ${report.elapsedMs}ms); handles: ${handles}${cwd}`;
}

export function collectHangReport(
	input: HangReportInput,
	options: HangReportOptions = {},
): HangReport {
	// SAFETY: `_getActiveHandles`, `_getActiveRequests`, and `report.getReport`
	// exist on Node's process object but are missing from (or narrower in)
	// @types/node. `ProcessIntrospection` declares them as optional, so every
	// use below is guarded and nothing is called unconditionally.
	const proc = process as unknown as ProcessIntrospection & NodeJS.Process;
	const now = options.now ?? (() => new Date());
	const libuv = attempt(() => {
		const raw = proc.report?.getReport?.();
		return raw && Array.isArray(raw.libuv) ? raw.libuv.slice(0, 200) : [];
	}, [] as unknown[]);
	return {
		version: 1,
		kind: "quit-guard",
		timestamp: now().toISOString(),
		pid: options.pid ?? proc.pid,
		timeoutMs: input.timeoutMs,
		elapsedMs: Math.round(input.elapsedMs),
		marker: input.marker,
		uptimeSeconds: attempt(() => Math.round(proc.uptime()), 0),
		// `process.cwd()` throws ENOENT when the directory was removed during
		// the session (a startup crash pi itself guards against in 1.5.0). The
		// report is written on the exit path, so it must survive that.
		cwd: options.cwd ?? attempt(() => proc.cwd(), UNKNOWN_CWD),
		argv: attempt(
			() => redactArgv(options.argv ?? [...proc.argv]),
			[],
		),
		activeHandles: constructorNames(
			attempt(() => proc._getActiveHandles?.(), [] as unknown[]),
		),
		activeRequests: constructorNames(
			attempt(() => proc._getActiveRequests?.(), [] as unknown[]),
		),
		libuv,
	};
}

/**
 * Write the report under `dir`. Returns the path, or `undefined` when the
 * filesystem rejected it (read-only home, missing permissions, ...).
 */
export function writeHangReport(
	dir: string,
	report: HangReport,
): string | undefined {
	try {
		mkdirSync(dir, { recursive: true, mode: REPORT_DIR_MODE });
		const stamp = report.timestamp.replace(/[:.]/g, "-");
		const file = join(dir, `quit-hang-${stamp}-${report.pid}.json`);
		writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, {
			encoding: "utf8",
			mode: REPORT_FILE_MODE,
		});
		return file;
	} catch (error) {
		// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
		console.warn(
			"[pi-toolkits/quit-guard] Failed to write hang report:",
			error instanceof Error ? error.message : String(error),
		);
		return undefined;
	}
}
