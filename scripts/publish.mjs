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
 *   validate arg → warn on dirty git tree (non-blocking) → typecheck + test
 *   → bump package.json → git commit `chore: release vX.Y.Z` + tag `vX.Y.Z`
 *     (tag via scripts/tag-current.mjs — skips if already exists)
 *   → `pnpm publish` (pnpm-only repo — never `npm publish`). `prepublishOnly`
 *     re-runs typecheck + test as the publish gate.
 *   → npm 成功后（失败即中止）：git push origin <branch> --tags（尝试一次，
 *     失败仅警告——可能此前已推过）+ 用 GITHUB_TOKEN 创建 GitHub Release
 *     v{next}（best-effort：未设 token / 已存在 / 失败都只提示、不中止）。
 *
 * `--dry-run` prints the plan (version + steps) and exits without changing
 * anything.
 *
 * Notes:
 *  - Git commit + tag are part of the release. `pnpm publish` is called with
 *    `--no-git-checks` so unrelated uncommitted work in the tree doesn't
 *    block the publish (the version-bump commit is staged explicitly).
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

const branch =
	run(git, ["branch", "--show-current"], {
		stdio: "pipe",
		allowFailure: true,
	}).stdout
		.toString()
		.trim() || "master";

if (dryRun) {
	console.log(`\n${C.dim}--dry-run -- nothing changed. Would run:${C.reset}`);
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
	console.log(`  4. pnpm publish --no-git-checks`);
	console.log(
		`  5. git push origin ${branch} --tags + GitHub Release v${next}` +
			(process.env.GITHUB_TOKEN
				? ""
				: `（未设置 GITHUB_TOKEN → 仅 push，Release 跳过）`),
	);
	process.exit(0);
}

// Dirty-tree warning (non-blocking; publish uses --no-git-checks).
const dirty = run(git, ["status", "--porcelain"], { stdio: "pipe" })
	.stdout.toString()
	.trim();
if (dirty) {
	console.warn(
		`${C.yellow}Warning: uncommitted changes present:\n${dirty
			.split("\n")
			.map((l) => `  ${l}`)
			.join("\n")}${C.reset}`,
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

// 5. GitHub：push 分支 + tags（尝试一次，失败仅警告——可能此前已推过；
// 确保 tag 在远端存在后再建 Release，否则 API 会自动建 tag 指向默认分支
// 的 HEAD，可能不是 release commit）。然后创建 GitHub Release v${next}
// （best-effort：未设 token / 已存在 / 失败都只提示，不中止）。
step("git push + GitHub Release");
const push = run(git, ["push", "origin", branch, "--tags"], {
	allowFailure: true,
});
if (push.status !== 0) {
	console.warn(
		`${C.yellow}git push 失败（可能此前已推过，可忽略）。` +
			`若远端还没有 tag v${next}，Release 将无法指向 release commit。${C.reset}`,
	);
}
if (!process.env.GITHUB_TOKEN) {
	console.warn(
		`${C.yellow}未设置 GITHUB_TOKEN — 跳过 GitHub Release 创建。` +
			`npm 已发布 v${next}，可稍后手动创建 release。${C.reset}`,
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
	if (rel.status === 0 && code === "201") {
		console.log(`${C.green}GitHub Release v${next} 创建成功${C.reset}`);
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
		`\n${C.dim}Tag: v${next} · commit: chore: release v${next} · npm` +
		` · GitHub Release${C.reset}`,
);
