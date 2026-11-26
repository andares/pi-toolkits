/**
 * Watch the tag-triggered publish workflow.
 *
 * Why this exists: publishing moved from "this machine runs pnpm publish" to
 * "push the tag, CI publishes with OIDC trusted publishing". That split makes
 * the local script a supervisor instead of a publisher, and a tag push that
 * failed in CI is exactly the state that used to be impossible (the publish was
 * the last thing we did).
 *
 * **The workflow run being green is the whole completion criterion.** An
 * earlier version kept polling the npm registry afterwards and refused to call
 * the release done until the version and its provenance attestation showed up
 * there. That was overreach: before Actions, `pnpm release` ran `pnpm publish`
 * and never asked npm whether it had "processed it well" either. Propagation and
 * scanning are npm's job, the package page is one click away, and the workflow
 * itself already skips an already-published version instead of failing — so
 * green is a trustworthy "this version is out".
 *
 * Two hard-won details about *waiting* live here, both measured on this repo:
 *
 * 1. **Say which phase you are waiting in.** The old loop printed one
 *    throttled-to-30 s line for the whole duration, so "the run has not been
 *    created yet" looked exactly like "the run is stuck". Phases are named
 *    (run missing / queued / running) and carry `t=Ns`.
 * 2. **Read GitHub sparsely** (`runCheckEveryMs`, default 10 s). The REST API is
 *    rate-limited and a publish run takes ~1 min, so a tighter loop buys
 *    nothing.
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
import { githubApi, parseJson } from "./github-release.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
 * Poll until the publish run finishes.
 *
 * Returns `{ status, run, elapsedMs, conclusion }` with status one of
 *   published | failed | timeout
 * `published` = the run completed successfully; that is the release's
 * completion criterion (see the header for why the registry is not consulted).
 * `failed` carries the conclusion so the caller can name what went wrong
 * instead of only saying "red".
 */
export async function waitForCiPublish({
	repo,
	token,
	workflow = "publish.yml",
	sha,
	curl,
	timeoutMs = 15 * 60_000,
	runCheckEveryMs = 10_000,
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

	const started = now();
	const elapsed = () => now() - started;
	const secs = (ms) => Math.round(ms / 1000);

	let run;
	/** Set when we adopt a dispatched run: track it by id, not by head_sha. */
	let pinnedRunId;
	let rescueTried = false;
	let lastRunCheck = Number.NEGATIVE_INFINITY;
	let lastLog = Number.NEGATIVE_INFINITY;
	let lastPhase = "";

	const phase = () => {
		if (!run) return "discovering";
		return run.status === "completed" ? "completed" : run.status;
	};

	const describe = () => {
		const t = `t=${secs(elapsed())}s`;
		if (!run) return `  waiting: workflow run 还没出现（${t}）`;
		const suffix = run.html_url ? ` — ${run.html_url}` : "";
		return `  waiting: CI ${run.status}（${t}）${suffix}`;
	};

	for (;;) {
		// 1. The workflow run, read sparsely.
		if (now() - lastRunCheck >= runCheckEveryMs) {
			lastRunCheck = now();
			const found = pinnedRunId
				? getRun({ repo, token, runId: pinnedRunId, curl })
				: findRun({ repo, token, workflow, sha, curl });
			run = found ?? run;
		}

		// 2. A finished run decides, either way. Anything but `success` means the
		//    version is not out, so there is nothing left to wait for.
		if (run && run.status === "completed") {
			if (run.conclusion === "success") {
				return { status: "published", run, elapsedMs: elapsed() };
			}
			return {
				status: "failed",
				run,
				elapsedMs: elapsed(),
				conclusion: run.conclusion,
			};
		}

		// 3. A run that never starts needs a human-equivalent kick: re-dispatch.
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
				lastRunCheck = Number.NEGATIVE_INFINITY; // refresh the new run next tick
				log(
					`  ↳ 已接管新的 run ${adopted.id}` +
						(adopted.html_url ? ` — ${adopted.html_url}` : ""),
				);
			} else {
				log("  ↳ 补发没有拿到可跟踪的 run，继续等原来的 run");
			}
		}

		// 4. Progress: name the phase, not just "waiting".
		const current = phase();
		if (current !== lastPhase || now() - lastLog >= logEveryMs) {
			lastPhase = current;
			lastLog = now();
			log(describe());
		}

		if (elapsed() >= timeoutMs) {
			return { status: "timeout", run, elapsedMs: elapsed() };
		}
		await wait(runCheckEveryMs);
	}
}
