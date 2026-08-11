#!/usr/bin/env node
/**
 * 给当前 package.json 的版本号打 git tag（vX.Y.Z）。
 *
 *   pnpm tag-current             # 打 tag：v{当前版本}，已存在则跳过
 *   pnpm tag-current --dry-run   # 只预览，不修改任何东西
 *
 * 行为：
 *  - tag 名 = `v${package.json 的 version}`，打在当前 HEAD 上
 *  - 检测 tag 是否已存在（git rev-parse --verify）——已存在则跳过、不重复打
 *  - **只打本地 tag，不推送**（推送由 release-all 的 GitHub 步骤负责）
 *
 * 在 release-all 中 bump + commit 之后调用：此时 package.json 已是新版本，
 * 打出的 tag 恰好指向 release commit。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const git = process.platform === "win32" ? "git.exe" : "git";

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

const dryRun = process.argv.slice(2).includes("--dry-run");

let pkg;
try {
	pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
} catch {
	console.error(
		`${C.red}package.json is missing or not valid JSON: ${PKG_PATH}${C.reset}`,
	);
	process.exit(1);
}
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(
		`${C.red}Unexpected package.json version: ${JSON.stringify(version)}${C.reset}`,
	);
	process.exit(1);
}
const tag = `v${version}`;

function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
	if (res.status !== 0 && !opts.allowFailure) {
		console.error(`${C.red}Failed: ${cmd} ${args.join(" ")}${C.reset}`);
		process.exit(res.status ?? 1);
	}
	return res;
}

// 检测 tag 是否已存在——已存在则跳过，不重复打。
const exists =
	run(git, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
		stdio: "pipe",
		allowFailure: true,
	}).status === 0;
if (exists) {
	console.log(`${C.yellow}tag ${tag} 已存在，跳过打 tag（不重复打）${C.reset}`);
	process.exit(0);
}

if (dryRun) {
	console.log(
		`${C.dim}--dry-run -- nothing changed. Would run:${C.reset}` +
			`\n  git tag ${tag}`,
	);
	process.exit(0);
}

run(git, ["tag", tag]);
console.log(`${C.green}✅ git tag ${tag}${C.reset}（本地 tag，未推送）`);
