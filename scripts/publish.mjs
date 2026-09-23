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
 *   → npm 成功后（失败即中止）：git push origin <branch> + 只推当前 tag
 *     refs/tags/vX.Y.Z（不再 --tags），随后校验远端分支/tag 哈希与本地一致；
 *     远端 tag 不一致 → 跳过 Release 创建并给出修复命令。
 *   → 用 GITHUB_TOKEN 创建 GitHub Release v{next}（仅在远端 tag 校验通过后；
 *     best-effort：未设 token / 已存在 / 失败都只提示、不中止）。
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const BUMPS = ["major", "minor", "patch"];
const curl = process.platform === "win32" ? "curl.exe" : "curl";

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

if (!BUMPS.includes(arg)) {
	console.error(
		`${C.red}${C.bold}Usage: pnpm release <${BUMPS.join("|")}>${C.reset}` +
			`\n  Bump the package version and publish to npm (requires exactly one argument).` +
			`\n  Add --dry-run to preview without changing anything.`,
	);
	process.exit(1);
}
if (process.argv.slice(2).filter((a) => a !== "--dry-run").length > 1) {
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

if (dryRun) {
	console.log(`\n${C.dim}--dry-run -- nothing changed. Would run:${C.reset}`);
	console.log(`  0. 工作区必须干净（有未提交变更则直接中止）`);
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
		`  5. git push origin ${branch} + refs/tags/v${next}（只推当前 tag）+ 校验远端哈希` +
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

// 5. GitHub：只推当前分支 + 当前 tag（不再 --tags —— 历史 tag 分歧会整条
// 拒绝推送且掩盖当前 tag 的真实状态），随后校验远端哈希；仅当远端 tag 与
// 本地一致时才创建 Release（否则 Release 会指向错误内容）。
step("git push + 校验 + GitHub Release");
const pushBranch = gitTry(["push", "origin", branch]);
if (pushBranch.status !== 0) {
	console.warn(
		`${C.yellow}git push origin ${branch} 失败（可能已推过或非快进）— 请手动检查。${C.reset}`,
	);
}
const pushTag = gitTry(["push", "origin", `refs/tags/v${next}`]);
if (pushTag.status !== 0) {
	console.warn(
		`${C.yellow}git push refs/tags/v${next} 失败（远端同名 tag 可能已存在且指向其它提交）。` +
			`\n  如需覆盖：git push origin refs/tags/v${next} --force${C.reset}`,
	);
}
const remoteTag =
	gitTry(["ls-remote", "origin", `refs/tags/v${next}`])
		.stdout.toString()
		.trim()
		.split(/\s+/)[0] ?? "";
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
const tagVerified = remoteTag === tagHash;
if (tagVerified) {
	console.log(
		`${C.green}远端 tag v${next} 校验通过 → ${tagHash.slice(0, 7)}${C.reset}`,
	);
} else {
	console.warn(
		`${C.red}远端 tag v${next} (${remoteTag.slice(0, 7) || "不存在"}) 与本地 (${tagHash.slice(0, 7)}) 不一致。` +
			`\n  修复：git push origin refs/tags/v${next} --force${C.reset}`,
	);
}
if (!process.env.GITHUB_TOKEN) {
	console.warn(
		`${C.yellow}未设置 GITHUB_TOKEN — 跳过 GitHub Release 创建。` +
			`npm 已发布 v${next}，可稍后手动创建 release。${C.reset}`,
	);
} else if (!tagVerified) {
	console.warn(
		`${C.yellow}远端 tag 校验未通过 — 跳过 GitHub Release 创建（避免 Release 指向错误内容）。` +
			`修好 tag 后重跑本脚本（幂等）或手动创建。${C.reset}`,
	);
} else {
	const rel = run(
		curl,
		[
			"-sS",
			"-X",
			"POST",
			"-H",
			"Accept: application/vnd.github+json",
			"-H",
			"X-GitHub-Api-Version: 2022-11-28",
			"-H",
			`Authorization: Bearer ${process.env.GITHUB_TOKEN}`,
			"-w",
			"\n%{http_code}",
			"-d",
			JSON.stringify({
				tag_name: `v${next}`,
				name: `v${next}`,
				generate_release_notes: true,
			}),
			`https://api.github.com/repos/${ghRepo}/releases`,
		],
		{ allowFailure: true, stdio: "pipe" },
	);
	const lines = rel.stdout.toString().trimEnd().split("\n");
	const code = lines.pop()?.trim() ?? "";
	const body = lines.join("\n").replace(/\s+/g, "");
	if (
		rel.status === 0 &&
		code === "201" &&
		body.includes(`"tag_name":"v${next}"`)
	) {
		console.log(
			`${C.green}GitHub Release v${next} 创建成功（tag → ${tagHash.slice(0, 7)}）${C.reset}`,
		);
	} else if (rel.status === 0 && code === "201") {
		console.warn(
			`${C.yellow}Release 创建成功但响应未确认 tag_name=v${next} — 请手动核对。${C.reset}`,
		);
	} else {
		// POST 失败后查询确认——release 可能已存在（并发/重试/手动补建），
		// 幂等处理：查询返回 200 即视为成功，不再重复创建。
		const chk = run(
			curl,
			[
				"-sS",
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				"-H",
				`Authorization: Bearer ${process.env.GITHUB_TOKEN}`,
				`https://api.github.com/repos/${ghRepo}/releases/tags/v${next}`,
			],
			{ allowFailure: true, stdio: "pipe" },
		);
		const chkCode = chk.stdout.toString().trim();
		if (chkCode === "200") {
			console.warn(
				`${C.yellow}POST 返回 HTTP ${code || "?"}，但查询确认 Release v${next} 已存在，跳过（不重复创建）${C.reset}`,
			);
		} else {
			console.warn(
				`${C.yellow}GitHub Release 创建失败（POST HTTP ${code || "?"}，按 tag 查询 ${chkCode || "?"}）。` +
					`npm 已发布 v${next}，可稍后手动创建。${C.reset}`,
			);
		}
	}
}

console.log(
	`\n${C.green}${C.bold}✅ Published v${current} → v${next}${C.reset}` +
		`\n${C.dim}Tag: v${next} (${tagHash.slice(0, 7)})` +
		` · npm${tagVerified ? " · GitHub Release" : ""}${C.reset}`,
);
