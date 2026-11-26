/**
 * Release-wait tests.
 *
 * The wait loop is the part of `pnpm release` a human stares at, and its
 * contract was narrowed on 2026-11-26: **the workflow run being green is the
 * whole completion criterion.** The loop used to keep polling the npm registry
 * after the run finished and refused to report success until the version and
 * its provenance attestation appeared there — overreach, since `pnpm publish`
 * never asked npm "did you process it well" either. So these tests pin:
 *
 *   - green run → published, immediately, without any registry/npm probing;
 *   - red run → failed immediately, with the run attached;
 *   - any other completed conclusion (cancelled, timed_out, …) → failed, and the
 *     conclusion is carried so the caller can name it;
 *   - queued run that never starts → ONE workflow_dispatch, adopt the new run;
 *   - running run → never dispatched;
 *   - nothing at all → timeout.
 *
 * Clock and sleep are injected, so no test waits on wall time.
 */
import { describe, expect, it } from "vitest";
import {
	createDispatchRescue,
	dispatchWorkflow,
	findDispatchedRun,
	waitForCiPublish,
} from "./ci-publish.mjs";

const BASE = Date.parse("2026-01-01T00:00:00Z");

/** Deterministic clock: sleeps advance it instead of waiting. */
function fakeClock(start = BASE) {
	let clock = start;
	return {
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
		advance: (ms) => {
			clock += ms;
		},
	};
}

const run = (overrides) => ({
	id: 1,
	status: "queued",
	conclusion: null,
	created_at: new Date(BASE - 120_000).toISOString(),
	started_at: undefined,
	head_branch: "master",
	head_sha: "aaa",
	html_url: "https://example.test/run/1",
	...overrides,
});

describe("waitForCiPublish", () => {
	const baseArgs = () => ({
		repo: "andares/pi-toolkits",
		token: "t",
		sha: "aaa",
		runCheckEveryMs: 1000,
		logEveryMs: 60_000,
		log: () => {},
	});

	it("reports published as soon as the run is green", async () => {
		const clock = fakeClock();
		const green = run({ id: 5, status: "completed", conclusion: "success" });
		const result = await waitForCiPublish({
			...baseArgs(),
			now: clock.now,
			sleep: clock.sleep,
			probes: { findWorkflowRun: () => green },
		});

		expect(result.status).toBe("published");
		expect(result.run?.html_url).toBe(green.html_url);
		expect(result.elapsedMs).toBe(0);
	});

	it("fails as soon as the run is red, naming the run and the conclusion", async () => {
		const clock = fakeClock();
		const red = run({ id: 7, status: "completed", conclusion: "failure" });
		const result = await waitForCiPublish({
			...baseArgs(),
			now: clock.now,
			sleep: clock.sleep,
			probes: { findWorkflowRun: () => red },
		});

		expect(result.status).toBe("failed");
		expect(result.run?.html_url).toBe(red.html_url);
		expect(result.conclusion).toBe("failure");
	});

	it("treats a completed run that did not succeed as failed", async () => {
		const clock = fakeClock();
		for (const conclusion of ["cancelled", "timed_out", "skipped"]) {
			const result = await waitForCiPublish({
				...baseArgs(),
				now: clock.now,
				sleep: clock.sleep,
				probes: {
					findWorkflowRun: () => run({ status: "completed", conclusion }),
				},
			});
			expect(result.status).toBe("failed");
			expect(result.conclusion).toBe(conclusion);
		}
	});

	it("times out when nothing ever happens", async () => {
		const clock = fakeClock();
		const result = await waitForCiPublish({
			...baseArgs(),
			timeoutMs: 3000,
			now: clock.now,
			sleep: clock.sleep,
			probes: {},
		});

		expect(result.status).toBe("timeout");
		expect(result.elapsedMs).toBeGreaterThanOrEqual(3000);
	});

	it("re-dispatches a run that is stuck queued and adopts the new one", async () => {
		const clock = fakeClock();
		const stuck = run({ id: 1 });
		const adopted = run({
			id: 2,
			created_at: new Date(BASE).toISOString(),
			html_url: "https://example.test/run/2",
		});
		let dispatches = 0;
		let byIdCalls = 0;
		const logs = [];
		const result = await waitForCiPublish({
			...baseArgs(),
			now: clock.now,
			sleep: clock.sleep,
			log: (line) => logs.push(line),
			dispatchStuck: async () => {
				dispatches++;
				return adopted;
			},
			probes: {
				findWorkflowRun: () => stuck,
				workflowRunById: () => {
					byIdCalls++;
					return byIdCalls >= 2
						? { ...adopted, status: "completed", conclusion: "success" }
						: adopted;
				},
			},
		});

		expect(dispatches).toBe(1);
		expect(result.status).toBe("published");
		const text = logs.join("\n");
		expect(text).toContain("排队 120s 仍未开始");
		expect(text).toContain("已接管新的 run 2");
	});

	it("does not re-dispatch a run that is actually running", async () => {
		const clock = fakeClock();
		const running = run({
			id: 3,
			status: "in_progress",
			started_at: new Date(BASE - 100_000).toISOString(),
		});
		let dispatches = 0;
		let lookups = 0;
		const logs = [];
		const result = await waitForCiPublish({
			...baseArgs(),
			now: clock.now,
			sleep: clock.sleep,
			log: (line) => logs.push(line),
			dispatchStuck: async () => {
				dispatches++;
				return undefined;
			},
			probes: {
				findWorkflowRun: () => {
					lookups++;
					return lookups >= 3
						? { ...running, status: "completed", conclusion: "success" }
						: running;
				},
			},
		});

		expect(dispatches).toBe(0);
		expect(result.status).toBe("published");
		expect(logs.join("\n")).toContain("waiting: CI in_progress");
	});
});

describe("dispatch rescue", () => {
	const apiFor = (code, body) => {
		const calls = [];
		const api = (opts) => {
			calls.push(opts);
			return { code, body: body === undefined ? "" : JSON.stringify(body), error: "" };
		};
		api.calls = calls;
		return api;
	};

	it("posts the tag to workflow_dispatch", () => {
		const api = apiFor(204);
		const res = dispatchWorkflow({
			repo: "andares/pi-toolkits",
			token: "t",
			tag: "v0.14.0",
			ref: "master",
			api,
		});
		expect(res.ok).toBe(true);
		expect(api.calls[0]).toMatchObject({
			method: "POST",
			path: "/actions/workflows/publish.yml/dispatches",
			body: { ref: "master", inputs: { tag: "v0.14.0" } },
		});
	});

	it("reports a failed dispatch without throwing", () => {
		const res = dispatchWorkflow({
			repo: "andares/pi-toolkits",
			token: "t",
			tag: "v0.14.0",
			ref: "master",
			api: () => ({ code: 422, body: "", error: "" }),
		});
		expect(res.ok).toBe(false);
		expect(res.code).toBe(422);
	});

	it("picks the newest dispatched run of the right branch and window", () => {
		const runs = [
			{
				id: 9,
				event: "workflow_dispatch",
				head_branch: "master",
				created_at: new Date(BASE + 5000).toISOString(),
			},
			{
				id: 8,
				event: "workflow_dispatch",
				head_branch: "master",
				created_at: new Date(BASE - 600_000).toISOString(),
			},
			{
				id: 7,
				event: "workflow_dispatch",
				head_branch: "other",
				created_at: new Date(BASE + 5000).toISOString(),
			},
		];
		const found = findDispatchedRun({
			repo: "andares/pi-toolkits",
			token: "t",
			ref: "master",
			since: BASE,
			api: () => ({ code: 200, body: JSON.stringify({ workflow_runs: runs }) }),
		});
		expect(found?.id).toBe(9);
	});

	it("returns the adopted run, or undefined when the dispatch fails", async () => {
		const ok = createDispatchRescue({
			repo: "andares/pi-toolkits",
			token: "t",
			tag: "v0.14.0",
			ref: "master",
			now: () => BASE,
			pollMs: 0,
			api: (opts) => {
				if (opts.method === "POST") return { code: 204, body: "", error: "" };
				return {
					code: 200,
					body: JSON.stringify({
						workflow_runs: [
							{
								id: 42,
								event: "workflow_dispatch",
								head_branch: "master",
								created_at: new Date(BASE).toISOString(),
							},
						],
					}),
					error: "",
				};
			},
		});
		expect((await ok())?.id).toBe(42);

		const lines = [];
		const failed = createDispatchRescue({
			repo: "andares/pi-toolkits",
			token: "t",
			tag: "v0.14.0",
			ref: "master",
			api: () => ({ code: 403, body: "", error: "Resource not accessible" }),
			onLog: (line) => lines.push(line),
		});
		expect(await failed()).toBeUndefined();
		expect(lines.join("\n")).toContain("HTTP 403");
	});
});
