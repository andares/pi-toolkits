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
 *   → `pnpm publish` (pnpm-only repo — never `npm publish`). `prepublishOnly`
 *   re-runs typecheck + test as the publish gate.
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
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

if (!BUMPS.includes(arg)) {
	console.error(
		`${C.red}${C.bold}Usage: pnpm release <${BUMPS.join("|")}>${C.reset}` +
			`\n  Bump the package version and publish to npm (requires exactly one argument).` +
			`\n  Add --dry-run to preview without changing anything.`,
	);
	process.exit(1);
}
if (process.argv.slice(2).filter((a) => a !== "--dry-run").length > 1) {
	console.error(`${C.red}Exactly one of ${BUMPS.join("|")} is required.${C.reset}`);
	process.exit(1);
}

let pkg;
try {
	pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
} catch {
	console.error(`${C.red}package.json is missing or not valid JSON: ${PKG_PATH}${C.reset}`);
	process.exit(1);
}
const current = pkg.version;
if (typeof current !== "string" || !/^\d+\.\d+\.\d+$/.test(current)) {
	console.error(`${C.red}Unexpected package.json version: ${JSON.stringify(current)}${C.reset}`);
	process.exit(1);
}

const [maj, min, pat] = current.split(".").map(Number);
let next;
if (arg === "major") next = `${maj + 1}.0.0`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else next = `${maj}.${min}.${pat + 1}`;

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

if (dryRun) {
	console.log(`\n${C.dim}--dry-run -- nothing changed. Would run:${C.reset}`);
	console.log(`  1. pnpm typecheck && pnpm test`);
	console.log(`  2. bump package.json version → ${next}`);
	console.log(`  3. git commit -m "chore: release v${next}" && git tag v${next}`);
	console.log(`  4. pnpm publish --no-git-checks`);
	process.exit(0);
}

// Dirty-tree warning (non-blocking; publish uses --no-git-checks).
const dirty = run(git, ["status", "--porcelain"], { stdio: "pipe" }).stdout
	.toString()
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

// 3. Commit + tag.
step(`git commit + tag v${next}`);
run(git, ["add", "package.json"]);
run(git, ["commit", "-m", `chore: release v${next}`]);
run(git, ["tag", `v${next}`]);

// 4. Publish (prepublishOnly re-gates with typecheck + test).
step("pnpm publish");
const publish = run(pnpm, ["publish", "--no-git-checks"], { allowFailure: true });
if (publish.status !== 0) {
	console.error(
		`${C.red}Publish failed. The version bump is already committed + tagged as v${next}.` +
			`\n  To roll back: git tag -d v${next} && git reset --hard HEAD~1${C.reset}`,
	);
	process.exit(publish.status ?? 1);
}

console.log(
	`\n${C.green}${C.bold}✅ Published v${current} → v${next}${C.reset}` +
		`\n${C.dim}Tag: v${next} · commit: chore: release v${next}${C.reset}`,
);
