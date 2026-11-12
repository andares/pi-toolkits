/**
 * Release-wait tests.
 *
 * The wait loop is the part of `pnpm release` a human stares at, and it is the
 * part that was slow and misleading (a 5 s `npm view` spawn per iteration, one
 * message throttled to 30 s, and no way to tell "CI finished, npm lags" from
 * "CI is stuck"). So its decisions are pinned here:
 *
 *   - registry present → published, without ever spawning `npm view`;
 *   - registry unreachable → `npm view` fallback, not silence;
 *   - red run → failed immediately with the run attached;
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
	fetchAttestations,
	fetchPublishedVersion,
	findDispatchedRun,
	registryAttestationsUrl,
	registryVersionUrl,
	waitForAttestations,
	waitForCiPublish,
} from "./ci-publish.mjs";

const NAME = "@andares/pi-toolkits";
const VERSION = "0.14.0";
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

describe("registry URLs", () => {
	it("encodes the slash of a scoped name", () => {
		expect(registryVersionUrl(NAME, VERSION)).toBe(
			"https://registry.npmjs.org/@andares%2fpi-toolkits/0.14.0",
		);
		expect(registryAttestationsUrl(NAME, VERSION)).toBe(
			"https://registry.npmjs.org/-/npm/v1/attestations/@andares%2fpi-toolkits@0.14.0",
		);
	});

	it("leaves an unscoped name alone", () => {
		expect(registryVersionUrl("left-pad", "1.0.0")).toBe(
			"https://registry.npmjs.org/left-pad/1.0.0",
		);
	});
});

describe("fetchPublishedVersion", () => {
	const answer = (status) => async () => ({
		status,
		arrayBuffer: async () => new ArrayBuffer(0),
	});

	it("is true on 200 and false on 404", async () => {
		expect(await fetchPublishedVersion({ name: NAME, version: VERSION, fetchImpl: answer(200) })).toBe(true);
		expect(await fetchPublishedVersion({ name: NAME, version: VERSION, fetchImpl: answer(404) })).toBe(false);
	});

	it("is unknown (undefined) when the registry does not answer", async () => {
		expect(await fetchPublishedVersion({ name: NAME, version: VERSION, fetchImpl: answer(503) })).toBeUndefined();
		expect(
			await fetchPublishedVersion({
				name: NAME,
				version: VERSION,
				fetchImpl: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		).toBeUndefined();
		expect(await fetchPublishedVersion({ name: NAME, version: VERSION, fetchImpl: null })).toBeUndefined();
	});
});

describe("fetchAttestations", () => {
	it("maps the registry payload and keeps [] for 404", async () => {
		const found = await fetchAttestations({
			name: NAME,
			version: VERSION,
			fetchImpl: async () => ({
				status: 200,
				json: async () => ({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1" }] }),
			}),
		});
		expect(found).toEqual([
			{
				url: registryAttestationsUrl(NAME, VERSION),
				predicateType: "https://slsa.dev/provenance/v1",
			},
		]);
		expect(
			await fetchAttestations({
				name: NAME,
				version: VERSION,
				fetchImpl: async () => ({ status: 404, json: async () => ({}) }),
			}),
		).toEqual([]);
	});
});

describe("waitForCiPublish", () => {
	// Every probe must be faked: the loop's real `npm view` would find the
	// published 0.14.0 on this machine and short-circuit the whole test.
	const mkProbes = (overrides) => ({
		publishedVersion: async () => false,
		npmVersionPublished: () => false,
		findWorkflowRun: () => undefined,
		...overrides,
	});

	const baseArgs = () => ({
		repo: "andares/pi-toolkits",
		token: "t",
		sha: "aaa",
		name: NAME,
		version: VERSION,
		intervalMs: 1000,
		runCheckEveryMs: 1000,
		npmRecheckEveryMs: 1000,
		npmFallbackMs: 1000,
		logEveryMs: 60_000,
		log: () => {},
	});

	it("reports published from the registry without spawning npm view", async () => {
		const clock = fakeClock();
		let npmCalls = 0;
		const result = await waitForCiPublish({
			...baseArgs(),
			now: clock.now,
			sleep: clock.sleep,
			probes: mkProbes({
				publishedVersion: async () => true,
				npmVersionPublished: () => {
					npmCalls++;
					return false;
				},
			}),
		});
		expect(result.status).toBe("published");
		expect(npmCalls).toBe(0);
		expect(result.elapsedMs).toBe(0);
	});

	it("falls back to npm view when the registry is unreachable", async () => {
		const clock = fakeClock();
		let npmCalls = 0;
		const result = await waitForCiPublish({
			...baseArgs(),
			now: clock.now,
			sleep: clock.sleep,
			probes: mkProbes({
				publishedVersion: async () => undefined,
				npmVersionPublished: () => {
					npmCalls++;
					return npmCalls >= 2;
				},
			}),
		});
		expect(result.status).toBe("published");
		expect(npmCalls).toBe(2);
	});

	it("fails as soon as the run is red, naming the run", async () => {
		const clock = fakeClock();
		const red = run({ id: 7, status: "completed", conclusion: "failure" });
		const result = await waitForCiPublish({
			...baseArgs(),
			now: clock.now,
			sleep: clock.sleep,
			probes: mkProbes({
				publishedVersion: async () => false,
				findWorkflowRun: () => red,
			}),
		});
		expect(result.status).toBe("failed");
		expect(result.run?.html_url).toBe(red.html_url);
	});

	it("times out when nothing ever happens", async () => {
		const clock = fakeClock();
		const result = await waitForCiPublish({
			...baseArgs(),
			timeoutMs: 3000,
			now: clock.now,
			sleep: clock.sleep,
			probes: mkProbes({}),
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
			probes: mkProbes({
				// Registry only catches up after the adopted run is green.
				publishedVersion: async () => byIdCalls >= 3,
				findWorkflowRun: () => stuck,
				workflowRunById: () => {
					byIdCalls++;
					return byIdCalls >= 2
						? { ...adopted, status: "completed", conclusion: "success" }
						: adopted;
				},
			}),
		});

		expect(dispatches).toBe(1);
		expect(result.status).toBe("published");
		const text = logs.join("\n");
		expect(text).toContain("排队 120s 仍未开始");
		expect(text).toContain("已接管新的 run 2");
		// The waiting state names the registry lag instead of looking hung.
		expect(text).toContain("npm 的传播延迟");
	});

	it("does not re-dispatch a run that is actually running", async () => {
		const clock = fakeClock();
		const running = run({
			id: 3,
			status: "in_progress",
			started_at: new Date(BASE - 100_000).toISOString(),
		});
		let dispatches = 0;
		let probes = 0;
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
			probes: mkProbes({
				publishedVersion: async () => ++probes >= 3,
				findWorkflowRun: () => running,
			}),
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

describe("waitForAttestations", () => {
	it("returns the registry attestations without spawning npm", async () => {
		const clock = fakeClock();
		// `npm` is a binary that cannot exist: reaching the fallback would be a
		// regression, and this makes it fail loudly instead of quietly.
		const entries = await waitForAttestations({
			name: NAME,
			version: VERSION,
			cwd: "/tmp",
			now: clock.now,
			sleep: clock.sleep,
			npm: "pnpm-no-such-npm-binary",
			fetchImpl: async () => ({
				status: 200,
				json: async () => ({ attestations: [{ predicateType: "x" }] }),
			}),
		});
		expect(entries).toHaveLength(1);
	});

	it("gives up after the timeout", async () => {
		const clock = fakeClock();
		const entries = await waitForAttestations({
			name: NAME,
			version: VERSION,
			cwd: "/tmp",
			now: clock.now,
			sleep: clock.sleep,
			timeoutMs: 20_000,
			intervalMs: 5000,
			fetchImpl: async () => ({ status: 404, json: async () => ({}) }),
		});
		expect(entries).toEqual([]);
	});
});
