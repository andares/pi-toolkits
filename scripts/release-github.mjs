#!/usr/bin/env node
/**
 * release:github — create (or verify) the GitHub Release for an ALREADY
 * published version, and audit npm ↔ GitHub release drift.
 *
 *   pnpm release:github              # tag = current package.json version
 *   pnpm release:github v0.7.3       # explicit tag
 *   pnpm release:github --audit      # npm versions vs Releases vs remote tags
 *   pnpm release:github --audit --allow-gaps   # 同上，但历史缺口只警告不报错
 *   pnpm release:github --dry-run    # print the plan, change nothing
 *
 * Why this exists: `pnpm release <bump>` creates the Release as its last step,
 * and any skip there (an `ls-remote` racing GitHub's ref visibility — observed
 * at v0.7.3 — a missing token, a failed push, an HTTP failure) used to be
 * unrecoverable: `pnpm release` always bumps again, so the missing Release for
 * version N could never be created, and `generate_release_notes` — which diffs
 * against the last PUBLISHED Release — folded N's commits into N+1's notes.
 * GitHub then looked like it was trailing npm by a version.
 *
 * This command is the resume path: it never bumps the version and never touches
 * npm. It resolves the local tag, pushes it when the remote lacks it, verifies
 * the remote ref SHA with bounded retries, then creates the Release
 * idempotently. `--audit` is the drift detector to run after any publication.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { C, auditReleases, syncGitHubRelease } from "./lib/github-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const audit = argv.includes("--audit");
// Historical gaps (e.g. a version published before tags were part of the flow)
// can be accepted deliberately: report them without failing the command.
const allowGaps = argv.includes("--allow-gaps");
const tagArg = argv.find((arg) => !arg.startsWith("-"));

function fail(message) {
	console.error(`${C.red}${message}${C.reset}`);
	process.exit(1);
}

let pkg;
try {
	pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
} catch {
	fail(`package.json is missing or not valid JSON in ${ROOT}`);
}
const repoMatch = pkg.repository?.url?.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
const repo = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : "andares/pi-toolkits";
const token = process.env.GITHUB_TOKEN;

if (audit) {
	const npm = spawnSync("npm", ["view", pkg.name, "versions", "--json"], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (npm.status !== 0) {
		fail(`npm view ${pkg.name} versions failed:\n${(npm.stderr || "").trim()}`);
	}
	let versions;
	try {
		versions = JSON.parse(npm.stdout);
	} catch {
		fail(`npm view ${pkg.name} versions returned non-JSON`);
	}
	const list = (Array.isArray(versions) ? versions : [versions]).filter((v) =>
		/^\d+\.\d+\.\d+$/.test(v),
	);
	console.log(
		`${C.bold}${repo}${C.reset} ${C.dim}package ${pkg.name}${C.reset}\n`,
	);
	let result;
	try {
		result = await auditReleases({
			npmVersions: list,
			repo,
			token,
			cwd: ROOT,
		});
	} catch (error) {
		fail(error.message);
	}
	if (result.gaps.length) {
		const steps = result.gaps.map((gap) => {
			const lines = [];
			if (!gap.tagRemote) {
				lines.push(
					`     # 远端连 tag 都没有：先找到 ${gap.version} 对应的发布提交，补 tag 再补 Release`,
					`     git tag ${gap.tag} <发布提交> && git push origin ${gap.tag}`,
				);
			}
			lines.push(`     pnpm release:github ${gap.tag}`);
			return lines.join("\n");
		});
		const report =
			`\n${C.red}${result.gaps.length} 个 npm 已发布版本缺少公开的 GitHub Release：${C.reset}\n` +
			steps.join("\n") +
			`\n${C.dim}不补建的后果：下一版的 generate_release_notes 会把这些版本的提交\n` +
			`一并算进去，GitHub 的版本线就与 npm 对不上了。${C.reset}`;
		if (allowGaps) {
			console.warn(report);
			process.exit(0);
		}
		console.error(report);
		process.exit(1);
	}
	console.log(`\n${C.green}✅ 每个 npm 已发布版本都有公开的 GitHub Release。${C.reset}`);
	process.exit(0);
}

const tag = tagArg ?? `v${pkg.version}`;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
	fail(`Unexpected tag: ${JSON.stringify(tag)} — expected vX.Y.Z (or pass one explicitly)`);
}
console.log(
	`${C.dim}github release${C.reset} ${C.bold}${tag}${C.reset} ` +
		`${C.dim}(repo ${repo}${dryRun ? ", dry-run" : ""})${C.reset}`,
);
const result = await syncGitHubRelease({
	cwd: ROOT,
	repo,
	token,
	tag,
	dryRun,
});
if (result.status === "created" || result.status === "exists") {
	console.log(
		`\n${C.green}${C.bold}✅ ${tag}: ${result.status === "created" ? "已创建" : "已存在（幂等）"}${C.reset}` +
			(result.url ? `\n${C.dim}${result.url}${C.reset}` : ""),
	);
	process.exit(0);
}
if (result.status === "no-token") {
	fail(
		"GITHUB_TOKEN 未设置 —— Release 未创建。带上 token 重跑本命令即可（幂等）。",
	);
}
if (result.status === "draft") {
	fail(`Release ${tag} 是 DRAFT —— 到 GitHub 手动发布（草稿不公开）。`);
}
if (result.status === "missing-local-tag") {
	fail(
		`本地不存在 tag ${tag}。` +
			`\n  先 git fetch --tags 看是不是没拉下来；若该版本确实发布过、只是本地 tag 丢了，` +
			`\n  就 git tag ${tag} <发布提交> 之后重跑本命令。`,
	);
}
fail(
	`Release ${tag} 未创建（${result.status}${result.detail ? `: ${result.detail}` : ""}）。` +
		`\n  远端 tag 的问题按上面的提示处理（不存在就重跑本命令让脚本推、` +
		`\n  指向别的提交先人工确认），然后重跑。`,
);
