/**
 * Watch the tag-triggered publish workflow and verify what it produced.
 *
 * Why this exists: publishing moved from "this machine runs pnpm publish" to
 * "push the tag, CI publishes with OIDC trusted publishing". That split makes
 * the local script a supervisor instead of a publisher — and it must not claim
 * success until the registry actually has the version and the provenance
 * attestation. A tag push that silently failed in CI is exactly the state that
 * used to be impossible (the publish was the last thing we did).
 *
 * Everything here is read-only against npm/GitHub, with one exception:
 * `createDispatchRescue` may re-dispatch the same tag's workflow when the
 * tag-triggered run is stuck in `queued` (see below).
 *
 * Two hard-won details about *waiting* live here, both measured on this repo:
 *
 * 1. **Probe the registry over HTTP, not `npm view`.** `npm view` costs a child
 *    process (1–2 s on WSL); polling it every 5 s made the loop slower than the
 *    thing it waited on. The registry serves `/<name>/<version>` in ~100 ms, so
 *    the loop can poll every 1.5 s and still cost nothing. `npm view` remains as
 *    the authoritative cross-check (once every 30 s, and always when HTTP is
 *    unavailable), because it is the client npm itself uses.
 * 2. **Say which phase you are waiting in.** The old loop printed one
 *    throttled-to-30 s line for the whole duration, so "CI finished 40 s ago and
 *    npm's read replica has not caught up" looked exactly like "CI is stuck" —
 *    v0.14.0 spent ~2 min in that state and read as a hung workflow. Phases are
 *    now named (run missing / queued / running / CI green, waiting for the
 *    registry) and carry `t=Ns`.
 *
 * GitHub flakiness, observed on this repo (v0.13.0 → run 43096640287): a
 * tag-push run can sit in `queued` forever with `started_at` empty, never
 * starting and never failing. Waiting cannot fix that, so a run that has been
 * queued past `queuedGraceMs` (default 60 s, while a healthy one starts in ~3 s)
 * triggers ONE `workflow_dispatch` for the same tag, and the loop adopts the
 * new run. Worst case is a redundant run that skips itself because the version
 * is already published; the alternative is a release that waits 15 minutes to
 * time out.
 */
import { spawnSync } from "node:child_process";
import { githubApi, parseJson } from "./github-release.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Conclusions that mean "this run will never publish anything". */
const BAD_CONCLUSIONS = new Set([
	"failure",
	"cancelled",
	"timed_out",
	"startup_failure",
]);

/** Registry id for a package name (scoped names use `%2f`). */
function registryId(name) {
	return name.replace("/", "%2f");
}

/** `GET https://registry.npmjs.org/<name>/<version>`. */
export function registryVersionUrl(name, version) {
	return `https://registry.npmjs.org/${registryId(name)}/${version}`;
}

/** `GET https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>`. */
export function registryAttestationsUrl(name, version) {
	return `https://registry.npmjs.org/-/npm/v1/attestations/${registryId(name)}@${version}`;
}

/** Fetch without throwing: returns the response, or undefined on any failure. */
async function tryFetch(url, { fetchImpl, timeoutMs, accept } = {}) {
	const fetchFn = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
	if (typeof fetchFn !== "function") return undefined;
	const signal =
		typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
			? AbortSignal.timeout(timeoutMs ?? 5000)
			: undefined;
	try {
		return await fetchFn(url, {
			headers: { accept: accept ?? "application/json" },
			signal,
		});
	} catch {
		return undefined;
	}
}

/**
 * Is `<name>@<version>` in the registry? The fast path of the wait loop.
 *
 * Returns `true` / `false` (the registry answered) or `undefined` (it did not:
 * offline, proxy, 5xx, CDN weirdness). `undefined` must never be read as
 * "absent" — the caller falls back to `npm view` instead of staying blind.
 */
export async function fetchPublishedVersion({
	name,
	version,
	fetchImpl,
	timeoutMs = 5000,
}) {
	const res = await tryFetch(registryVersionUrl(name, version), {
		fetchImpl,
		timeoutMs,
	});
	if (!res) return undefined;
	try {
		// Drain the body so the connection is reusable; only presence matters.
		await res.arrayBuffer?.();
	} catch {
		// ignore: a truncated body cannot change the status code
	}
	if (res.status === 200) return true;
	if (res.status === 404) return false;
	return undefined;
}

/**
 * Provenance attestations for a version, or `undefined` when the registry did
 * not answer. `[]` means "answered: nothing there yet".
 */
export async function fetchAttestations({
	name,
	version,
	fetchImpl,
	timeoutMs = 5000,
}) {
	const res = await tryFetch(registryAttestationsUrl(name, version), {
		fetchImpl,
		timeoutMs,
	});
	if (!res) return undefined;
	if (res.status === 404) return [];
	if (res.status !== 200) return undefined;
	try {
		const data = await res.json();
		const entries = Array.isArray(data?.attestations) ? data.attestations : [];
		return entries.map((entry) => ({
			url: registryAttestationsUrl(name, version),
			predicateType: entry?.predicateType,
		}));
	} catch {
		return undefined;
	}
}

/** Is `<name>@<version>` present in the registry? (Inexact while npm scans.) */
export function npmVersionPublished({ npm = "npm", name, version, cwd }) {
	const res = spawnSync(npm, ["view", `${name}@${version}`, "version"], {
		cwd,
		encoding: "utf8",
		stdio: "pipe",
		timeout: 60_000,
	});
	return res.status === 0 && res.stdout.trim() === version;
}

/** Provenance/attestation entries for a published version ([] when none). */
export function npmAttestations({ npm = "npm", name, version, cwd }) {
	const res = spawnSync(
		npm,
		["view", `${name}@${version}`, "dist.attestations", "--json"],
		{ cwd, encoding: "utf8", stdio: "pipe", timeout: 60_000 },
	);
	if (res.status !== 0) return [];
	const data = parseJson(res.stdout.trim());
	return Array.isArray(data) ? data : [];
}

/**
 * List the runs of a workflow. `query` is passed through verbatim, so callers
 * use the exact filter they need (head_sha for a tag push, event+branch for a
 * dispatch) instead of filtering a mixed list afterwards.
 */
function listRuns({ repo, token, workflow, query, curl, api = githubApi }) {
	const res = api({
		curl,
		repo,
		token,
		path: `/actions/workflows/${workflow}/runs?${query}`,
	});
	if (res.code !== 200) return [];
	const data = parseJson(res.body);
	if (!data || !Array.isArray(data.workflow_runs)) return [];
	return data.workflow_runs;
}

/**
 * Newest workflow run for a commit, or undefined while GitHub has not created
 * it yet. Read-only and token-optional (unauthenticated reads work on public
 * repos; a token is used when present just for the rate limit).
 *
 * Only runs whose head_sha equals `sha` are considered. Falling back to
 * "whatever runs exist" would attribute a failure on an unrelated commit to
 * this release — and head_sha-filtered listings are already exact on GitHub,
 * so a non-matching entry can only be stale/unrelated.
 */
export function findWorkflowRun({
	repo,
	token,
	workflow = "publish.yml",
	sha,
	curl,
	api,
}) {
	const matching = listRuns({
		repo,
		token,
		workflow,
		query: `head_sha=${sha}&per_page=10`,
		curl,
		api,
	}).filter((run) => run.head_sha === sha);
	if (matching.length === 0) return undefined;
	return matching
		.slice()
		.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

/** One run by id — used to keep tracking a run whose head_sha no longer matches. */
export function fetchWorkflowRunById({ repo, token, runId, curl, api = githubApi }) {
	const res = api({ curl, repo, token, path: `/actions/runs/${runId}` });
	if (res.code !== 200) return undefined;
	return parseJson(res.body);
}

/**
 * Ask GitHub to run the publish workflow for `tag` from `ref`.
 * `workflow_dispatch` answers 204 with an empty body on success.
 */
export function dispatchWorkflow({
	repo,
	token,
	workflow = "publish.yml",
	tag,
	ref,
	curl,
	api = githubApi,
}) {
	const res = api({
		curl,
		repo,
		token,
		method: "POST",
		path: `/actions/workflows/${workflow}/dispatches`,
		body: { ref, inputs: { tag } },
	});
	return {
		ok: res.code === 204 || res.code === 201,
		code: res.code,
		error: res.error,
	};
}

/**
 * The `workflow_dispatch` run we just created. A dispatch run's head_sha is the
 * ref's head, which is NOT guaranteed to equal the tag's commit (master may
 * have moved on), so it is found by `event` + `branch` + creation time instead
 * of by sha. The window is generous backwards because GitHub's own timestamps
 * can land a couple of seconds before our dispatch call.
 */
export function findDispatchedRun({
	repo,
	token,
	workflow = "publish.yml",
	ref,
	since,
	curl,
	api,
	toleranceMs = 20_000,
}) {
	const floor = Number.isFinite(since) ? since - toleranceMs : 0;
	return listRuns({
		repo,
		token,
		workflow,
		query: `event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=10`,
		curl,
		api,
	})
		.filter(
			(run) =>
				run.event === "workflow_dispatch" &&
				run.head_branch === ref &&
				Date.parse(run.created_at ?? "") >= floor,
		)
		.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

/**
 * Build the "the run is a zombie, re-dispatch it" callback passed to
 * `waitForCiPublish` as `dispatchStuck`. Returns the adopted run, or undefined
 * when the dispatch failed (the caller then keeps waiting on the original).
 */
export function createDispatchRescue({
	repo,
	token,
	workflow = "publish.yml",
	tag,
	ref,
	curl,
	api,
	now = Date.now,
	pollMs = 2000,
	pollAttempts = 8,
	onLog = () => {},
}) {
	return async () => {
		const since = now();
		const dispatched = dispatchWorkflow({ repo, token, workflow, tag, ref, curl, api });
		if (!dispatched.ok) {
			onLog(
				`  ↳ workflow_dispatch 失败（HTTP ${dispatched.code || "?"}${
					dispatched.error ? `：${dispatched.error}` : ""
				}）——只能继续等原来的 run`,
			);
			return undefined;
		}
		for (let attempt = 0; attempt < pollAttempts; attempt++) {
			const found = findDispatchedRun({ repo, token, workflow, ref, since, curl, api });
			if (found) return found;
			await sleep(pollMs);
		}
		return undefined;
	};
}

/** `now - Date.parse(stamp)`, or undefined when the stamp is unusable. */
function msSince(stamp, now) {
	const parsed = Date.parse(stamp ?? "");
	if (!Number.isFinite(parsed)) return undefined;
	return now - parsed;
}

/**
 * Poll until the version is on npm, the run fails, or the timeout expires.
 *
 * Returns `{ status, run, elapsedMs }` with status one of
 *   published | failed | timeout
 * `failed` is decided from the workflow run (so we can name the run URL);
 * registry lag after a green run is `timeout`, which is not a publish failure
 * but must still be reported honestly.
 *
 * Cadence: registry over HTTP every `intervalMs` (1.5 s), GitHub every
 * `runCheckEveryMs` (10 s — REST reads are rate-limited), `npm view` every
 * `npmRecheckEveryMs` (30 s) as the authoritative cross-check. Progress is
 * printed on phase change and at least every `logEveryMs`, always naming the
 * phase and the elapsed time.
 */
export async function waitForCiPublish({
	repo,
	token,
	workflow = "publish.yml",
	sha,
	name,
	version,
	npm = "npm",
	cwd,
	curl,
	fetchImpl,
	timeoutMs = 15 * 60_000,
	intervalMs = 1500,
	runCheckEveryMs = 10_000,
	npmRecheckEveryMs = 30_000,
	npmFallbackMs = 10_000,
	queuedGraceMs = 60_000,
	dispatchStuck,
	logEveryMs = 15_000,
	probes = {},
	now = Date.now,
	sleep: wait = sleep,
	log = console.log,
}) {
	const findRun = probes.findWorkflowRun ?? findWorkflowRun;
	const getRun = probes.workflowRunById ?? fetchWorkflowRunById;
	const npmProbe = probes.npmVersionPublished ?? npmVersionPublished;
	const httpProbe = probes.publishedVersion ?? fetchPublishedVersion;

	const started = now();
	const elapsed = () => now() - started;
	const secs = (ms) => Math.round(ms / 1000);

	let run;
	/** Set when we adopt a dispatched run: track it by id, not by head_sha. */
	let pinnedRunId;
	let rescueTried = false;
	let lastRunCheck = Number.NEGATIVE_INFINITY;
	let lastNpmCheck = Number.NEGATIVE_INFINITY;
	let lastLog = Number.NEGATIVE_INFINITY;
	let lastPhase = "";
	/** When the tracked run turned green — registry wait is measured from here. */
	let greenAt;

	const phase = () => {
		if (!run) return "discovering";
		if (run.status === "completed") return "registry";
		if (run.status === "queued") return "queued";
		return "running";
	};

	const describe = () => {
		const t = `t=${secs(elapsed())}s`;
		if (!run) return `  waiting: workflow run 还没出现（${t}）`;
		if (run.status === "completed") {
			const lag = greenAt === undefined ? "" : `，run 绿了 ${secs(now() - greenAt)}s 了`;
			return (
				`  waiting: CI 已绿（${t}${lag}），registry 还没吐 ${name}@${version}` +
				` —— 这段是 npm 的传播延迟，不是 CI 卡住`
			);
		}
		const suffix = run.html_url ? ` — ${run.html_url}` : "";
		return `  waiting: CI ${run.status}（${t}）${suffix}`;
	};

	for (;;) {
		// 1. The registry is the only signal that means "done".
		const http = await httpProbe({ name, version, fetchImpl });
		if (http === true) return { status: "published", run, elapsedMs: elapsed() };
		const npmDue =
			http === undefined
				? now() - lastNpmCheck >= npmFallbackMs
				: now() - lastNpmCheck >= npmRecheckEveryMs;
		if (npmDue) {
			lastNpmCheck = now();
			if (npmProbe({ npm, name, version, cwd })) {
				return { status: "published", run, elapsedMs: elapsed() };
			}
		}

		// 2. The workflow run, read sparsely.
		if (now() - lastRunCheck >= runCheckEveryMs) {
			lastRunCheck = now();
			const found = pinnedRunId
				? getRun({ repo, token, runId: pinnedRunId, curl })
				: findRun({ repo, token, workflow, sha, curl });
			run = found ?? run;
			if (!run) {
				greenAt = undefined;
			} else if (run.status === "completed") {
				greenAt ??= now();
			} else {
				greenAt = undefined;
			}
		}

		// 3. A finished run decides failure immediately (a red run will never
		//    put the version on npm, so waiting out the timeout is pointless).
		if (run && BAD_CONCLUSIONS.has(run.conclusion)) {
			return { status: "failed", run, elapsedMs: elapsed() };
		}

		// 4. A run that never starts needs a human-equivalent kick: re-dispatch.
		const queuedFor = run ? msSince(run.created_at, now()) : undefined;
		if (
			!rescueTried &&
			typeof dispatchStuck === "function" &&
			run &&
			run.status === "queued" &&
			!run.started_at &&
			queuedFor !== undefined &&
			queuedFor >= queuedGraceMs
		) {
			rescueTried = true;
			log(
				`  ⚠ run ${run.id ?? "?"} 排队 ${secs(queuedFor)}s 仍未开始（正常是几秒）` +
					` —— 补发 workflow_dispatch，tag 输入不变`,
			);
			const adopted = await dispatchStuck();
			if (adopted && adopted.id) {
				run = adopted;
				pinnedRunId = adopted.id;
				greenAt = undefined;
				lastRunCheck = Number.NEGATIVE_INFINITY; // refresh the new run next tick
				log(
					`  ↳ 已接管新的 run ${adopted.id}` +
						(adopted.html_url ? ` — ${adopted.html_url}` : ""),
				);
			} else {
				log("  ↳ 补发没有拿到可跟踪的 run，继续等原来的 run");
			}
		}

		// 5. Progress: name the phase, not just "waiting".
		const current = phase();
		if (current !== lastPhase || now() - lastLog >= logEveryMs) {
			lastPhase = current;
			lastLog = now();
			log(describe());
		}

		if (elapsed() >= timeoutMs) {
			return { status: "timeout", run, elapsedMs: elapsed() };
		}
		await wait(intervalMs);
	}
}

/**
 * Provenance attestations can trail the version by a few seconds; poll briefly
 * instead of reporting a false negative. HTTP first (cheap), `npm view` only
 * when the registry does not answer.
 */
export async function waitForAttestations({
	npm = "npm",
	name,
	version,
	cwd,
	fetchImpl,
	timeoutMs = 120_000,
	intervalMs = 5000,
	fallbackEveryMs = 15_000,
	now = Date.now,
	sleep: wait = sleep,
}) {
	const started = now();
	let lastFallback = Number.NEGATIVE_INFINITY;
	for (;;) {
		const http = await fetchAttestations({ name, version, fetchImpl });
		if (http && http.length > 0) return http;
		if (http === undefined && now() - lastFallback >= fallbackEveryMs) {
			lastFallback = now();
			const entries = npmAttestations({ npm, name, version, cwd });
			if (entries.length > 0) return entries;
		}
		if (now() - started >= timeoutMs) return [];
		await wait(intervalMs);
	}
}
