#!/usr/bin/env node
/**
 * One-command npm release for @andares/pi-toolkits.
 *
 *   pnpm release patch   # 0.1.2 → 0.1.3
 *   pnpm release minor   # 0.1.2 → 0.2.0   (patch zeroed)
 *   pnpm release major   # 0.1.2 → 1.0.0   (minor + patch zeroed)
 *
 * Exactly one of `major | minor | patch` is required. A higher-level bump
 * zeroes every lower level.
 *
 * Flow:
 *   validate arg → 工作区必须干净（有未提交变更直接中止）→ typecheck + test
 *   → bump package.json → git commit `chore: release vX.Y.Z` + tag `vX.Y.Z`
 *     (tag via scripts/tag-current.mjs — skips if already exists)
 *     → 自检：tag == HEAD 且工作区干净（否则中止）
 *   → `pnpm publish` (pnpm-only repo — never `npm publish`). `prepublishOnly`
 *     re-runs typecheck + test as the publish gate.
 *   → npm 成功后（失败即中止）：git push origin <branch>（只推当前分支），
 *     tag 的推送/远端校验/GitHub Release 创建交给 scripts/lib/github-release.mjs
 *     （与 `pnpm release:github` 共用同一条路径，带远端可见性重试；远端 tag 不存在
 *     就推，指向别的提交就拒绝建 Release 并给出人工修复命令）。
 *   → 用 GITHUB_TOKEN 创建 GitHub Release v{next}（best-effort：未设 token /
 *     已存在 / 失败都只提示、不中止）。
 *
 * 发布后若 GitHub Release 被跳过（竞态/缺 token/push 失败），补建用：
 *     pnpm release:github v{next}      # 不动版本号，不碰 npm，幂等
 *     pnpm release:github --audit      # 列出 npm 与 GitHub Release 的差集
 *
 * `--dry-run` prints the plan (version + steps) and exits without changing
 * anything.
 *
 * Notes:
 *  - 干净检查是硬性前置：release 提交只含版本号，未提交内容会进 npm 包
 *    （pnpm 从工作区打包）却不进 tag —— v0.4.0 事故即由此产生。
 *    `pnpm publish` 仍用 `--no-git-checks`，但此时工作区已保证干净。
 *  - The published tarball ships only `src` (package.json "files"); this
 *    script and `plans/` are never published.
 *  - GitHub Release 需要 fine-grained token（Contents: write），存于
 *    GITHUB_TOKEN 环境变量；创建失败不影响 npm 已发布的结果。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi, parseJson, releaseTailGap, syncGitHubRelease } from "./lib/github-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const BUMPS = ["major", "minor", "patch"];

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

const arg = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const skipTailCheck = process.argv.includes("--skip-tail-check");

if (!BUMPS.includes(arg)) {
	console.error(
		`${C.red}${C.bold}Usage: pnpm release <${BUMPS.join("|")}>${C.reset}` +
			`\n  Bump the package version and publish to npm (requires exactly one argument).` +
			`\n  Add --dry-run to preview without changing anything.` +
			`\n  Add --skip-tail-check to publish even when the PREVIOUS version's tag is missing remotely.`,
	);
	process.exit(1);
}
if (
	process.argv
		.slice(2)
		.filter((a) => a !== "--dry-run" && a !== "--skip-tail-check").length > 1
) {
	console.error(
		`${C.red}Exactly one of ${BUMPS.join("|")} is required.${C.reset}`,
	);
	process.exit(1);
}

let pkg;
try {
	pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
} catch {
	console.error(
		`${C.red}package.json is missing or not valid JSON: ${PKG_PATH}${C.reset}`,
	);
	process.exit(1);
}
const current = pkg.version;
if (typeof current !== "string" || !/^\d+\.\d+\.\d+$/.test(current)) {
	console.error(
		`${C.red}Unexpected package.json version: ${JSON.stringify(current)}${C.reset}`,
	);
	process.exit(1);
}

const [maj, min, pat] = current.split(".").map(Number);
let next;
if (arg === "major") next = `${maj + 1}.0.0`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else next = `${maj}.${min}.${pat + 1}`;

// GitHub 仓库 owner/repo（用于 REST API），从 package.json repository.url 解析。
const repoMatch = pkg.repository?.url?.match(
	/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/,
);
const ghRepo = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : "andares/pi-toolkits";

/** 尾部校验结果的人话（dry-run 报告用）。 */
const TAIL_LABEL = {
	ok: "已就位",
	absent: "远端缺失",
	mismatch: "远端指向别的提交",
	"missing-local-tag": "本地无此 tag",
	skipped: "跳过（--skip-tail-check）",
};

console.log(
	`${C.dim}release${C.reset} ${C.bold}${current}${C.reset} → ${C.bold}${C.green}${next}${C.reset} (${arg})`,
);

function step(label) {
	console.log(`\n${C.dim}▸${C.reset} ${C.bold}${label}${C.reset}`);
}

function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
	if (res.status !== 0 && !opts.allowFailure) {
		console.error(`${C.red}Failed: ${cmd} ${args.join(" ")}${C.reset}`);
		process.exit(res.status ?? 1);
	}
	return res;
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const git = process.platform === "win32" ? "git.exe" : "git";

function tagExists(tag) {
	return (
		run(git, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
			stdio: "pipe",
			allowFailure: true,
		}).status === 0
	);
}

/** Run a git command and return trimmed stdout (fatal on failure). */
function gitOut(args) {
	return run(git, args, { stdio: "pipe" }).stdout.toString().trim();
}

/** Run a git command tolerating failure (network checks, push). */
function gitTry(args) {
	return run(git, args, { stdio: "pipe", allowFailure: true });
}

const branch =
	run(git, ["branch", "--show-current"], {
		stdio: "pipe",
		allowFailure: true,
	}).stdout
		.toString()
		.trim() || "master";

// Working-tree state: informational for --dry-run, a hard gate for the real
// run (see below).
const dirty = run(git, ["status", "--porcelain"], { stdio: "pipe" })
	.stdout.toString()
	.trim();

// 上一版的 tag 名（尾部校验与 dry-run 报告共用）。
const tailTag = `v${current}`;

if (dryRun) {
	console.log(`\n${C.dim}--dry-run -- nothing changed. Would run:${C.reset}`);
	console.log(`  0. 工作区必须干净（有未提交变更则直接中止）`);
	if (skipTailCheck) {
		console.log(`  0b. 上一版 ${tailTag} 的尾部校验 —— ${TAIL_LABEL.skipped}`);
	} else {
		const tail = await releaseTailGap({ cwd: ROOT, git, tag: tailTag });
		console.log(
			`  0b. 上一版 ${tailTag} 的远端 tag 校验（现在：${TAIL_LABEL[tail.state]}）—— 不是「已就位」就中止`,
		);
	}
	console.log(`  1. pnpm typecheck && pnpm test`);
	console.log(`  2. bump package.json version → ${next}`);
	if (tagExists(`v${next}`)) {
		console.log(
			`  3. git commit -m "chore: release v${next}" + tag-current（tag v${next} 已存在，跳过打 tag）`,
		);
	} else {
		console.log(
			`  3. git commit -m "chore: release v${next}" + tag-current（git tag v${next}）`,
		);
	}
	console.log(`  3b. 自检：tag == HEAD 且工作区干净`);
	console.log(`  4. pnpm publish --no-git-checks`);
	console.log(
		`  5. git push origin ${branch} + refs/tags/v${next}（tag 不存在才推）+ 校验远端 tag 哈希` +
			`（带可见性重试）+ 创建 GitHub Release` +
			(process.env.GITHUB_TOKEN ? "" : "（未设置 GITHUB_TOKEN → Release 跳过）"),
	);
	if (dirty) {
		console.log(
			`\n${C.yellow}注意：当前工作区有未提交变更——实际执行会在第 0 步直接中止（先提交再发版）：${C.reset}\n` +
				dirty
					.split("\n")
					.map((l) => `  ${l}`)
					.join("\n"),
		);
	}
	process.exit(0);
}

// Hard gate — release 提交只含版本号：有未提交内容时，pnpm 会把它打进
// npm 包却不进 tag，tag 就不再是「实际发布内容」的快照（v0.4.0 事故）。
if (dirty) {
	console.error(
		`${C.red}${C.bold}Aborting: uncommitted changes present.${C.reset}\n` +
			dirty
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n") +
			`\n${C.red}Commit your work first (scratch files: add to .gitignore), then re-run.` +
			`\n  The release commit only bumps the version — uncommitted work would be published` +
			` to npm but absent from tag v${next}.${C.reset}`,
	);
	process.exit(1);
}

// Hard gate 2 — 上一版必须真的发完了（tag 已在远端且同哈希）。
// 中断过的发版（打断在推 tag / 建 Release 之前）会让「再按一次 pnpm release」
// 产出一个与上一版逐字节相同的新版本：2026-11-10 v0.12.3 → v0.12.4 实测，
// 两个 tarball 的差异只有 package.json 的 version 一行。补救入口是
// `pnpm release:github <tag>`——它不 bump 版本、不碰 npm，正好是「补完尾部」
// 而不是「再发一版」。只看 tag、不看 Release：Release 要 token，缺 token 的人
// 不应该因此发不了版。
if (!skipTailCheck) {
	step(`上一版 ${tailTag} 的发布尾部`);
	const tail = await releaseTailGap({ cwd: ROOT, git, tag: tailTag });
	if (tail.state !== "ok") {
		const hint = {
			"missing-local-tag":
				`  本地没有 tag ${tailTag}，无法确认 ${current} 是否已发布。` +
				`\n  若 ${current} 确实在 npm 上、本地只是丢了 tag：git tag ${tailTag} <发布提交>，然后重跑。` +
				`\n  若它从未发布过：先修好 package.json 的版本号。`,
			absent:
				`  远端没有 tag ${tailTag} —— 上一版很可能在推 tag 之前被打断。` +
				`\n  先补完尾部：pnpm release:github ${tailTag}（推 tag + 校验 + 建 Release，不碰 npm，幂等）` +
				`\n  否则这次会发出 v${next}，内容与 ${current} 逐字节相同（只有 version 一行不同）。` +
				`\n  确认要跳过：pnpm release ${arg} --skip-tail-check`,
			mismatch:
				`  远端 tag ${tailTag} 指向 ${tail.remoteSha.slice(0, 7) || "?"}，本地指向 ${tail.localSha.slice(0, 7)}。` +
				`\n  人工确认后（远端不对就 git push origin refs/tags/${tailTag} --force）再发版。`,
		}[tail.state];
		console.error(
			`${C.red}${C.bold}Aborting: ${tailTag} 的发布尾部未完成（${TAIL_LABEL[tail.state]}）。${C.reset}\n${hint}`,
		);
		process.exit(1);
	}
	console.log(
		`${C.green}${tailTag} 的远端 tag 已就位 → ${tail.localSha.slice(0, 7)}${C.reset}`,
	);
}

// 1. Checks gate — abort before anything is changed if they fail.
step("typecheck + test");
run(pnpm, ["typecheck"]);
run(pnpm, ["test"]);

// 2. Bump package.json (preserve formatting: 2-space indent + trailing newline).
step(`bump version → ${next}`);
pkg.version = next;
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// 3. Commit，然后调用 tag-current.mjs 打 tag（内部检测已存在 → 不重复打）。
// 此时 package.json 已是新版本，打出的 v${next} 恰好指向 release commit。
step(`git commit + tag v${next}`);
run(git, ["add", "package.json"]);
run(git, ["commit", "-m", `chore: release v${next}`]);
run(process.execPath, [join(ROOT, "scripts", "tag-current.mjs")]);

// 3b. 自检：tag 必须指向 HEAD 且工作区干净 —— 保证「将要发布的 tarball
// （从工作区打包）== tag 内容」。任何不一致都在 publish 之前中止。
const headHash = gitOut(["rev-parse", "HEAD"]);
const tagHash = gitOut(["rev-parse", `v${next}`]);
if (tagHash !== headHash) {
	console.error(
		`${C.red}Aborting: tag v${next} (${tagHash.slice(0, 7)}) does not point at HEAD (${headHash.slice(0, 7)}).` +
			`\n  Re-point it with: git tag -f v${next}   (or bump to a new version)${C.reset}`,
	);
	process.exit(1);
}
const dirtyAfterTag = gitOut(["status", "--porcelain"]);
if (dirtyAfterTag) {
	console.error(
		`${C.red}Aborting: working tree is dirty after commit+tag — the published content would NOT match tag v${next}:${C.reset}\n` +
			dirtyAfterTag
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n"),
	);
	process.exit(1);
}
console.log(
	`${C.green}tag v${next} == HEAD (${headHash.slice(0, 7)}), working tree clean${C.reset}`,
);

// 4. Publish (prepublishOnly re-gates with typecheck + test).
if (!process.env.GITHUB_TOKEN) {
	console.warn(
		`${C.yellow}未设置 GITHUB_TOKEN —— npm 会照常发布，但 GitHub Release 会被跳过；` +
			`发布后用 pnpm release:github v${next} 补建（幂等，不碰 npm）。${C.reset}`,
	);
}
step("pnpm publish");
const publish = run(pnpm, ["publish", "--no-git-checks"], {
	allowFailure: true,
});
if (publish.status !== 0) {
	console.error(
		`${C.red}Publish failed. The version bump is already committed + tagged as v${next}.` +
			`\n  To roll back: git tag -d v${next} && git reset --hard HEAD~1${C.reset}`,
	);
	process.exit(publish.status ?? 1);
}

// 5. GitHub：只推当前分支（不再 --tags —— 历史 tag 分歧会整条拒绝推送且掩盖
// 当前 tag 的真实状态）；tag 推送 + 远端校验 + Release 创建在
// scripts/lib/github-release.mjs 里，与 `pnpm release:github` 共用。
// 旧版把「远端 tag 不一致」当成终局、又提示「重跑本脚本（幂等）」——两条都是坑：
// `pnpm release` 永远会再 bump 一版，漏掉的 Release 反而永远补不上。
step("git push + 校验 + GitHub Release");
const pushBranch = gitTry(["push", "origin", branch]);
if (pushBranch.status !== 0) {
	console.warn(
		`${C.yellow}git push origin ${branch} 失败（可能已推过或非快进）— 请手动检查。${C.reset}`,
	);
}
const remoteBranch =
	gitTry(["ls-remote", "origin", `refs/heads/${branch}`])
		.stdout.toString()
		.trim()
		.split(/\s+/)[0] ?? "";
if (remoteBranch !== headHash) {
	console.warn(
		`${C.yellow}远端 ${branch} (${remoteBranch.slice(0, 7) || "?"}) 与本地 (${headHash.slice(0, 7)}) 不一致 — push 可能未成功。${C.reset}`,
	);
}
const release = await syncGitHubRelease({
	cwd: ROOT,
	repo: ghRepo,
	token: process.env.GITHUB_TOKEN,
	tag: `v${next}`,
});
const releaseOk = release.status === "created" || release.status === "exists";

// 尾部自检（自动）—— 这一版必须三处都有：npm 上有该版本、远端 tag 指向发布
// 提交、有一个公开的 Release。这就是原来「发完再手动跑 pnpm release:github
// --audit」的日常份额：全量 audit 会扫所有历史版本，而且历史缺口不该拦住今天
// 这版；单版本的三处核实才是每次发版都要有的证据。全量 audit 仍可用于怀疑
// 历史漂移时（比如怀疑某次被打断的发版没人补）。
step("尾部自检（这一版的三处证据）");
const npmView = spawnSync("npm", ["view", `${pkg.name}@${next}`, "version"], {
	cwd: ROOT,
	encoding: "utf8",
	stdio: "pipe",
});
const npmOk = npmView.status === 0 && npmView.stdout.trim() === next;
const tailRef = await releaseTailGap({ cwd: ROOT, git, tag: `v${next}` });
let releaseCheck = { label: "release", ok: false, detail: "未设 GITHUB_TOKEN（跳过）" };
if (process.env.GITHUB_TOKEN) {
	const res = githubApi({
		repo: ghRepo,
		token: process.env.GITHUB_TOKEN,
		path: `/releases/tags/v${next}`,
	});
	const data = parseJson(res.body);
	const ok = res.code === 200 && Boolean(data) && !data.draft;
	releaseCheck = {
		label: "release",
		ok,
		detail: ok ? data.html_url : `HTTP ${res.code || "?"}`,
	};
}
const checks = [
	{
		label: "npm",
		ok: npmOk,
		detail: npmOk ? next : (npmView.stderr || "npm view 未返回该版本").trim().slice(0, 200),
	},
	{
		label: "remote tag",
		ok: tailRef.state === "ok",
		detail:
			tailRef.state === "ok"
				? `v${next} → ${tailRef.localSha.slice(0, 7)}`
				: TAIL_LABEL[tailRef.state],
	},
	releaseCheck,
];
for (const check of checks) {
	console.log(
		`  ${check.ok ? `${C.green}✅` : `${C.red}❌`}${C.reset} ${check.label.padEnd(11)} ${check.detail}`,
	);
}
const tailComplete = releaseOk && checks.every((check) => check.ok);

console.log(
	`\n${C.green}${C.bold}✅ Published v${current} → v${next}${C.reset}` +
		`\n${C.dim}Tag: v${next} (${tagHash.slice(0, 7)}) · npm` +
		(tailComplete ? " · GitHub Release（三处已核实）" : " · 尾部未完成，见上") +
		`${C.reset}`,
);
if (!tailComplete) {
	console.log(
		`${C.dim}补完尾部：pnpm release:github v${next}（幂等，不碰 npm 与版本号）${C.reset}`,
	);
}
