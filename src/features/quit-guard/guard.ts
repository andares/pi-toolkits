/**
 * quit-guard feature — watchdog state machine.
 *
 * Deliberately dependency-free and side-effect free: it is fed stdout chunks
 * and clock/scheduler callbacks, so every branch is unit-testable without a
 * real TUI. The wiring to `process.stdout`, `SIGCONT`, the settings store and
 * the actual `process.exit()` lives in index.ts.
 *
 * State machine:
 *
 *   idle ──teardown marker──▶ armed ──timer──▶ fired (onFire, then exit)
 *     ▲                         │
 *     └──restart marker / resume┘
 *
 * Invariants:
 *  - arming is idempotent while armed (a teardown writes two markers);
 *  - a TUI restart (mode switch, Ctrl+Z resume) always wins over the timer:
 *    the fire callback is deferred one turn so a SIGCONT handler can disarm
 *    first, and the token check drops a fire whose arm was superseded;
 *  - disabled means inert: it never arms and disarms immediately.
 */
import {
	RESTART_MARKERS,
	SHUTDOWN_EVENT_MARKER,
	TEARDOWN_MARKERS,
} from "./constants.js";

/** A chunk as written to `process.stdout` (string, or Buffer/typed array). */
export type GuardChunk = string | Uint8Array;

export interface GuardFireInfo {
	/** Clock value captured when the guard armed. */
	startedAt: number;
	/** Milliseconds spent armed (i.e. inside the shutdown phase). */
	elapsedMs: number;
	/** The teardown sequence that armed the guard. */
	marker: string;
}

export interface QuitGuardDeps {
	now?: () => number;
	/** Start a timer; returns a handle handed back to `cancel`. */
	schedule?: (run: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
	/**
	 * Defer one turn (setImmediate in production). Used so an expired timer
	 * cannot beat a SIGCONT-driven disarm on the resume path.
	 */
	defer?: (run: () => void) => void;
	/** Called exactly once per arm that reaches the deadline. */
	onFire: (info: GuardFireInfo) => void;
	/** Optional debug tap (PI_QUIT_GUARD_DEBUG); never affects behavior. */
	onEvent?: (event: "arm" | "disarm" | "fire", detail: string) => void;
	/**
	 * Second, independent "is a TUI still running" signal, checked right before
	 * firing. The teardown marker can also arrive inside rendered content (a
	 * file or tool output that happens to contain the escape sequence); raw
	 * mode cannot: the TUI leaves raw mode while tearing down. An active
	 * session must never be killed by a stray marker.
	 */
	isTuiActive?: () => boolean;
}

/** First marker in `markers` that appears in the chunk, if any. */
export function findMarker(
	chunk: GuardChunk,
	markers: readonly string[],
): string | undefined {
	if (typeof chunk === "string") {
		if (chunk.length === 0) return undefined;
		for (const marker of markers) {
			if (chunk.includes(marker)) return marker;
		}
		return undefined;
	}
	if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
		return undefined;
	}
	// Buffers are the normal case; other typed arrays are rare enough that a
	// one-off copy is cheaper than a hand-rolled byte scan.
	const buffer: Buffer = Buffer.isBuffer(chunk)
		? chunk
		: Buffer.from(chunk);
	for (const marker of markers) {
		if (buffer.includes(marker)) return marker;
	}
	return undefined;
}

export class QuitGuard {
	private readonly now: () => number;
	private readonly schedule: (run: () => void, ms: number) => unknown;
	private readonly cancel: (handle: unknown) => void;
	private readonly defer: (run: () => void) => void;
	private readonly onFire: (info: GuardFireInfo) => void;
	private readonly onEvent?: (event: "arm" | "disarm" | "fire", detail: string) => void;
	private readonly isTuiActive?: () => boolean;

	private enabled = true;
	private timeoutMs: number;
	private armed = false;
	private handle: unknown;
	private startedAt = 0;
	private armedBy = "";
	/** Incremented on every arm; a stale fire callback compares against it. */
	private armToken = 0;

	constructor(timeoutMs: number, deps: QuitGuardDeps) {
		this.timeoutMs = timeoutMs;
		// performance.now() is monotonic: a wall-clock jump (NTP, WSL VM
		// resume, manual `date`) must not make an 8 s deadline look like 5 s,
		// and `elapsedMs` in the hang report must measure real time spent.
		this.now = deps.now ?? (() => performance.now());
		this.schedule =
			deps.schedule ??
			((run, ms) => setTimeout(run, ms));
		this.cancel =
			deps.cancel ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.defer = deps.defer ?? ((run) => setImmediate(run));
		this.onFire = deps.onFire;
		this.onEvent = deps.onEvent;
		this.isTuiActive = deps.isTuiActive;
	}

	/** Feed one stdout chunk. Converts markers into arm/disarm transitions. */
	observeOutput(chunk: GuardChunk): void {
		if (!this.enabled) return;
		if (this.armed) {
			// While armed the only meaningful signal is "the TUI came back".
			if (findMarker(chunk, RESTART_MARKERS)) {
				this.disarm();
			}
			return;
		}
		const marker = findMarker(chunk, TEARDOWN_MARKERS);
		if (marker) this.arm(marker);
	}

	/** Process resumed from Ctrl+Z: the TUI is about to re-enter, never kill it. */
	resume(): void {
		this.disarm();
	}

	/**
	 * Arm from a `session_shutdown` (reason `"quit"`) event, for shutdowns that
	 * hang before the TUI writes its teardown sequence — the signal-triggered
	 * path runs extension handlers first, so a stuck handler there never
	 * produces a marker. No-op when a teardown marker already armed the guard,
	 * so the measured deadline still starts at the earliest evidence.
	 */
	armFromShutdown(): void {
		if (!this.enabled || this.armed) return;
		this.arm(SHUTDOWN_EVENT_MARKER);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.disarm();
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	setTimeoutMs(timeoutMs: number): void {
		this.timeoutMs = timeoutMs;
	}

	getTimeoutMs(): number {
		return this.timeoutMs;
	}

	isArmed(): boolean {
		return this.armed;
	}

	private arm(marker: string): void {
		const token = (this.armToken += 1);
		const startedAt = this.now();
		this.armed = true;
		this.startedAt = startedAt;
		this.armedBy = marker;
		this.onEvent?.("arm", `${marker} timeout=${this.timeoutMs}ms`);
		this.handle = this.schedule(
			() => this.onTimeout(token, startedAt),
			this.timeoutMs,
		);
	}

	private disarm(): void {
		if (!this.armed) return;
		this.armed = false;
		this.onEvent?.("disarm", this.armedBy);
		if (this.handle !== undefined) {
			this.cancel(this.handle);
			this.handle = undefined;
		}
	}

	private onTimeout(token: number, startedAt: number): void {
		this.handle = undefined;
		// One turn later: a pending SIGCONT handler runs before this and can
		// disarm, so resume always wins over an expired timer.
		this.defer(() => {
			if (!this.armed || this.armToken !== token || this.startedAt !== startedAt) {
				return;
			}
			// The liveness probe is best-effort: if it throws (stdin already
			// destroyed/replaced during teardown), treat the TUI as gone and
			// still fire. A probe that can throw must not disable the watchdog.
			// An event-armed guard skips the probe on purpose: the TUI is still
			// up in exactly the signal-triggered case we are covering, and the
			// shutdown event (not rendered content) is what armed it.
			let tuiActive = false;
			if (this.armedBy !== SHUTDOWN_EVENT_MARKER) {
				try {
					tuiActive = this.isTuiActive?.() === true;
				} catch {
					tuiActive = false;
				}
			}
			if (tuiActive) {
				// A live TUI means the marker was content, not a teardown.
				this.armed = false;
				this.onEvent?.("disarm", "tui-still-active");
				return;
			}
			this.armed = false;
			const elapsedMs = this.now() - startedAt;
			this.onEvent?.("fire", `elapsed=${Math.round(elapsedMs)}ms`);
			this.onFire({ startedAt, elapsedMs, marker: this.armedBy });
		});
	}
}
