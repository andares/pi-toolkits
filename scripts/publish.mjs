#!/usr/bin/env node
/**
 * One-command npm release for @andares/pi-toolkits.
 *
 *   pnpm release patch   # 0.1.2 → 0.1.3
 *   pnpm release minor   # 0.1.2 → 0.2.0   (patch zeroed)
 *   pnpm release major   # 0.1.2 → 1.0.0   (minor + patch zeroed)
 *   pnpm release patch --prepare-only   # 准备到本地 tag，不 push
 *   pnpm release patch --no-wait        # 推完 tag 就返回，不轮询 CI
 *   pnpm release patch --local          # 应急：本机直接发布（需要 npm token）
 *
 * Exactly one of `major | minor | patch` is required. A higher-level bump
 * zeroes every lower level.
 *
 * 发版语义（2026-11 起）：**tag 是发版意图，CI 是发版执行**。
 * 本脚本做足准备并把 tag 推上去；`.github/workflows/publish.yml` 被 tag 触发后
 * 用 OIDC trusted publishing 发布（无 token、无 2FA、自动 provenance）。
 *
 * Flow:
 *   validate arg → 工作区必须干净（有未提交变更直接中止）→ typecheck + test + UI checks
 *   → bump package.json → git commit `chore: release vX.Y.Z` + tag `vX.Y.Z`
 *     (tag via scripts/tag-current.mjs — skips if already exists)
 *     → 自检：tag == HEAD 且工作区干净（否则中止）
 *   → `git push origin <branch>`，再 `git push origin refs/tags/vX.Y.Z`
 *     **这就是发版动作**：推成功后 CI 开始发布，本机不再写 registry。
 *   → 等 CI：workflow run 失败立即中止（带 run URL）；npm 上出现该版本且
 *     provenance attestation 非空，才算这一版发布完成。
 *   → 用 GITHUB_TOKEN 创建 GitHub Release v{next}（best-effort：未设 token /
 *     已存在 / 失败都只提示、不中止）。
 *   → 尾部自检：npm / provenance / 远端 tag / Release。
 *
 * 发布后若 GitHub Release 被跳过（竞态/缺 token/push 失败），补建用：
 *     pnpm release:github v{next}      # 不动版本号，不碰 npm，幂等
 *     pnpm release:github --audit      # 列出 npm 与 GitHub Release 的差集
 *
 * `--dry-run` prints the plan (version + steps) and exits without changing
 * anything. `--prepare-only` stops after commit+tag and prints the push command.
 *
 * Notes:
 *  - 干净检查是硬性前置：release 提交只含版本号，未提交内容会进 npm 包
 *    （pnpm 从工作区打包）却不进 tag —— v0.4.0 事故即由此产生。CI 从 tag 的
 *    提交重新 checkout，发布内容 = tag 内容，不再依赖本机工作区。
 *  - The published tarball ships only `src` (package.json "files"); this
 *    script and `plans/` are never published.
 *  - GitHub Release 需要 fine-grained token（Contents 写权限），存于
 *    GITHUB_TOKEN 环境变量；创建失败不影响已推送的 tag 与 npm 发布。
 *  - 应急（CI 不可用）：`--local` 走本机 `pnpm publish`（需要绕过 2FA 的
 *    granular token）。2027-01 起该令牌失去直接发布能力，届时应改用
 *    `npm stage publish` + 网页端 2FA 审批，不要再依赖 `--local`。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	githubApi,
	parseJson,
	releaseTailGap,
	syncGitHubRelease,
} from "./lib/github-release.mjs";
import { waitForAttestations, waitForCiPublish } from "./lib/ci-publish.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const BUMPS = ["major", "minor", "patch"];
const FLAGS = new Set([
	"--dry-run",
	"--skip-tail-check",
	"--prepare-only",
	"--no-wait",
	"--local",
]);

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

const argv = process.argv.slice(2);
const arg = argv[0];
const dryRun = argv.includes("--dry-run");
const skipTailCheck = argv.includes("--skip-tail-check");
const prepareOnly = argv.includes("--prepare-only");
const noWait = argv.includes("--no-wait");
const localPublish = argv.includes("--local");
const unknownFlags = argv.filter((a) => a.startsWith("--") && !FLAGS.has(a));
const strayArgs = argv.filter((a) => !a.startsWith("--") && a !== arg);

if (!BUMPS.includes(arg) || unknownFlags.length > 0 || strayArgs.length > 0) {
	console.error(
		`${C.red}${C.bold}Usage: pnpm release <${BUMPS.join("|")}> [flags]${C.reset}` +
			`\n  Bump the package version, commit + tag it, push branch + tag, and let GitHub Actions publish to npm.` +
			`\n  --dry-run         preview without changing anything.` +
			`\n  --prepare-only    stop after commit+tag and print the push command (push = publish).` +
			`\n  --no-wait         return right after the tag push; do not poll CI or create the Release.` +
			`\n  --local           emergency: publish from this machine with the local npm token.` +
			`\n  --skip-tail-check release even when the PREVIOUS version's tag is missing remotely.`,
	);
	if (unknownFlags.length > 0) {
		console.error(`${C.red}Unknown flag(s): ${unknownFlags.join(" ")}${C.reset}`);
	}
	if (strayArgs.length > 0) {
		console.error(`${C.red}Unexpected argument(s): ${strayArgs.join(" ")}${C.reset}`);
	}
	process.exit(1);
}
if (localPublish && (noWait || prepareOnly)) {
	console.error(
		`${C.red}--local cannot be combined with --no-wait or --prepare-only.${C.reset}` +
			`\n  --local publishes synchronously from this machine (the old behaviour).`,
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
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

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
	console.log(`  1. pnpm typecheck && pnpm test && pnpm ui:typecheck && pnpm ui:check`);
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
	if (localPublish) {
		console.log(`  4. pnpm publish --no-git-checks（--local：本机直接发布，需要 npm token）`);
		console.log(`  5. git push origin ${branch} + refs/tags/v${next}`);
		console.log(`  6. 校验远端 tag + 创建 GitHub Release`);
		console.log(`  7. 尾部自检：npm / remote tag / Release（--local 不检查 provenance）`);
	} else if (prepareOnly) {
		console.log(`  4. --prepare-only：停在 push 之前，打印推送命令（推 = 发版）`);
	} else {
		console.log(
			`  4. git push origin ${branch}（分支）→ git push origin refs/tags/v${next}（发版信号）`,
		);
		console.log(
			`  5. CI：pnpm install → typecheck / test / ui → 校验 tag==package.json → pnpm publish --provenance`,
		);
		console.log(`  6. 等 CI：workflow run 失败即中止；npm 出现该版本才算完成（--no-wait 跳过）`);
		console.log(
			`  7. 校验远端 tag（可见性重试）+ 创建 GitHub Release` +
				(process.env.GITHUB_TOKEN ? "" : "（未设置 GITHUB_TOKEN → Release 跳过）"),
		);
		console.log(`  8. 尾部自检：npm / provenance / remote tag / Release`);
	}
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
step("typecheck + test + UI checks");
run(pnpm, ["typecheck"]);
run(pnpm, ["test"]);
// The UI is a separate Vite workspace and its built assets are committed. Run
// these before the version bump: a stale build would otherwise first surface
// from prepublishOnly after the release commit/tag had already been anchored.
run(pnpm, ["ui:typecheck"]);
run(pnpm, ["ui:check"]);

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

// 4. 检查点：--prepare-only 停在 push 之前（本地 tag 已就绪，由人决定何时推）。
if (prepareOnly) {
	step("prepare-only：停在 push 之前");
	console.log(
		`${C.yellow}未推送——npm 上还不会出现 v${next}。确认后执行：${C.reset}` +
			`\n  git push origin ${branch} refs/tags/v${next}` +
			`\n${C.dim}推 tag 会触发 GitHub Actions 的 publish 工作流（OIDC，无 token）。` +
			`\n决定不发这一版：git tag -d v${next} && git reset --hard HEAD~1${C.reset}`,
	);
	process.exit(0);
}

// 5. 发版执行。默认把 tag 推给 CI —— tag push 就是发版信号。
if (localPublish) {
	// 应急路径：本机 token + 2FA bypass 直接发布。2027-01 起该类令牌失去
	// 直接发布能力，届时改用 `npm stage publish` + 网页端 2FA 审批。
	step("pnpm publish --no-git-checks（--local：本机直接发布）");
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
	step(`git push origin ${branch} + refs/tags/v${next}`);
	const pushed = run(git, ["push", "origin", branch, `refs/tags/v${next}`], {
		allowFailure: true,
	});
	if (pushed.status !== 0) {
		console.warn(
			`${C.yellow}git push 失败（可能已推过）——tag 若没到远端，Release 会跳过。${C.reset}`,
		);
	}
} else {
	step(`git push origin ${branch} → 再推 refs/tags/v${next}（发版信号）`);
	const pushBranch = run(git, ["push", "origin", branch], { allowFailure: true });
	if (pushBranch.status !== 0) {
		console.error(
			`${C.red}git push origin ${branch} 失败——tag 尚未推送，发版未发生。${C.reset}` +
				`\n  本地 commit + tag 已就绪；修好远端后重试：` +
				`\n  git push origin ${branch} refs/tags/v${next}` +
				`\n  决定不发这一版：git tag -d v${next} && git reset --hard HEAD~1`,
		);
		process.exit(pushBranch.status ?? 1);
	}
	const pushTag = run(git, ["push", "origin", `refs/tags/v${next}`], {
		allowFailure: true,
	});
	if (pushTag.status !== 0) {
		console.error(
			`${C.red}git push refs/tags/v${next} 失败——CI 不会触发，npm 不会有这一版。${C.reset}` +
				`\n  分支已推送；重试：git push origin refs/tags/v${next}`,
		);
		process.exit(pushTag.status ?? 1);
	}
	console.log(`${C.green}✅ 已推送 tag v${next}，GitHub Actions 开始发布${C.reset}`);
}

if (noWait) {
	console.log(
		`\n${C.dim}--no-wait：已推 tag，CI 在后台发布。` +
			`\n  run: https://github.com/${ghRepo}/actions/workflows/publish.yml` +
			`\n  完成后补尾部：pnpm release:github v${next}（幂等，不碰 npm；Release 需要 GITHUB_TOKEN）${C.reset}`,
	);
	process.exit(0);
}

// 6. 等 CI 真正把这一版落到 npm。先等再建 Release：Release 不应指向一个
//    没发出去的版本（那就是历史漂移的起点）。
let ciResult = { status: "published", run: undefined, elapsedMs: 0 };
if (!localPublish) {
	step("等待 CI 发布（tag 触发）");
	ciResult = await waitForCiPublish({
		repo: ghRepo,
		token: process.env.GITHUB_TOKEN,
		sha: headHash,
		name: pkg.name,
		version: next,
		npm,
		cwd: ROOT,
		log: (line) => console.log(`${C.dim}${line}${C.reset}`),
	});
	if (ciResult.status === "failed") {
		const url =
			ciResult.run?.html_url ??
			`https://github.com/${ghRepo}/actions/workflows/publish.yml`;
		console.error(
			`${C.red}${C.bold}CI publish failed for v${next}.${C.reset}` +
				`\n  run: ${url}` +
				`\n  tag v${next} 已推送（npm 不能重发同一版本）；修好后重跑工作流：` +
				`\n    gh workflow run publish.yml -f tag=v${next}` +
				`\n  或 Actions → publish → Run workflow → tag = v${next}（已发布的版本会跳过）。`,
		);
		process.exit(1);
	}
	if (ciResult.status === "timeout") {
		// 不确定 = 不发 Release：Release 不应指向一个可能没发出去的版本。
		console.error(
			`${C.red}等待超时：npm 上还没有 ${pkg.name}@${next}。${C.reset}` +
				(ciResult.run ? `\n  run: ${ciResult.run.html_url}` : "") +
				`\n  CI 若已成功，这是 registry 传播/扫描延迟：稍后用 npm view ${pkg.name}@${next} 复核，` +
				`\n  确认后再补 Release：pnpm release:github v${next}` +
				`\n  CI 若失败，修好后重跑工作流（tag 不变）。`,
		);
		process.exit(1);
	}
}

// 7. GitHub Release（best-effort）。tag 已推、版本已在 npm；syncGitHubRelease
//    只做「校验远端 tag → 幂等创建 Release」。
if (!process.env.GITHUB_TOKEN) {
	console.warn(
		`${C.yellow}未设置 GITHUB_TOKEN —— GitHub Release 会被跳过；` +
			`发布后用 pnpm release:github v${next} 补建（幂等，不碰 npm）。${C.reset}`,
	);
}
step("远端 tag 校验 + GitHub Release");
const release = await syncGitHubRelease({
	cwd: ROOT,
	repo: ghRepo,
	token: process.env.GITHUB_TOKEN,
	tag: `v${next}`,
});
const releaseOk = release.status === "created" || release.status === "exists";


// 8. 尾部自检（自动）—— 这一版必须四项都有：npm 上有该版本、有 provenance、
// 远端 tag 指向发布提交、有一个公开的 Release。这就是原来「发完再手动跑
// pnpm release:github --audit」的日常份额：全量 audit 会扫所有历史版本，
// 而且历史缺口不该拦住今天这版；单版本的四处核实才是每次发版都要有的证据。
// 全量 audit 仍可用于怀疑历史漂移时（比如怀疑某次被打断的发版没人补）。
step("尾部自检（这一版的四处证据）");
const npmView = spawnSync(npm, ["view", `${pkg.name}@${next}`, "version"], {
	cwd: ROOT,
	encoding: "utf8",
	stdio: "pipe",
});
const npmOk = npmView.status === 0 && npmView.stdout.trim() === next;
const attestations = npmOk
	? await waitForAttestations({ npm, name: pkg.name, version: next, cwd: ROOT })
	: [];
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
const npmCheck = {
	label: "npm",
	ok: npmOk,
	detail: npmOk ? next : (npmView.stderr || "npm view 未返回该版本").trim().slice(0, 200),
};
let provenanceDetail = "未发布，无 provenance";
if (attestations.length > 0) {
	provenanceDetail =
		attestations[0].url ?? `${attestations.length} attestation(s)`;
} else if (npmOk) {
	provenanceDetail = "dist.attestations 为空 —— 检查工作流是否真的走了 OIDC";
}
const provenanceCheck = {
	label: "provenance",
	ok: attestations.length > 0,
	detail: provenanceDetail,
};
const checks = [
	npmCheck,
	...(!localPublish
		? [provenanceCheck]
		: [{ label: "provenance", ok: true, detail: "n/a（--local 不在本机签名）" }]),
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

// npm 上的版本与 provenance 是这次迁移的硬验收：缺任何一项都不能报「已发布」。
// Release 仍属 best-effort（缺 token 的人不应该因此发失败）。
if (!npmOk) {
	console.error(
		`\n${C.red}${C.bold}这一版没有发出去：npm 上没有 ${pkg.name}@${next}。${C.reset}` +
			`\n  tag v${next} 已推送、内容不会变；不要在本地重复发布同一版本。` +
			`\n  修好工作流后重跑：gh workflow run publish.yml -f tag=v${next}` +
			`\n  或 Actions → publish → Run workflow → tag = v${next}。`,
	);
	process.exit(1);
}
if (!localPublish && attestations.length === 0) {
	console.error(
		`\n${C.red}${C.bold}${pkg.name}@${next} 已在 npm，但没有 provenance attestation。${C.reset}` +
			`\n  用 npm view ${pkg.name}@${next} dist.attestations 复核；` +
			`\n  为空通常意味着发布没走 OIDC（或工作流漏了 --provenance）。`,
	);
	process.exit(1);
}

console.log(
	`\n${C.green}${C.bold}✅ Published v${current} → v${next}${C.reset}` +
		`\n${C.dim}Tag: v${next} (${tagHash.slice(0, 7)}) · npm` +
		(localPublish ? "（--local）" : " by GitHub Actions（OIDC + provenance）") +
		(tailComplete ? " · GitHub Release（已核实）" : " · GitHub Release 未完成，见上") +
		`${C.reset}`,
);
if (!tailComplete) {
	console.log(
		`${C.dim}补完尾部：pnpm release:github v${next}（幂等，不碰 npm 与版本号）${C.reset}`,
	);
}
