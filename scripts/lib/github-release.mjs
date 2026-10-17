/**
 * Shared GitHub-release plumbing for the release scripts.
 *
 * Why this exists: creating the GitHub Release used to be a tail step of
 * `pnpm release <bump>`, with no way back. Any skip — an `ls-remote` that
 * raced GitHub's ref visibility (observed at v0.7.3), a missing token, a
 * failed push, an HTTP hiccup — left that version without a Release, and the
 * only documented recovery ("重跑本脚本") was a lie: `pnpm release` always
 * bumps again, publishing a NEW version instead. Meanwhile
 * `generate_release_notes` diffs against the last published Release, so the
 * next version's notes swallow the missing one's commits and GitHub's version
 * line silently drifts away from npm's.
 *
 * So the Release step lives here, in a form both callers share:
 *   - `pnpm release <bump>`  — the tail of a publication (publish.mjs)
 *   - `pnpm release:github`  — resume/backfill for a tag that already exists
 *
 * Two behaviours matter and are tested by use, not by faith:
 *   - the remote tag is verified with BOUNDED RETRIES (visibility lag is
 *     expected right after a push, not an error), and "tag absent" is kept
 *     distinct from "tag points somewhere else";
 *   - creation is idempotent and never creates a Release for a tag whose
 *     remote ref does not match the commit we verified locally.
 */
import { spawnSync } from "node:child_process";

export const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

const API_VERSION = "2022-11-28";

/** Minimal git wrapper: `out` throws on failure, `try` returns the result. */
export function gitToolkit({ cwd, git = process.platform === "win32" ? "git.exe" : "git" }) {
	const run = (args, opts = {}) =>
		spawnSync(git, args, { cwd, encoding: "utf8", ...opts });
	return {
		run,
		out(args) {
			const res = run(args);
			if (res.status !== 0) {
				throw new Error(
					`git ${args.join(" ")} failed: ${(res.stderr || res.stdout || "").trim()}`,
				);
			}
			return res.stdout.trim();
		},
		try(args) {
			return run(args);
		},
	};
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A single GitHub REST call through curl (no token → unauthenticated, which is
 * fine for public repos and rate-limited accordingly).
 * Returns `{ ok, code, body, error }`; `body` is raw text, parsed lazily.
 */
export function githubApi({ curl = "curl", repo, token, method = "GET", path, body }) {
	const args = [
		"-sS",
		"-X",
		method,
		"-H",
		"Accept: application/vnd.github+json",
		"-H",
		`X-GitHub-Api-Version: ${API_VERSION}`,
	];
	if (token) args.push("-H", `Authorization: Bearer ${token}`);
	args.push("-w", "\n%{http_code}");
	if (body !== undefined) args.push("-d", JSON.stringify(body));
	args.push(`https://api.github.com/repos/${repo}${path}`);
	const res = spawnSync(curl, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	const raw = (res.stdout ?? "").trimEnd();
	const split = raw.lastIndexOf("\n");
	const text = split === -1 ? "" : raw.slice(0, split);
	const code = Number.parseInt(split === -1 ? raw : raw.slice(split + 1), 10);
	return {
		ok: res.status === 0,
		code: Number.isNaN(code) ? 0 : code,
		body: text,
		error: (res.error && res.error.message) || (res.stderr ?? "").trim(),
	};
}

export function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Read a remote tag ref, retrying while GitHub's ref view catches up.
 * Returns `{ sha, attempts, state }` where state is "match" | "mismatch" |
 * "absent" — the three outcomes the caller must keep apart.
 */
export async function resolveRemoteTag({
	git,
	tag,
	expectSha,
	attempts = 5,
	delayMs = 2000,
	onWait,
}) {
	let sha = "";
	let tries = 0;
	for (; tries < attempts; tries++) {
		const res = git.try(["ls-remote", "origin", `refs/tags/${tag}`]);
		sha = (res.stdout ?? "").trim().split(/\s+/)[0] ?? "";
		if (sha === expectSha) return { sha, attempts: tries + 1, state: "match" };
		if (tries < attempts - 1) {
			if (onWait) onWait({ attempt: tries + 1, attempts, absent: sha === "" });
			await sleep(delayMs * 2 ** tries);
		}
	}
	return { sha, attempts: tries, state: sha === "" ? "absent" : "mismatch" };
}

/**
 * Create the GitHub Release for `tag`, idempotently, and only after the tag's
 * remote ref has been verified against the commit we measured locally.
 *
 * Returns `{ status, url, sha, detail }` with status one of:
 *   created | exists | draft | mismatch | absent | http-error | no-token
 */
export async function syncGitHubRelease({
	cwd,
	repo,
	token,
	tag,
	curl = "curl",
	git = process.platform === "win32" ? "git.exe" : "git",
	push = true,
	dryRun = false,
	log = console.log,
	warn = console.warn,
	attempts = 5,
	delayMs = 2000,
}) {
	const g = gitToolkit({ cwd, git });
	let localSha;
	try {
		localSha = g.out(["rev-parse", `refs/tags/${tag}`]);
	} catch {
		return { status: "missing-local-tag", detail: tag };
	}
	log(`${C.dim}local tag ${tag} → ${localSha.slice(0, 7)}${C.reset}`);

	let remote = await resolveRemoteTag({
		git: g,
		tag,
		expectSha: localSha,
		attempts,
		delayMs,
		onWait: ({ attempt, attempts: total, absent }) =>
			log(
				`${C.dim}  ${absent ? "tag not visible remotely yet" : "remote tag differs so far"} — retry ${attempt + 1}/${total}${C.reset}`,
			),
	});
	if (remote.state !== "match" && remote.state === "absent" && push) {
		if (dryRun) {
			log(`${C.yellow}--dry-run: would push refs/tags/${tag}${C.reset}`);
			return { status: "absent", detail: "dry-run", sha: localSha };
		}
		log(`${C.dim}  pushing refs/tags/${tag}${C.reset}`);
		const pushed = g.try(["push", "origin", `refs/tags/${tag}`]);
		if (pushed.status !== 0) {
			warn(
				`${C.yellow}git push origin refs/tags/${tag} 失败：` +
					`${(pushed.stderr || pushed.stdout || "").trim()}${C.reset}`,
			);
		}
		remote = await resolveRemoteTag({
			git: g,
			tag,
			expectSha: localSha,
			attempts,
			delayMs,
			onWait: ({ attempt, attempts: total, absent }) =>
				log(
					`${C.dim}  ${absent ? "tag not visible remotely yet" : "remote tag differs so far"} — retry ${attempt + 1}/${total}${C.reset}`,
				),
		});
	}
	if (remote.state !== "match") {
		const detail = `${remote.state} (remote ${remote.sha ? remote.sha.slice(0, 7) : "不存在"}, local ${localSha.slice(0, 7)})`;
		warn(
			`${C.red}远端 tag ${tag} 校验未通过：${detail}，共重试 ${remote.attempts} 次。` +
				`\n  远端不存在 → git push origin refs/tags/${tag}` +
				`\n  远端指向别的提交 → 人工确认后用 git push origin refs/tags/${tag} --force` +
				`\n  刚推完就看不见属于 GitHub ref 可见性竞态，稍等再跑一次本命令即可。` +
				`\n  未创建 Release——Release 必须指向已核实的 tag。${C.reset}`,
		);
		return { status: remote.state, detail, sha: localSha };
	}
	log(`${C.green}remote tag ${tag} 校验通过 → ${localSha.slice(0, 7)}${C.reset}`);

	if (!token) {
		warn(
			`${C.yellow}未设置 GITHUB_TOKEN — 跳过 GitHub Release（tag 已核实，可稍后带 token 重跑）。${C.reset}`,
		);
		return { status: "no-token", sha: localSha };
	}
	if (dryRun) {
		log(`${C.yellow}--dry-run: would create/verify Release ${tag}${C.reset}`);
		return { status: "exists", detail: "dry-run", sha: localSha };
	}

	const existing = githubApi({ curl, repo, token, path: `/releases/tags/${tag}` });
	if (existing.code === 200) {
		const data = parseJson(existing.body);
		if (data && data.draft) {
			warn(
				`${C.red}Release ${tag} 已存在但是 DRAFT（草稿不公开）——请到 GitHub 手动发布。${C.reset}`,
			);
			return { status: "draft", url: data.html_url, sha: localSha };
		}
		log(
			`${C.green}GitHub Release ${tag} 已存在，跳过（幂等）${C.reset}` +
				(data && data.html_url ? `\n  ${C.dim}${data.html_url}${C.reset}` : ""),
		);
		return { status: "exists", url: data && data.html_url, sha: localSha };
	}
	if (existing.code !== 404) {
		warn(
			`${C.yellow}查询 Release ${tag} 返回 HTTP ${existing.code || "?"} — 继续尝试创建。${C.reset}`,
		);
	}

	const created = githubApi({
		curl,
		repo,
		token,
		method: "POST",
		path: "/releases",
		body: { tag_name: tag, name: tag, generate_release_notes: true },
	});
	const payload = parseJson(created.body);
	if (created.code === 201 && payload && payload.tag_name === tag) {
		log(
			`${C.green}GitHub Release ${tag} 创建成功（tag → ${localSha.slice(0, 7)}）${C.reset}` +
				(payload.html_url ? `\n  ${C.dim}${payload.html_url}${C.reset}` : ""),
		);
		return { status: "created", url: payload.html_url, sha: localSha };
	}

	// POST failed — it may still exist (concurrent run, retry, manual backfill).
	const confirm = githubApi({ curl, repo, token, path: `/releases/tags/${tag}` });
	const confirmed = parseJson(confirm.body);
	if (confirm.code === 200) {
		warn(
			`${C.yellow}POST 返回 HTTP ${created.code || "?"}，但查询确认 Release ${tag} 已存在，跳过（不重复创建）${C.reset}` +
				(confirmed && confirmed.html_url ? `\n  ${C.dim}${confirmed.html_url}${C.reset}` : ""),
		);
		return { status: "exists", url: confirmed && confirmed.html_url, sha: localSha };
	}
	warn(
		`${C.yellow}GitHub Release 创建失败（POST HTTP ${created.code || "?"}，按 tag 查询 ${confirm.code || "?"}）。` +
			`\n  ${(created.body || created.error || "").slice(0, 300)}` +
			`\n  可稍后重跑 pnpm release:github ${tag}（幂等，不会动版本号与 npm）。${C.reset}`,
	);
	return { status: "http-error", detail: `POST ${created.code}`, sha: localSha };
}

/**
 * Compare npm's published versions, GitHub's Release list and the remote tags.
 * This is the drift detector: a version that exists on npm without a Release
 * is exactly the silent gap that `generate_release_notes` then papers over by
 * folding its commits into the next version's notes.
 */
export async function auditReleases({
	npmVersions,
	curl = "curl",
	repo,
	token,
	git,
	cwd,
	log = console.log,
}) {
	const releases = [];
	for (let page = 1; page <= 5; page++) {
		const res = githubApi({
			curl,
			repo,
			token,
			path: `/releases?per_page=100&page=${page}`,
		});
		if (res.code !== 200) {
			throw new Error(
				`GitHub releases 查询失败（HTTP ${res.code || "?"}）：${(res.body || res.error).slice(0, 200)}`,
			);
		}
		const batch = parseJson(res.body) || [];
		releases.push(...batch);
		if (batch.length < 100) break;
	}
	const g = gitToolkit({ cwd, git });
	const remoteTags = new Set(
		(g.try(["ls-remote", "--tags", "origin"]).stdout ?? "")
			.split("\n")
			.map((line) => line.trim().split(/\s+/)[1] ?? "")
			.map((ref) => ref.replace("refs/tags/", "").replace(/\^\{\}$/, ""))
			.filter((tag) => tag.startsWith("v")),
	);

	const byTag = new Map(releases.map((release) => [release.tag_name, release]));
	/** A draft is not public, so it counts as missing for drift purposes. */
	const releaseState = (entry) => {
		if (!entry) return "missing";
		return entry.draft ? "draft" : "published";
	};
	const rows = [];
	for (const version of npmVersions) {
		const tag = `v${version}`;
		rows.push({
			version,
			tag,
			npm: true,
			release: releaseState(byTag.get(tag)),
			tagRemote: remoteTags.has(tag),
		});
	}
	for (const release of releases) {
		const version = release.tag_name.replace(/^v/, "");
		if (!npmVersions.includes(version)) {
			rows.push({
				version,
				tag: release.tag_name,
				npm: false,
				release: release.draft ? "draft" : "published",
				tagRemote: remoteTags.has(release.tag_name),
			});
		}
	}
	// Newest first; kept as a named comparator so the ordering rule is one line.
	const newestFirst = (a, b) => {
		if (a.version === b.version) return 0;
		return a.version < b.version ? 1 : -1;
	};
	rows.sort(newestFirst);

	log(`releases  : ${releases.length} on GitHub · ${remoteTags.size} remote tags`);
	log(`npm       : ${npmVersions.length} published versions\n`);
	log("version   npm     github-release  remote-tag");
	for (const row of rows) {
		const mark = (ok) => (ok ? "✅" : "❌");
		log(
			`${row.version.padEnd(9)} ${mark(row.npm).padEnd(7)} ` +
				`${(row.release === "published" ? "✅ published" : mark(false) + " " + row.release).padEnd(15)} ` +
				`${mark(row.tagRemote)} ${row.tagRemote ? "" : row.tag}`,
		);
	}
	const gaps = rows.filter((row) => row.npm && row.release !== "published");
	return { rows, gaps };
}
