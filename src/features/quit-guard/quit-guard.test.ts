/**
 * quit-guard feature — watchdog state machine, settings and report tests.
 *
 * Everything here is deterministic: the guard takes an injected clock, timer
 * scheduler and one-turn deferral, and the store/report tests use temp
 * directories (never the real agent dir).
 *
 * Coverage map:
 *  - arming on both teardown markers and on a quit `session_shutdown` event
 *    (the signal-triggered path, where the marker is never written),
 *    idempotence, re-arm after disarm;
 *  - disarming on both restart markers (TUI mode switch, Ctrl+Z resume) and
 *    on an explicit `resume()`, including the "expired timer loses to
 *    SIGCONT" race;
 *  - `enabled: false` is inert in both directions;
 *  - Buffer chunks are understood;
 *  - timeout normalization/clamping and settings round-trips;
 *  - the hang report shape, its write path, its failure paths, redaction and
 *    file modes;
 *  - the `/quit-guard` command surface (status/on/off/timeout/usage) and the
 *    one-wrapper-per-process invariant.
 */
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	RESTART_MARKERS,
	SHUTDOWN_EVENT_MARKER,
	TEARDOWN_MARKERS,
	TERMINAL_RESTORE,
} from "./constants.js";
import { QuitGuard, findMarker, type GuardFireInfo } from "./guard.js";
import { registerQuitGuard } from "./index.js";
import {
	collectHangReport,
	formatHangReportSummary,
	redactArgv,
	writeHangReport,
} from "./report.js";
import {
	DEFAULT_CONFIG,
	QuitGuardStore,
	normalizeConfig,
	normalizeTimeoutMs,
} from "./store.js";

/** Minimal controllable scheduler: nothing runs until `fire()`. */
function fakeTimers() {
	const callbacks = new Map<number, () => void>();
	let nextId = 0;
	return {
		schedule: (run: () => void): number => {
			nextId += 1;
			const id = nextId;
			callbacks.set(id, run);
			return id;
		},
		cancel: (handle: unknown): void => {
			callbacks.delete(handle as number);
		},
		/** Run every currently registered timer once. */
		fire(): void {
			const pending = [...callbacks.values()];
			callbacks.clear();
			for (const run of pending) run();
		},
		pending(): number {
			return callbacks.size;
		},
	};
}

/** Collects one-turn deferrals so a resume can be simulated in between. */
function fakeDefer() {
	const queue: Array<() => void> = [];
	return {
		defer: (run: () => void): void => {
			queue.push(run);
		},
		flush(): void {
			const pending = queue.splice(0);
			for (const run of pending) run();
		},
	};
}

function makeGuard(options: {
	timeoutMs?: number;
	now?: () => number;
	fired?: GuardFireInfo[];
	isTuiActive?: () => boolean;
	events?: string[];
}) {
	const timers = fakeTimers();
	const deferred = fakeDefer();
	let now = 0;
	const fired = options.fired ?? [];
	const guard = new QuitGuard(options.timeoutMs ?? 1_000, {
		now: options.now ?? (() => now),
		schedule: timers.schedule,
		cancel: timers.cancel,
		defer: deferred.defer,
		onFire: (info) => fired.push(info),
		isTuiActive: options.isTuiActive,
		onEvent: options.events
			? (event, detail) => options.events?.push(`${event}:${detail}`)
			: undefined,
	});
	return {
		guard,
		timers,
		deferred,
		fired,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("terminal markers", () => {
	it("uses the exact sequences pi's TUI writes", () => {
		expect(TEARDOWN_MARKERS).toEqual(["\x1b[?2004l", "\x1b[?1049l"]);
		expect(RESTART_MARKERS).toEqual(["\x1b[?2004h", "\x1b[?1049h"]);
	});

	it("restores paste mode, the alternate screen and the cursor on a forced exit", () => {
		expect(TERMINAL_RESTORE).toBe(
			"\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m\r\n",
		);
	});
});

describe("findMarker", () => {
	it("finds a marker in a string chunk", () => {
		expect(findMarker("hello\x1b[?2004l", TEARDOWN_MARKERS)).toBe(
			"\x1b[?2004l",
		);
	});

	it("finds a marker in a Buffer chunk", () => {
		expect(findMarker(Buffer.from("x\x1b[?1049ly"), TEARDOWN_MARKERS)).toBe(
			"\x1b[?1049l",
		);
	});

	it("returns undefined for unrelated and empty chunks", () => {
		expect(findMarker("rendering…", TEARDOWN_MARKERS)).toBeUndefined();
		expect(findMarker("", TEARDOWN_MARKERS)).toBeUndefined();
		expect(findMarker(new Uint8Array(0), TEARDOWN_MARKERS)).toBeUndefined();
	});
});

describe("QuitGuard", () => {
	it("arms on the bracketed-paste teardown and fires with the elapsed time", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({});
		guard.observeOutput("\x1b[?2004l");
		expect(guard.isArmed()).toBe(true);
		advance(1_500);
		timers.fire();
		deferred.flush();
		expect(fired).toEqual([
			{ startedAt: 0, elapsedMs: 1_500, marker: "\x1b[?2004l" },
		]);
		expect(guard.isArmed()).toBe(false);
	});

	it("arms on the alternate-screen teardown as well", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({});
		guard.observeOutput("\x1b[?1049l");
		advance(2_000);
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(1);
		expect(fired[0].marker).toBe("\x1b[?1049l");
	});

	it("arms only once when a teardown writes both markers", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({});
		guard.observeOutput("\x1b[?2004l");
		guard.observeOutput("\x1b[?1049l");
		expect(timers.pending()).toBe(1);
		advance(5_000);
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(1);
	});

	it("disarms when the TUI restarts (mode switch) before the deadline", () => {
		const { guard, timers, fired } = makeGuard({});
		guard.observeOutput("\x1b[?2004l");
		guard.observeOutput("\x1b[?2004h");
		expect(guard.isArmed()).toBe(false);
		expect(timers.pending()).toBe(0);
		expect(fired).toHaveLength(0);
	});

	it("disarms on the alternate-screen restart marker too", () => {
		const { guard, timers, fired } = makeGuard({});
		guard.observeOutput("\x1b[?1049l");
		guard.observeOutput("\x1b[?1049h");
		expect(guard.isArmed()).toBe(false);
		expect(timers.pending()).toBe(0);
		expect(fired).toHaveLength(0);
	});

	it("loses an already-expired timer to a resume (SIGCONT wins the race)", () => {
		const { guard, timers, deferred, fired } = makeGuard({});
		guard.observeOutput("\x1b[?2004l");
		timers.fire(); // timer expired while the process was suspended
		guard.resume(); // SIGCONT handler ran first
		deferred.flush();
		expect(fired).toHaveLength(0);
	});

	it("re-arms after a disarm and reports the newest arm", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({});
		guard.observeOutput("\x1b[?2004l");
		guard.observeOutput("\x1b[?2004h"); // mode switch: disarm
		guard.observeOutput("\x1b[?1049l"); // real quit: arm again
		advance(2_500);
		// Firing here runs the current (second) arm's timer, not the cancelled one.
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(1);
		expect(fired[0].elapsedMs).toBe(2_500);
	});

	it("does nothing when disabled", () => {
		const { guard, timers, fired } = makeGuard({});
		guard.setEnabled(false);
		guard.observeOutput("\x1b[?2004l");
		expect(guard.isArmed()).toBe(false);
		expect(timers.pending()).toBe(0);
		expect(fired).toHaveLength(0);
	});

	it("disarms an armed guard when it is disabled", () => {
		const { guard, timers, fired } = makeGuard({});
		guard.observeOutput("\x1b[?2004l");
		guard.setEnabled(false);
		expect(guard.isArmed()).toBe(false);
		expect(timers.pending()).toBe(0);
		expect(fired).toHaveLength(0);
	});

	it("understands Buffer chunks", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({});
		guard.observeOutput(Buffer.from("\x1b[?2004l"));
		advance(1_000);
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(1);
	});

	it("ignores ordinary render output", () => {
		const { guard, timers, fired } = makeGuard({});
		guard.observeOutput("the quick brown fox");
		guard.observeOutput("x\x1b[?25ly");
		expect(guard.isArmed()).toBe(false);
		expect(timers.pending()).toBe(0);
		expect(fired).toHaveLength(0);
	});

	it("never fires while a TUI is still active (stray marker in rendered content)", () => {
		const events: string[] = [];
		const { guard, timers, deferred, fired, advance } = makeGuard({
			isTuiActive: () => true,
			events,
		});
		guard.observeOutput("\x1b[?2004l");
		advance(5_000);
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(0);
		expect(guard.isArmed()).toBe(false);
		expect(events).toContain("disarm:tui-still-active");
	});

	it("still fires when the liveness probe itself throws", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({
			isTuiActive: () => {
				throw new Error("stdin is gone");
			},
		});
		guard.observeOutput("\x1b[?2004l");
		advance(1_200);
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(1);
	});

	it("fires when the TUI has left raw mode", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({
			isTuiActive: () => false,
		});
		guard.observeOutput("\x1b[?2004l");
		advance(1_200);
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(1);
	});

	it("arms from a quit shutdown event when no teardown was written", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({});
		guard.armFromShutdown();
		expect(guard.isArmed()).toBe(true);
		advance(1_000);
		timers.fire();
		deferred.flush();
		expect(fired).toEqual([
			{ startedAt: 0, elapsedMs: 1_000, marker: SHUTDOWN_EVENT_MARKER },
		]);
		expect(guard.isArmed()).toBe(false);
	});

	it("keeps the teardown deadline when a shutdown event arrives later", () => {
		const { guard, timers, deferred, fired, advance } = makeGuard({});
		guard.observeOutput("\x1b[?2004l");
		advance(500);
		guard.armFromShutdown(); // no-op: one arm, one timer, one deadline
		advance(500);
		timers.fire();
		deferred.flush();
		expect(fired).toEqual([
			{ startedAt: 0, elapsedMs: 1_000, marker: "\x1b[?2004l" },
		]);
	});

	it("does not arm from a shutdown event while disabled", () => {
		const { guard } = makeGuard({});
		guard.setEnabled(false);
		guard.armFromShutdown();
		expect(guard.isArmed()).toBe(false);
	});

	it("ignores the raw-mode probe when a shutdown event armed it", () => {
		// The signal-triggered path hangs while the TUI is still in raw mode, so
		// the probe would disarm exactly the case this trigger exists for.
		const { guard, timers, deferred, fired } = makeGuard({
			isTuiActive: () => true,
		});
		guard.armFromShutdown();
		timers.fire();
		deferred.flush();
		expect(fired).toHaveLength(1);
		expect(fired[0]?.marker).toBe(SHUTDOWN_EVENT_MARKER);
	});

	it("reports arm/disarm/fire transitions to the debug tap", () => {
		const events: string[] = [];
		const timers = fakeTimers();
		const deferred = fakeDefer();
		let now = 0;
		const guard = new QuitGuard(1_000, {
			now: () => now,
			schedule: timers.schedule,
			cancel: timers.cancel,
			defer: deferred.defer,
			onFire: () => {},
			onEvent: (event, detail) => events.push(`${event}:${detail}`),
		});
		guard.observeOutput("\x1b[?2004l");
		guard.observeOutput("\x1b[?2004h");
		guard.observeOutput("\x1b[?1049l");
		now = 1_000;
		timers.fire();
		deferred.flush();
		expect(events).toEqual([
			"arm:\x1b[?2004l timeout=1000ms",
			"disarm:\x1b[?2004l",
			"arm:\x1b[?1049l timeout=1000ms",
			"fire:elapsed=1000ms",
		]);
	});

	it("keeps the configured timeout", () => {
		const { guard } = makeGuard({ timeoutMs: 1_000 });
		expect(guard.getTimeoutMs()).toBe(1_000);
		guard.setTimeoutMs(7_000);
		expect(guard.getTimeoutMs()).toBe(7_000);
	});
});

describe("normalizeTimeoutMs", () => {
	it("clamps below the floor", () => {
		expect(normalizeTimeoutMs(500)).toBe(MIN_TIMEOUT_MS);
	});

	it("clamps above the ceiling", () => {
		expect(normalizeTimeoutMs(99_999)).toBe(MAX_TIMEOUT_MS);
	});

	it("rounds numeric input", () => {
		expect(normalizeTimeoutMs(4_321.6)).toBe(4_322);
	});

	it("falls back for non-numbers", () => {
		expect(normalizeTimeoutMs("abc")).toBe(DEFAULT_TIMEOUT_MS);
		expect(normalizeTimeoutMs(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
		expect(normalizeTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
	});
});

describe("normalizeConfig", () => {
	it("returns defaults for a non-object", () => {
		expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig("nope")).toEqual(DEFAULT_CONFIG);
	});

	it("keeps known fields and defaults the rest", () => {
		expect(normalizeConfig({ enabled: false })).toEqual({
			...DEFAULT_CONFIG,
			enabled: false,
		});
		expect(normalizeConfig({ timeoutMs: 3_000, report: false })).toEqual({
			enabled: true,
			timeoutMs: 3_000,
			report: false,
		});
	});

	it("clamps a stored timeout instead of trusting it", () => {
		expect(normalizeConfig({ timeoutMs: 1 }).timeoutMs).toBe(MIN_TIMEOUT_MS);
		expect(normalizeConfig({ timeoutMs: 10 ** 9 }).timeoutMs).toBe(
			MAX_TIMEOUT_MS,
		);
	});
});

describe("QuitGuardStore", () => {
	function tempFile(): { dir: string; file: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-quit-guard-"));
		return { dir, file: join(dir, "pi-toolkits-quit-guard.json") };
	}

	it("defaults when the file does not exist", () => {
		const { dir, file } = tempFile();
		try {
			const store = new QuitGuardStore(file);
			expect(store.get()).toEqual(DEFAULT_CONFIG);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to defaults and warns on a corrupt file", () => {
		const { dir, file } = tempFile();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeFileSync(file, "{ not json", "utf8");
			const store = new QuitGuardStore(file);
			expect(store.get()).toEqual(DEFAULT_CONFIG);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists an update atomically and reads it back", () => {
		const { dir, file } = tempFile();
		try {
			const store = new QuitGuardStore(file);
			expect(store.update({ enabled: false, timeoutMs: 3_000 }).enabled).toBe(
				false,
			);
			const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
			expect(parsed).toEqual({
				enabled: false,
				timeoutMs: 3_000,
				report: true,
			});
			expect(new QuitGuardStore(file).get()).toEqual({
				enabled: false,
				timeoutMs: 3_000,
				report: true,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizes a timeout given to the command", () => {
		const { dir, file } = tempFile();
		try {
			const store = new QuitGuardStore(file);
			expect(store.update({ timeoutMs: 100 }).timeoutMs).toBe(MIN_TIMEOUT_MS);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("hang report", () => {
	it("collects timing, process metadata and live handles", () => {
		const report = collectHangReport(
			{ timeoutMs: 10_000, elapsedMs: 12_345, marker: "\x1b[?1049l" },
			{
				now: () => new Date("2026-11-05T06:00:00.000Z"),
				pid: 4242,
				cwd: "/tmp/project",
				argv: ["pi", "--no-session"],
			},
		);
		expect(report.version).toBe(1);
		expect(report.kind).toBe("quit-guard");
		expect(report.timestamp).toBe("2026-11-05T06:00:00.000Z");
		expect(report.pid).toBe(4242);
		expect(report.timeoutMs).toBe(10_000);
		expect(report.elapsedMs).toBe(12_345);
		expect(report.marker).toBe("\x1b[?1049l");
		expect(report.cwd).toBe("/tmp/project");
		expect(report.argv).toEqual(["pi", "--no-session"]);
		expect(Array.isArray(report.activeHandles)).toBe(true);
		expect(Array.isArray(report.activeRequests)).toBe(true);
		expect(Array.isArray(report.libuv)).toBe(true);
	});

	it("writes a JSON artifact and returns its path", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-quit-guard-report-"));
		try {
			const report = collectHangReport(
				{ timeoutMs: 10_000, elapsedMs: 11_000, marker: "\x1b[?2004l" },
				{ now: () => new Date("2026-11-05T06:00:00.000Z"), pid: 7 },
			);
			const file = writeHangReport(dir, report);
			expect(file).toBeDefined();
			expect(file ?? "").toContain(
				"quit-hang-2026-11-05T06-00-00-000Z-7.json",
			);
			expect(JSON.parse(readFileSync(file ?? "", "utf8"))).toMatchObject({
				kind: "quit-guard",
				pid: 7,
				elapsedMs: 11_000,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined when the report cannot be written", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-quit-guard-report-"));
		// A file where a directory is expected: mkdir fails, write must degrade.
		const notADirectory = join(dir, "occupied");
		writeFileSync(notADirectory, "", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const report = collectHangReport(
				{ timeoutMs: 10_000, elapsedMs: 10_000, marker: "\x1b[?2004l" },
				{ pid: 8 },
			);
			expect(writeHangReport(notADirectory, report)).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("survives a working directory that no longer exists", () => {
		// `process.cwd()` throws ENOENT once the directory is removed; the report
		// is written on the exit path, so that must not abort it.
		const original = process.cwd();
		const doomed = mkdtempSync(join(tmpdir(), "pi-quit-guard-cwd-"));
		try {
			process.chdir(doomed);
			rmSync(doomed, { recursive: true, force: true });
			const report = collectHangReport(
				{ timeoutMs: 10_000, elapsedMs: 10_000, marker: "\x1b[?2004l" },
				{ pid: 11 },
			);
			expect(report.cwd).toContain("working directory unavailable");
			expect(report.pid).toBe(11);
			expect(formatHangReportSummary(report)).toContain("cwd unavailable");
		} finally {
			process.chdir(original);
		}
	});

	it("redacts credentials in the recorded arguments", () => {
		expect(
			redactArgv([
				"pi",
				"--api-key",
				"opaque-token-value",
				"--token=another-secret",
				"--trace",
				"sk-abcdefghijklmnopqrstuv",
			]),
		).toEqual([
			"pi",
			"--api-key",
			"[redacted]",
			"--token=[redacted]",
			"--trace",
			"[redacted]",
		]);
	});

	it("leaves an ordinary argument list intact", () => {
		expect(redactArgv(["pi", "--no-session", "./src/index.ts"])).toEqual([
			"pi",
			"--no-session",
			"./src/index.ts",
		]);
	});

	it.skipIf(process.platform === "win32")(
		"writes the report owner-only (0600 in an 0700 directory)",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "pi-quit-guard-mode-"));
			const reports = join(dir, "quit-guard");
			try {
				const report = collectHangReport(
					{ timeoutMs: 10_000, elapsedMs: 10_000, marker: "\x1b[?2004l" },
					{ pid: 12 },
				);
				const file = writeHangReport(reports, report);
				expect(file).toBeDefined();
				expect(statSync(reports).mode & 0o777).toBe(0o700);
				expect(statSync(file ?? "").mode & 0o777).toBe(0o600);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("summarizes what is left when no handle is reported", () => {
		const report = collectHangReport(
			{ timeoutMs: 2_000, elapsedMs: 2_000, marker: "\x1b[?2004l" },
			{ pid: 13 },
		);
		expect(formatHangReportSummary({ ...report, activeHandles: [] })).toContain(
			"handles: none",
		);
	});

	it("summarizes the timeout, the time spent and the live handles", () => {
		const report = collectHangReport(
			{ timeoutMs: 10_000, elapsedMs: 13_000, marker: "\x1b[?2004l" },
			{ pid: 9 },
		);
		const summary = formatHangReportSummary({
			...report,
			activeHandles: ["Socket", "Timer"],
		});
		expect(summary).toContain("10000ms");
		expect(summary).toContain("13000ms");
		expect(summary).toContain("Socket, Timer");
	});
});

/** The shared state is keyed on globalThis and would leak between tests. */
const SHARED_KEY = Symbol.for("@andares/pi-toolkits/quit-guard/state");

/**
 * `registerQuitGuard` installs a process-wide stdout wrapper; keep the real
 * one so every test leaves the reporter's stream exactly as it found it.
 */
const REAL_STDOUT_WRITE = process.stdout.write;

function clearSharedState(): void {
	delete (globalThis as unknown as Record<symbol, unknown>)[SHARED_KEY];
}

function fakePi(): {
	pi: ExtensionAPI;
	command: () => CommandHandler;
	emit: (event: string, payload: unknown) => void;
} {
	let registered: CommandHandler | undefined;
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	// SAFETY: only `registerCommand` and `on` are called by the feature; the
	// rest of the host surface is irrelevant here.
	const pi = {
		registerCommand: (
			_name: string,
			options: { handler: CommandHandler },
		): void => {
			registered = options.handler;
		},
		on: (name: string, handler: (payload: unknown) => void): void => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		command: () => {
			if (!registered) throw new Error("command was not registered");
			return registered;
		},
		emit: (event, payload) => {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
	};
}

type CommandHandler = (
	args: string,
	ctx: ExtensionCommandContext,
) => Promise<void>;

function fakeCtx(): { ctx: ExtensionCommandContext; notes: string[] } {
	const notes: string[] = [];
	// SAFETY: the command only touches `ui.notify`; every other ctx member is
	// unused by this feature and therefore absent.
	const ctx = {
		ui: { notify: (message: string) => notes.push(message) },
	} as unknown as ExtensionCommandContext;
	return { ctx, notes };
}

function readSettings(file: string): unknown {
	return JSON.parse(readFileSync(file, "utf8"));
}

describe("/quit-guard command", () => {
	const dirs: string[] = [];

	function setup(): { dir: string; settings: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-quit-guard-cmd-"));
		dirs.push(dir);
		return { dir, settings: join(dir, "pi-toolkits-quit-guard.json") };
	}

	afterEach(() => {
		process.stdout.write = REAL_STDOUT_WRITE;
		clearSharedState();
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the current state when called without arguments", async () => {
		const { dir, settings } = setup();
		const { pi, command } = fakePi();
		const { ctx, notes } = fakeCtx();
		registerQuitGuard(pi, { agentDir: dir });
		await command()("", ctx);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("quit guard: on");
		expect(notes[0]).toContain(`timeout ${DEFAULT_TIMEOUT_MS}ms`);
		expect(notes[0]).toContain("last hang: none");
		// A status query must not create the settings file.
		expect(existsSync(settings)).toBe(false);
	});

	it("arms on session_shutdown only for reason quit", () => {
		const { dir } = setup();
		const debugPath = join(dir, "guard-debug.jsonl");
		process.env.PI_QUIT_GUARD_DEBUG = debugPath;
		try {
			const { pi, command, emit } = fakePi();
			const { ctx } = fakeCtx();
			registerQuitGuard(pi, { agentDir: dir });
			// Session replacement and reload tear a session down without exiting.
			emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
			emit("session_shutdown", {
				type: "session_shutdown",
				reason: "new",
				targetSessionFile: "/tmp/next.jsonl",
			});
			expect(readFileSync(debugPath, "utf8")).not.toContain("arm ");
			emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			expect(readFileSync(debugPath, "utf8")).toContain(
				`arm ${SHUTDOWN_EVENT_MARKER}`,
			);
			// Disarm so the test leaves no pending deadline behind.
			void command()("off", ctx);
		} finally {
			delete process.env.PI_QUIT_GUARD_DEBUG;
		}
	});

	it("persists an off switch and turns the guard inert", async () => {
		const { dir, settings } = setup();
		const { pi, command } = fakePi();
		const { ctx, notes } = fakeCtx();
		registerQuitGuard(pi, { agentDir: dir });
		await command()("off", ctx);
		expect(notes[0]).toContain("quit guard OFF");
		expect(readSettings(settings)).toMatchObject({ enabled: false });
	});

	it("clamps a requested timeout into the supported range", async () => {
		const { dir, settings } = setup();
		const { pi, command } = fakePi();
		const { ctx, notes } = fakeCtx();
		registerQuitGuard(pi, { agentDir: dir });
		await command()("100", ctx);
		expect(notes[0]).toContain(`timeout ${MIN_TIMEOUT_MS}ms`);
		expect(readSettings(settings)).toMatchObject({
			enabled: true,
			timeoutMs: MIN_TIMEOUT_MS,
		});
	});

	it("rejects an unknown argument with the usage line", async () => {
		const { dir } = setup();
		const { pi, command } = fakePi();
		const { ctx, notes } = fakeCtx();
		registerQuitGuard(pi, { agentDir: dir });
		await command()("sometimes", ctx);
		expect(notes[0]).toContain("Usage: /quit-guard");
	});

	it("keeps one stdout wrapper per process across reload re-registration", () => {
		const { dir } = setup();
		registerQuitGuard(fakePi().pi, { agentDir: dir });
		const afterFirst = process.stdout.write;
		expect(afterFirst).not.toBe(REAL_STDOUT_WRITE);
		registerQuitGuard(fakePi().pi, { agentDir: dir });
		expect(process.stdout.write).toBe(afterFirst);
	});
});
