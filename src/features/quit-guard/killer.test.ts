/**
 * Unit tests for the independent-thread hard kill (killer.ts).
 *
 * What these tests deliberately do NOT cover: the worker actually SIGKILLing
 * the process. A test that kills its own process cannot report results; the
 * kill path is verified in real-pi smoke runs (an extension whose
 * `process.on("exit")` listener deadlocks, /quit, and the pane returning to
 * the shell — see .agents/implementations/2026-11-13). Here we pin the
 * safety property instead: an armed kill that gets cancelled, or whose
 * process simply keeps living, must never fire on its own or break the
 * caller.
 */
import { describe, expect, it } from "vitest";
import { armThreadHardKill, armThreadWatchdog } from "./killer.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("armThreadWatchdog", () => {
	it("never kills while the main loop keeps beating (deadline passes, loop alive)", async () => {
		// A tiny deadline so the worker's sampling phases run within the test;
		// the heartbeat below proves a live loop, which the worker must step
		// aside for — the main-loop fire timer owns the outcome there.
		const watchdog = armThreadWatchdog({
			deadlineMs: 100,
			headStartMs: 50,
			sampleMs: 100,
			restore: "",
			reportDir: undefined,
		});
		const beat = setInterval(() => watchdog.heartbeat(), 50);
		// Long past deadline + head start + sampling: the runner surviving is
		// the assertion.
		await sleep(700);
		clearInterval(beat);
		watchdog.cancel();
		expect(process.pid).toBeGreaterThan(0);
	});

	it("is inert once cancelled, even with the deadline long past", async () => {
		const watchdog = armThreadWatchdog({
			deadlineMs: 50,
			headStartMs: 25,
			sampleMs: 50,
			restore: "",
			reportDir: undefined,
		});
		// No heartbeat at all: only the cancellation keeps this process alive,
		// which is exactly the disarm contract (TUI restarted, /reload, ...).
		watchdog.cancel();
		watchdog.cancel();
		await sleep(400);
		expect(process.pid).toBeGreaterThan(0);
	});
});

describe("armThreadHardKill", () => {
	it("does not kill the process before its deadline passes", async () => {
		const cancel = armThreadHardKill(60_000);
		// Long enough for the worker thread to spin up, wait, and be bored;
		// the test runner surviving this line IS the assertion.
		await sleep(300);
		expect(process.pid).toBeGreaterThan(0);
		cancel();
	});

	it("tolerates being cancelled twice", async () => {
		const cancel = armThreadHardKill(60_000);
		cancel();
		cancel();
		await sleep(100);
		expect(process.pid).toBeGreaterThan(0);
	});
});
