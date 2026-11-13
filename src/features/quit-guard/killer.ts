/**
 * quit-guard feature — independent-thread hard kill.
 *
 * Why this exists (2026-11-13, real hang, pid 398960): the guard fired,
 * wrote its report, printed "forcing exit" and called `process.exit(0)` —
 * and the process stayed alive for 18+ minutes (`futex_wait`, PPID=1, its
 * pty already deleted by the user closing the terminal window). The exit
 * path runs host code (`process.on("exit")` listeners, graceful-fs patches,
 * stdio flush) and can deadlock synchronously. Any fallback scheduled on
 * the event loop (`setTimeout`) is dead the moment the main thread blocks:
 * a timer cannot fire inside a dead loop.
 *
 * Two watchdogs, both on `worker_threads` (an independent OS thread that
 * keeps running while the main thread is blocked):
 *
 *  1. `armThreadHardKill(delayMs)` — the last-resort layer of fire(): after
 *     the report is on disk and "forcing exit" has been printed, kill the
 *     process `delayMs` later no matter what `process.exit(0)` did.
 *
 *  2. `armThreadWatchdog({ deadlineMs, ... })` — armed when the guard arms
 *     (teardown marker / shutdown event), covering the blind spot the
 *     main-loop timer has: a main thread that deadlocks BEFORE the fire
 *     deadline (e.g. synchronously inside `process.exit` right after a fast
 *     dispose) never runs the fire timer at all. The main loop must prove
 *     liveness with a heartbeat (a 1 Hz counter in shared memory). The
 *     worker waits out `deadlineMs` (+ a head start for the main-loop fire
 *     timer, which handles the common hangs with full context: raw-mode
 *     probe, report, restore), then samples the heartbeat twice. Still
 *     beating → the event loop is alive → step aside (the fire timer owns
 *     the outcome, including its stray-marker protection). Stopped → the
 *     main loop can never fire → the worker restores the terminal, writes a
 *     minimal report and SIGKILLs. This kills exactly-and-only a main
 *     thread that is alive as a process but dead as an event loop.
 *
 * Failure policy: if a Worker cannot even be constructed, degrade to a
 * no-op — the fire path still has its `setTimeout` fallback, and a killer
 * that breaks the arm/fire sequence is worse than no extra killer.
 */
import { Worker } from "node:worker_threads";

/**
 * Start a watchdog thread that SIGKILLs this process after `delayMs`.
 *
 * Returns a `cancel()` that terminates the worker. Cancelling only matters
 * on the "process.exit threw synchronously" path, where fire() recovers and
 * performs its own synchronous kill; on every healthy path the process dies
 * with the main thread and the worker is never heard from again.
 */
export function armThreadHardKill(delayMs: number): () => void {
	let worker: Worker;
	try {
		worker = new Worker(
			`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Math.max(
				0,
				delayMs,
			)});
process.kill(process.pid, "SIGKILL");`,
			{ eval: true },
		);
	} catch {
		// Could not start the watchdog thread (resource exhaustion, ...):
		// degrade to the setTimeout fallback instead of breaking the fire path.
		return () => {};
	}
	// The worker must never keep the process alive on its own: its only job
	// is to end it.
	worker.unref();
	return () => {
		try {
			void worker.terminate();
		} catch {
			// terminate() returns a promise that can only reject if the worker
			// is already gone; either way this process is about to exit.
		}
	};
}

/** Handle returned by {@link armThreadWatchdog}. */
export interface ThreadWatchdog {
	/** Record one main-loop heartbeat tick (idempotent per tick). */
	heartbeat(): void;
	/** Disarm: the main loop owns the outcome from here on. */
	cancel(): void;
}

export interface ThreadWatchdogOptions {
	/** Guard deadline (ms) the main-loop fire timer is armed with. */
	readonly deadlineMs: number;
	/**
	 * Grace after the deadline before the first heartbeat sample (ms), so
	 * the main-loop fire timer — which handles hangs with full context —
	 * always gets the first shot.
	 */
	readonly headStartMs?: number;
	/** Gap between the two heartbeat samples (ms). Default 1500. */
	readonly sampleMs?: number;
	/** Terminal restore written before the watchdog's kill. */
	readonly restore?: string;
	/** Directory for the minimal deadlock report; omit to skip the report. */
	readonly reportDir?: string;
	/** PI_QUIT_GUARD_DEBUG path, appended to from the worker on a kill. */
	readonly debugPath?: string;
}

/**
 * Cells of the shared heartbeat buffer: [0] = heartbeat ticks (written by
 * the main loop, never waited on), [1] = signal (0 = armed, 1 = cancelled;
 * the only cell the worker waits on — Atomics.wait's third argument is the
 * EXPECTED value, so waiting on the heartbeat cell, which changes on every
 * tick, would return "not-equal" immediately and fake a deadlock).
 */
const CELL_HEARTBEAT = 0;
const CELL_SIGNAL = 1;

const WATCHDOG_SOURCE = `
(function () {
const { workerData } = require("node:worker_threads");
const { writeSync, writeFileSync, mkdirSync, appendFileSync } = require("node:fs");
const cells = workerData.cells;
const cancelFlag = () => Atomics.load(cells, ${CELL_SIGNAL}) === 1;
// Phase 1: wait out the deadline plus the main-loop timer's head start.
Atomics.wait(cells, ${CELL_SIGNAL}, 0, workerData.deadlineMs + workerData.headStartMs);
if (cancelFlag()) return;
// Phase 2: sample the heartbeat twice. A loop that is merely slow still
// ticks; a loop that is blocked cannot.
const first = Atomics.load(cells, ${CELL_HEARTBEAT});
Atomics.wait(cells, ${CELL_SIGNAL}, 0, workerData.sampleMs);
if (cancelFlag()) return;
if (Atomics.load(cells, ${CELL_HEARTBEAT}) !== first) return;
// Phase 3: deadlocked. Restore the terminal, leave a minimal trace, kill.
try { writeSync(1, workerData.restore); } catch {}
try {
	mkdirSync(workerData.reportDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	writeFileSync(
		workerData.reportDir + "/quit-hang-" + ts + "-" + process.pid + "-thread.json",
		JSON.stringify(
			{
				version: 1,
				kind: "quit-guard",
				source: "thread-watchdog",
				timestamp: new Date().toISOString(),
				pid: process.pid,
				timeoutMs: workerData.deadlineMs,
				elapsedMs: workerData.deadlineMs + workerData.headStartMs + workerData.sampleMs,
				marker: "heartbeat-stopped",
				note: "main event loop stopped beating during shutdown; killed from the watchdog thread (main-loop fire timer could never run)",
			},
			null,
			"\\t",
		) + "\\n",
	);
} catch {}
try {
	writeSync(2, "[pi-toolkits/quit-guard] main loop stopped during shutdown (no heartbeat for " + workerData.sampleMs + "ms after the " + (workerData.deadlineMs + workerData.headStartMs) + "ms deadline); killing from the watchdog thread.\\n");
} catch {}
try {
	if (workerData.debugPath) appendFileSync(workerData.debugPath, new Date().toISOString() + " thread-kill heartbeat-stopped deadline=" + workerData.deadlineMs + "\\n");
} catch {}
process.kill(process.pid, "SIGKILL");
})();
`;

/**
 * Arm the arm-time watchdog. See the module comment for the protocol.
 *
 * The returned handle is deliberately passive: an owner that forgets to
 * cancel merely keeps one unref'd worker alive for the rest of the process
 * — which the deadline then ends (heartbeat still beating → the worker
 * steps aside; heartbeat stopped → the process was dead anyway).
 */
export function armThreadWatchdog(
	options: ThreadWatchdogOptions,
): ThreadWatchdog {
	const cells = new Int32Array(new SharedArrayBuffer(8));
	let worker: Worker;
	try {
		worker = new Worker(WATCHDOG_SOURCE, {
			eval: true,
			workerData: {
				cells,
				deadlineMs: Math.max(0, options.deadlineMs),
				headStartMs: Math.max(0, options.headStartMs ?? 500),
				sampleMs: Math.max(0, options.sampleMs ?? 1_500),
				restore: options.restore ?? "",
				reportDir: options.reportDir ?? "",
				debugPath: options.debugPath ?? "",
			},
		});
	} catch {
		// No watchdog thread: the guard degrades to its main-loop timer,
		// exactly the behavior that existed before this layer.
		return { heartbeat: () => {}, cancel: () => {} };
	}
	worker.unref();
	let beats = 0;
	return {
		heartbeat: () => {
			Atomics.store(cells, CELL_HEARTBEAT, ++beats);
		},
		cancel: () => {
			// Flag first so a worker whose terminate() has not landed yet
			// stops at its next check; notify so it wakes now (the signal cell
			// is the only one the worker waits on); terminate so the thread
			// goes away even mid-phase-1.
			Atomics.store(cells, CELL_SIGNAL, 1);
			Atomics.notify(cells, CELL_SIGNAL);
			try {
				void worker.terminate();
			} catch {
				// Already gone.
			}
		},
	};
}
