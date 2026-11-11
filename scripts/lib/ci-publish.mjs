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
 * Everything here is read-only: npm registry queries and GitHub REST reads.
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
 * Newest workflow run for a commit, or undefined while GitHub has not created
 * it yet. Read-only and token-optional (unauthenticated reads work on public
 * repos; a token is used when present just for the rate limit).
 *
 * Only runs whose head_sha equals `sha` are considered. Falling back to
 * "whatever runs exist" would attribute a failure on an unrelated commit to
 * this release — and head_sha-filtered listings are already exact on GitHub,
 * so a non-matching entry can only be stale/unrelated.
 */
export function findWorkflowRun({ repo, token, workflow = "publish.yml", sha, curl }) {
	const api = githubApi({
		curl,
		repo,
		token,
		path: `/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=10`,
	});
	if (api.code !== 200) return undefined;
	const data = parseJson(api.body);
	if (!data || !Array.isArray(data.workflow_runs)) return undefined;
	const matching = data.workflow_runs.filter((run) => run.head_sha === sha);
	if (matching.length === 0) return undefined;
	return matching
		.slice()
		.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

/**
 * Poll until the version is on npm, the run fails, or the timeout expires.
 *
 * Returns `{ status, run, elapsedMs }` with status one of
 *   published | failed | timeout
 * `failed` is decided from the workflow run (so we can name the run URL);
 * registry lag after a green run is `timeout`, which is not a publish failure
 * but must still be reported honestly.
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
	timeoutMs = 15 * 60_000,
	intervalMs = 5000,
	runCheckEvery = 3,
	curl,
	log = console.log,
}) {
	const started = Date.now();
	let run;
	let attempt = 0;
	let lastNote = 0;

	const note = (text) => {
		if (Date.now() - lastNote < 30_000) return;
		lastNote = Date.now();
		log(text);
	};

	for (;;) {
		if (npmVersionPublished({ npm, name, version, cwd })) {
			return { status: "published", run, elapsedMs: Date.now() - started };
		}
		if (attempt % runCheckEvery === 0) {
			const found = findWorkflowRun({ repo, token, workflow, sha, curl });
			if (found) {
				run = found;
				if (BAD_CONCLUSIONS.has(found.conclusion)) {
					return { status: "failed", run, elapsedMs: Date.now() - started };
				}
			}
		}
		const elapsed = Date.now() - started;
		if (elapsed >= timeoutMs) {
			return { status: "timeout", run, elapsedMs: elapsed };
		}
		note(
			`  waiting: ${run ? `${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""} — ${run.html_url}` : "workflow run not visible yet"}`,
		);
		attempt++;
		await sleep(intervalMs);
	}
}

/**
 * Provenance attestations can trail the version by a few seconds; poll briefly
 * instead of reporting a false negative.
 */
export async function waitForAttestations({
	npm = "npm",
	name,
	version,
	cwd,
	timeoutMs = 120_000,
	intervalMs = 10_000,
}) {
	const started = Date.now();
	for (;;) {
		const entries = npmAttestations({ npm, name, version, cwd });
		if (entries.length > 0) return entries;
		if (Date.now() - started >= timeoutMs) return [];
		await sleep(intervalMs);
	}
}
