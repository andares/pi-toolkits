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
 *   validate arg → **发版物料预检**（工作区干净 / CHANGELOG 有顶格备注 / files 含
 *     CHANGELOG.md / 本地没有 v<next> tag / 上一版尾部已完成）—— 一次查齐、一次报齐，
 *     任何一项不齐就一步都不执行（不跑门禁、不写盘、不提交、不推 tag）
 *   → typecheck + test + UI checks
 *   → CHANGELOG.md 的 `## Unreleased` 改名为 `## <next> — <date>`（备注是物料，
 *     预检已经拦住空段；`--skip-changelog` 是唯一显式旁路）—— 运行时据此在升级后
 *     首次启动展示变更摘要
 *   → bump package.json → git commit `chore: release vX.Y.Z`（含 CHANGELOG.md）+ tag `vX.Y.Z`
 *     (tag via scripts/tag-current.mjs — skips if already exists)
 *     → 自检：tag == HEAD 且工作区干净（否则中止）
 *   → `git push origin <branch>`，再 `git push origin refs/tags/vX.Y.Z`
 *     **这就是发版动作**：推成功后 CI 开始发布，本机不再写 registry。
 *   → 等 CI：只盯 tag 触发的 workflow run，进度按阶段打印（run 未出现 / queued /
 *     in_progress）并带 `t=Ns`；run 失败立即中止（带 run URL 与 conclusion）；run 排队
 *     超阈值仍未开始 = 僵尸 run，补发一次 `workflow_dispatch`
 *     （PI_RELEASE_RESCUE_QUEUE_MS，默认 60 s）。
 *     **run 绿了就算发版完成** —— 不再回头查 npm 上的版本与 provenance：Action 之前
 *     也没人问过 npmjs「处理好了没」，传播与扫描是 npm 的事（2026-11-26 崔总定）。
 *   → 用 GITHUB_TOKEN 创建 GitHub Release v{next}（best-effort：未设 token /
 *     已存在 / 失败都只提示、不中止）。
 *   → 收尾：只报已确定的事实（tag、run URL、Release URL）+ npm 包页面链接。
 *
 * 发布后若 GitHub Release 被跳过（竞态/缺 token/push 失败），补建用：
 *     pnpm release:github v{next}      # 不动版本号，不碰 npm，幂等
 *     pnpm release:github --audit      # 列出 npm 与 GitHub Release 的差集
 *
 * `--dry-run` prints the plan (version + steps) and exits without changing
 * anything. `--prepare-only` stops after commit+tag and prints the push command.
 *
 * Notes:
 *  - 物料预检是硬性前置，且跑在门禁之前：门禁两分钟，物料缺口两秒就能查出来，
 *    而且缺物料时最需要的是「现在去补齐」，不是「等了很久再读一条报错」。
 *    预检的清单与判定在 scripts/lib/release-materials.mjs（纯函数，有测试）。
 *  - 干净检查是硬性前置：release 提交只含版本号，未提交内容会进 npm 包
 *    （pnpm 从工作区打包）却不进 tag —— v0.4.0 事故即由此产生。CI 从 tag 的
 *    提交重新 checkout，发布内容 = tag 内容，不再依赖本机工作区。
 *  - The published tarball ships `src` plus `CHANGELOG.md`; the extension
 *    announces the released section on the first start after an upgrade.
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
	GIT_TIMEOUT_MS,
	boundedSshCommand,
	releaseTailGap,
	syncGitHubRelease,
} from "./lib/github-release.mjs";
import { createDispatchRescue, waitForCiPublish } from "./lib/ci-publish.mjs";
import { promoteUnreleased, releaseNotesStatus } from "./lib/changelog.mjs";
import { assessReleaseMaterials } from "./lib/release-materials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");
const BUMPS = ["major", "minor", "patch"];
const FLAGS = new Set([
	"--dry-run",
	"--skip-tail-check",
	"--skip-changelog",
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
const skipChangelog = argv.includes("--skip-changelog");
const prepareOnly = argv.includes("--prepare-only");
const noWait = argv.includes("--no-wait");
const localPublish = argv.includes("--local");
// 排队多久算「僵尸 run」→ 补发 workflow_dispatch。0 / off 关闭。
// 先例：v0.13.0 的 tag 触发的 run 43096640287 一直 queued、started_at 为空，
// 永远不开始也不失败；健康时 run 在 3 秒内就开始，所以 60 秒足够区分。
const rescueEnv = (process.env.PI_RELEASE_RESCUE_QUEUE_MS ?? "").trim();
const rescueQueueMs =
	rescueEnv === "" ? 60_000 : Number.parseInt(rescueEnv, 10) || 0;
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
			`\n  --skip-tail-check release even when the PREVIOUS version's tag is missing remotely.` +
			`\n  --skip-changelog  bypass the release-notes material (this version ships without an announcement).`,
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

console.log(
	`${C.dim}release${C.reset} ${C.bold}${current}${C.reset} → ${C.bold}${C.green}${next}${C.reset} (${arg})`,
);

function step(label) {
	console.log(`\n${C.dim}▸${C.reset} ${C.bold}${label}${C.reset}`);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const git = process.platform === "win32" ? "git.exe" : "git";
// Even non-network gates must have an upper bound: a wedged package-manager
// child otherwise leaves the release sitting on a step header forever. Git uses
// the tighter network-probe deadline, and its ssh invocation gets the same
// deadlines as the shared GitHub helpers.
const COMMAND_TIMEOUT_MS = 15 * 60_000;

function run(cmd, args, opts = {}) {
	const isGit = cmd === git;
	const res = spawnSync(cmd, args, {
		stdio: "inherit",
		cwd: ROOT,
		timeout: isGit ? GIT_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
		killSignal: "SIGKILL",
		env: isGit
			? {
					...process.env,
					GIT_SSH_COMMAND: boundedSshCommand(process.env.GIT_SSH_COMMAND),
				}
			: process.env,
		...opts,
	});
	if (res.status !== 0 && !opts.allowFailure) {
		console.error(`${C.red}Failed: ${cmd} ${args.join(" ")}${C.reset}`);
		process.exit(res.status ?? 1);
	}
	return res;
}

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

/** Current date for a changelog heading (`YYYY-MM-DD`, local time). */
function todayStamp() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** CHANGELOG.md contents; an unreadable file reads as empty (the pre-flight reports it). */
function readChangelog() {
	try {
		return readFileSync(CHANGELOG_PATH, "utf8");
	} catch {
		return "";
	}
}

/** Run a git command tolerating failure (network checks, push). */

const branch =
	run(git, ["branch", "--show-current"], {
		stdio: "pipe",
		allowFailure: true,
	}).stdout
		.toString()
		.trim() || "master";

// 工作区状态：物料之一（见下）。
const dirty = run(git, ["status", "--porcelain"], { stdio: "pipe" })
	.stdout.toString()
	.trim();

// ── 发版物料预检（硬闸，跑在一切之前）────────────────────────────────────────
// 门禁要两分钟，而物料缺口两秒就能查出来；缺物料时最需要的是「现在去补齐」，不是
// 「等两分钟再读一条报错」。所以这里一次查齐、一次报齐，只要有一项不齐就一步都不
// 执行（不跑门禁、不写盘、不提交、不推 tag）。判定在
// scripts/lib/release-materials.mjs（纯函数，有测试）。
const materials = assessReleaseMaterials({
	current,
	next,
	arg,
	dirty,
	changelog: releaseNotesStatus(readChangelog()),
	filesIncludeChangelog: Array.isArray(pkg.files) && pkg.files.includes("CHANGELOG.md"),
	nextTagExists: tagExists(`v${next}`),
	tail: skipTailCheck
		? undefined
		: await releaseTailGap({ cwd: ROOT, git, tag: `v${current}` }),
	skipChangelog,
	skipTailCheck,
});

const MARK = { ok: `${C.green}✅`, warn: `${C.yellow}⚠ `, block: `${C.red}❌` };

function printMaterials() {
	step(`发版物料 ${current} → ${next}`);
	for (const item of materials.items) {
		console.log(`  ${MARK[item.level]}${C.reset} ${item.title}`);
		if (item.detail) {
			for (const line of item.detail.split("\n")) {
				console.log(`     ${C.dim}${line}${C.reset}`);
			}
		}
		if (item.fix) {
			const [first, ...rest] = item.fix.split("\n");
			console.log(`${C.red}     ⇒ ${first}${C.reset}`);
			for (const line of rest) console.log(`${C.red}       ${line}${C.reset}`);
		}
	}
}

if (dryRun) {
	printMaterials();
	const verdict = materials.blocked
		? `${C.yellow}物料不全 —— 实际执行会在上面这一步中止，后面的步骤都不会跑。${C.reset}`
		: `${C.dim}物料齐备。Would run:${C.reset}`;
	console.log(`\n${C.dim}--dry-run -- nothing changed.${C.reset} ${verdict}`);
	console.log(`  1. pnpm typecheck && pnpm test && pnpm ui:typecheck && pnpm ui:check`);
	let notesPlan = "  2a. CHANGELOG.md：无法提升（备注缺失，见上面的物料清单）";
	if (skipChangelog) {
		notesPlan = "  2a. CHANGELOG.md：不提升（--skip-changelog，本版没有启动公告条目）";
	} else if (materials.promoteNotes) {
		notesPlan = `  2a. CHANGELOG.md：提升 \`## Unreleased\` → \`## ${next} — <date>\``;
	}
	console.log(notesPlan);
	console.log(`  2. bump package.json version → ${next}`);
	console.log(
		`  3. git commit -m "chore: release v${next}" + tag-current（git tag v${next}）`,
	);
	console.log(`  3b. 自检：tag == HEAD 且工作区干净`);
	if (localPublish) {
		console.log(`  4. pnpm publish --no-git-checks（--local：本机直接发布，需要 npm token）`);
		console.log(`  5. git push origin ${branch} + refs/tags/v${next}`);
		console.log(`  6. 校验远端 tag + 创建 GitHub Release`);
		console.log(`  7. 收尾：tag / 本机发布 / Release 三行摘要（不查 npm）`);
	} else if (prepareOnly) {
		console.log(`  4. --prepare-only：停在 push 之前，打印推送命令（推 = 发版）`);
	} else {
		console.log(
			`  4. git push origin ${branch}（分支）→ git push origin refs/tags/v${next}（发版信号）`,
		);
		console.log(
			`  5. CI：pnpm install → typecheck / test / ui → 校验 tag==package.json → pnpm publish --provenance`,
		);
		console.log(
			`  6. 等 CI：只看 tag 触发的 workflow run（阶段 + t=Ns）；失败即中止；排队卡死的 run 自动补发` +
				`（PI_RELEASE_RESCUE_QUEUE_MS=${rescueQueueMs > 0 ? rescueQueueMs : "off"}）；` +
				`run 绿了就算完成（--no-wait 跳过）`,
		);
		console.log(
			`  7. 校验远端 tag（可见性重试）+ 创建 GitHub Release` +
				(process.env.GITHUB_TOKEN ? "" : "（未设置 GITHUB_TOKEN → Release 跳过）"),
		);
		console.log(`  8. 收尾：tag / run URL / Release URL 摘要（不查 npm）`);
	}
	process.exit(0);
}

printMaterials();
if (materials.blocked) {
	console.error(
		`\n${C.red}${C.bold}物料不全 —— 一步都没执行${C.reset}` +
			`\n${C.red}  门禁、提交、tag、push 全部没有跑：0 步中止，没有留下需要回滚的东西。` +
			`\n  按上面的 ⇒ 补齐物料，然后重跑同一条命令：pnpm release ${arg}${C.reset}`,
	);
	process.exit(1);
}
console.log(`\n${C.green}物料齐备，开始执行${C.reset}`);

// 1. Checks gate — abort before anything is changed if they fail.
step("typecheck + test + UI checks");
run(pnpm, ["typecheck"]);
run(pnpm, ["test"]);
// The UI is a separate Vite workspace and its built assets are committed. Run
// these before the version bump: a stale build would otherwise first surface
// from prepublishOnly after the release commit/tag had already been anchored.
run(pnpm, ["ui:typecheck"]);
run(pnpm, ["ui:check"]);

// 2. 提升 `## Unreleased` → `## <next> — <date>`。
// 备注在预检里已经确认过（空的段落根本走不到这里），但门禁跑完才轮到这里写盘，
// 所以再读一次文件：中途若被外部改动，宁可在写盘前重新确认，也不把没校对过的
// 文本当成「已经预检过」的内容提交。
step(`release notes → ${next}`);
if (skipChangelog) {
	console.log(
		`${C.yellow}--skip-changelog：CHANGELOG.md 未提升，本版不会有启动公告条目。${C.reset}`,
	);
} else {
	const markdown = readChangelog();
	const status = releaseNotesStatus(markdown);
	if (status.state !== "ready") {
		console.error(
			`${C.red}${C.bold}Aborting: CHANGELOG.md changed after the pre-flight.${C.reset}` +
				`\n  预检时是 ready，现在是 ${status.state}（${status.count} 条）—— 门禁跑完到写盘的这段时间里文件被改过。` +
				`\n  确认过内容后重跑同一条命令：pnpm release ${arg}（预检会重新核一遍）。`,
		);
		process.exit(1);
	}
	const date = todayStamp();
	const promoted = promoteUnreleased(markdown, next, date);
	writeFileSync(CHANGELOG_PATH, promoted.markdown, "utf8");
	console.log(
		`${C.green}## Unreleased → ## ${next} — ${date}（${promoted.notes.length} 条）${C.reset}`,
	);
}

// 3. Bump package.json (preserve formatting: 2-space indent + trailing newline).
step(`bump version → ${next}`);
pkg.version = next;
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// 4. Commit，然后调用 tag-current.mjs 打 tag（内部检测已存在 → 不重复打）。
// 此时 package.json 已是新版本，打出的 v${next} 恰好指向 release commit。
step(`git commit + tag v${next}`);
run(git, ["add", "package.json", "CHANGELOG.md"]);
run(git, ["commit", "-m", `chore: release v${next}`]);
run(process.execPath, [join(ROOT, "scripts", "tag-current.mjs")]);

// 4b. 自检：tag 必须指向 HEAD 且工作区干净 —— 保证「将要发布的 tarball
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

// 5. 检查点：--prepare-only 停在 push 之前（本地 tag 已就绪，由人决定何时推）。
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

// 6. 发版执行。默认把 tag 推给 CI —— tag push 就是发版信号。
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

// 7. 等 CI 把这一版发出去。判据只有一个：workflow run 绿了。先等再建 Release：
//    Release 不应指向一个没发出去的版本（那就是历史漂移的起点）。
let ciResult = { status: "published", run: undefined, elapsedMs: 0 };
if (!localPublish) {
	step("等待 CI 发布（tag 触发）");
	// 卡在 queued 的 run 只能靠补发救援，而 workflow_dispatch 需要 token。
	const dispatchStuck =
		rescueQueueMs > 0 && process.env.GITHUB_TOKEN
			? createDispatchRescue({
					repo: ghRepo,
					token: process.env.GITHUB_TOKEN,
					tag: `v${next}`,
					ref: branch,
					onLog: (line) => console.log(`${C.yellow}${line}${C.reset}`),
				})
			: undefined;
	if (!dispatchStuck) {
		console.log(
			`${C.dim}  （僵尸 run 自动补发已关闭：${rescueQueueMs > 0 ? "未设 GITHUB_TOKEN" : "PI_RELEASE_RESCUE_QUEUE_MS=0"}）${C.reset}`,
		);
	}
	ciResult = await waitForCiPublish({
		repo: ghRepo,
		token: process.env.GITHUB_TOKEN,
		sha: headHash,
		queuedGraceMs: rescueQueueMs > 0 ? rescueQueueMs : Infinity,
		dispatchStuck,
		log: (line) => console.log(`${C.dim}${line}${C.reset}`),
	});
	if (ciResult.status === "failed") {
		const url =
			ciResult.run?.html_url ??
			`https://github.com/${ghRepo}/actions/workflows/publish.yml`;
		console.error(
			`${C.red}${C.bold}CI publish failed for v${next}（${ciResult.conclusion ?? "?"}）.${C.reset}` +
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
			`${C.red}等待超时：15 分钟内没等到 workflow run 结束。${C.reset}` +
				(ciResult.run ? `\n  run: ${ciResult.run.html_url}` : "") +
				`\n  自己看一眼那个 run；绿了之后补 Release：pnpm release:github v${next}` +
				`\n  run 红了就修好后重跑工作流（tag 不变）。`,
		);
		process.exit(1);
	}
	console.log(
		`${C.green}✅ CI 绿了（${Math.round(ciResult.elapsedMs / 1000)}s）${C.reset}` +
			(ciResult.run?.html_url
				? ` ${C.dim}${ciResult.run.html_url}${C.reset}`
				: ""),
	);
}

// 8. GitHub Release（best-effort）。CI 绿了 = 这一版发出去了；
//    syncGitHubRelease 只做「校验远端 tag → 幂等创建 Release」。
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


// 9. 收尾 —— 只报已经确定的事实，不再回头查 npm。
//    发布成功与否由 workflow run 判定（见 waitForCiPublish 的注释）；registry 的传播
//    与 provenance 扫描是 npm 的事，想确认点开包页面即可。早先这里还轮询 npm 版本与
//    attestation，并拿它们当硬闸（缺了就 exit 1），属于过度设计：Action 之前也没有
//    人问过 npmjs「处理好了没」。
step("完成");
const runUrl =
	ciResult.run?.html_url ??
	`https://github.com/${ghRepo}/actions/workflows/publish.yml`;
const releaseDetail = releaseOk
	? (release.url ?? `v${next}`)
	: `${release.status}${release.detail ? `：${release.detail}` : ""}`;
console.log(
	`  ${C.green}✅${C.reset} tag      v${next} → ${tagHash.slice(0, 7)}` +
		`\n  ${C.green}✅${C.reset} ${localPublish ? "npm      --local（本机发布）" : `CI run   ${runUrl}`}` +
		`\n  ${releaseOk ? `${C.green}✅` : `${C.red}❌`}${C.reset} release  ${releaseDetail}` +
		`\n  ${C.dim}npm 包页面（传播与 provenance 自己看）：https://www.npmjs.com/package/${pkg.name}/v/${next}${C.reset}`,
);

console.log(
	`\n${C.green}${C.bold}✅ Released v${current} → v${next}${C.reset}` +
		`\n${C.dim}Tag: v${next} (${tagHash.slice(0, 7)}) · ` +
		(localPublish ? "npm（--local）" : "npm by GitHub Actions（OIDC + provenance）") +
		(releaseOk ? " · GitHub Release（已核实）" : " · GitHub Release 未完成，见上") +
		`${C.reset}`,
);
if (!releaseOk) {
	console.log(
		`${C.dim}补建 Release：pnpm release:github v${next}（幂等，不碰 npm 与版本号）${C.reset}`,
	);
}
// 旁路过的物料在收尾再说一次：预检的 ⚠ 会随终端滚走，而「这一版没有公告条目」
// 是升级后才会被发现的事实，值得在最后一行还看得见。
const bypassed = materials.items.filter((item) => item.level === "warn");
if (bypassed.length > 0) {
	console.log(`\n${C.yellow}本次带着旁路发布：${C.reset}`);
	for (const item of bypassed) console.log(`  ${C.yellow}⚠ ${item.title}${C.reset}`);
}
