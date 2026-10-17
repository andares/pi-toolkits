#!/usr/bin/env node
/**
 * check-compat — verify the declared pi host support policy against real hosts.
 *
 * Why this exists: the policy in AGENTS.md ("兼容最近 4 个中版本 + 向后推 8 个
 * 中版本做检查") is a claim about *published* pi releases, and a claim nobody
 * executes decays into folklore. This script derives the version set from the
 * registry, builds one sandbox per version, and runs the same gates the policy
 * names, so "we support X" is a measured statement with a rerunnable proof.
 *
 * The policy it encodes:
 *   window  — the N most recently released minor lines (default 4). Every
 *             published version in them is best-effort supported and MUST pass.
 *   forward — up to M minor lines beyond the newest released line (default 8),
 *             probed only as far as someone has actually published. A forward
 *             line that passes is the *measured* natural API compatibility; the
 *             peer upper bound encodes the cap (`<newest line + M + 1>.0.0`),
 *             and nothing beyond that cap is ever claimed.
 *
 * Sandboxes live under the system temp dir (a Linux local disk) — never under
 * /mnt/*: pnpm/vitest there are two orders of magnitude slower. Every
 * @earendil-works/* sibling is pinned to the version under test with an
 * `overrides` block, because old hosts otherwise float pi-codemode/pi-mcp to a
 * newer release and die on exports that release removed — that is dependency
 * noise, not host incompatibility, and it poisoned a past matrix run.
 *
 * Per version: install → `tsc --noEmit` → `vitest run` → keybinding audit →
 * hash the host dist files this plugin patches or mirrors. Any window failure,
 * keybinding 🔴, or peer-range inconsistency is fatal (exit 1); a forward
 * failure is reported loudly but is not fatal — it is a finding to decide on,
 * not a broken promise.
 *
 * Usage:
 *   pnpm check:compat                      # window 4 + forward 8, full gates
 *   pnpm check:compat --skip-tests         # install + dist + keys only (fast)
 *   pnpm check:compat --versions 1.2.0,1.3.0
 *   pnpm check:compat --window 4 --forward 8   # explicit policy knobs
 *   pnpm check:compat --no-keys
 *   pnpm check:compat --keep               # keep the sandboxes for inspection
 *   pnpm check:compat --concurrency 2
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const HOST_PKG = "@earendil-works/pi-coding-agent";
const FAMILY_PREFIX = "@earendil-works/";

/** Host dist files this plugin patches or mirrors — the drift surface. */
const TRACKED_HOST_FILES = [
	"dist/core/keybindings.js",
	"dist/modes/interactive/components/model-selector.js",
	"dist/core/agent-session.js",
	"dist/core/compaction/compaction.js",
	"dist/core/compaction/utils.js",
	"dist/core/usage-totals.js",
	"dist/core/extensions/types.d.ts",
];

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const optValue = (name, fallback) => {
	const i = argv.indexOf(name);
	if (i === -1) return fallback;
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) fatal(`${name} needs a value`);
	return value;
};
const has = (name) => argv.includes(name);
const opts = {
	window: Number(optValue("--window", 4)),
	forward: Number(optValue("--forward", 8)),
	versions: optValue("--versions", null),
	concurrency: Number(optValue("--concurrency", 4)),
	skipTests: has("--skip-tests"),
	keys: !has("--no-keys"),
	keep: has("--keep"),
};

function fatal(message) {
	console.error(`\n❌ ${message}\n`);
	process.exit(2);
}

// ── process plumbing ─────────────────────────────────────────────────────
function run(cmd, args, { cwd, env } = {}) {
	return new Promise((done) => {
		const child = spawn(cmd, args, {
			cwd,
			env: { ...process.env, ...env, CI: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("error", (error) => done({ ok: false, code: null, out: String(error) }));
		child.on("close", (code) => done({ ok: code === 0, code, out }));
	});
}

const tail = (text, lines = 12) =>
	text.trim().split("\n").slice(-lines).join("\n");

// ── version arithmetic (plain x.y.z; no prereleases in this family) ───────
const parseVer = (v) => {
	const [major, minor, patch] = v.split(".").map(Number);
	return { major, minor, patch, line: `${major}.${minor}` };
};
const cmpVer = (a, b) => {
	const A = parseVer(a);
	const B = parseVer(b);
	return A.major - B.major || A.minor - B.minor || A.patch - B.patch;
};
const asc = (list) => [...list].sort(cmpVer);

async function publishedVersions(pkg) {
	const res = await run("npm", ["view", pkg, "versions", "--json"]);
	if (!res.ok) fatal(`npm view ${pkg} versions failed:\n${tail(res.out)}`);
	let parsed;
	try {
		parsed = JSON.parse(res.out);
	} catch {
		fatal(`npm view ${pkg} versions returned non-JSON:\n${tail(res.out)}`);
	}
	const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) =>
		/^\d+\.\d+\.\d+$/.test(v),
	);
	if (!list.length) fatal(`no published versions found for ${pkg}`);
	return list;
}

/** Published versions grouped into minor lines, newest line first. */
function minorLines(versions) {
	const lines = new Map();
	for (const version of asc(versions)) {
		const { line } = parseVer(version);
		if (!lines.has(line)) lines.set(line, []);
		lines.get(line).push(version);
	}
	return [...lines.entries()]
		.map(([line, list]) => ({ line, versions: list }))
		.sort((a, b) => {
			const A = parseVer(a.versions[0]);
			const B = parseVer(b.versions[0]);
			return B.major - A.major || B.minor - A.minor;
		});
}

// ── policy → target set ──────────────────────────────────────────────────
/**
 * window = the N newest published minor lines; forward = the M lines after the
 * newest one, restricted to what has actually been published (usually nothing,
 * which is itself the honest answer: there is nothing to measure yet).
 */
function planTargets(versions) {
	const lines = minorLines(versions);
	if (lines.length < opts.window) {
		fatal(`only ${lines.length} minor lines published; window is ${opts.window}`);
	}
	const windowLines = lines.slice(0, opts.window);
	const newest = parseVer(lines[0].versions.at(-1));
	const forwardLines = [];
	for (let i = 1; i <= opts.forward; i++) {
		const line = `${newest.major}.${newest.minor + i}`;
		forwardLines.push({ line, versions: lines.find((l) => l.line === line)?.versions ?? [] });
	}
	const windowVersions = asc(windowLines.flatMap((l) => l.versions));
	const forwardVersions = asc(forwardLines.flatMap((l) => l.versions));
	return {
		lines,
		windowLines,
		windowVersions,
		forwardLines,
		forwardVersions,
		floor: windowVersions[0],
		capLine: forwardLines.at(-1).line,
		upperExclusive: `${newest.major}.${newest.minor + opts.forward + 1}.0`,
		expectedRange: `>=${windowVersions[0]} <${newest.major}.${newest.minor + opts.forward + 1}.0`,
	};
}

// ── sandbox ──────────────────────────────────────────────────────────────
function sha(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Read a package.json; a malformed manifest is a finding, never a crash. */
function readJson(path, what) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fatal(`cannot read ${what} at ${path}: ${error.message}`);
	}
}

async function inspectHost(root) {
	const version = readJson(join(root, "package.json"), "host manifest").version;
	const files = {};
	for (const rel of TRACKED_HOST_FILES) {
		const path = join(root, rel);
		files[rel] = existsSync(path) ? sha(readFileSync(path)) : "missing";
	}
	return { version, files };
}

function makeSandbox(version) {
	const dir = join(tmpdir(), "pi-toolkits-compat", version);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const entry of ["src", "scripts", "tsconfig.json"]) {
		cpSync(join(REPO, entry), join(dir, entry), { recursive: true });
	}
	const pkg = readJson(join(REPO, "package.json"), "package.json");
	// Pin everything this package resolves from the host family to the version
	// under test, so a floating range cannot silently test a different host.
	for (const name of [
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
	]) {
		if (name.startsWith(FAMILY_PREFIX)) pkg.devDependencies[name] = version;
	}
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
	const workspace = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");
	if (/^overrides:/m.test(workspace)) {
		fatal(
			"pnpm-workspace.yaml already declares `overrides` — check:compat appends its\n" +
				"own and a duplicate YAML key would fail late. Merge the family pins manually.",
		);
	}
	const overrides = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui", "pi-telemetry", "pi-codemode", "pi-mcp"];
	writeFileSync(
		join(dir, "pnpm-workspace.yaml"),
		`${workspace.trimEnd()}\n\n# appended by scripts/check-compat.mjs: pin the whole family to ${version}\noverrides:\n` +
			overrides.map((name) => `  "${FAMILY_PREFIX}${name}": "${version}"`).join("\n") +
			"\n",
	);
	return dir;
}

async function testVersion(version, inWindow) {
	const mark = (status) => console.log(`   ${status} ${version} (${inWindow ? "window" : "forward"})`);
	console.log(`  → ${version} (${inWindow ? "window" : "forward"}) install`);
	const dir = makeSandbox(version);
	const hostRoot = join(dir, "node_modules", ...HOST_PKG.split("/"));
	const result = { version, inWindow, pass: false, stages: {}, notes: [] };

	const install = await run("pnpm", ["install", "--prefer-offline", "--reporter=append-only"], { cwd: dir });
	result.stages.install = install.ok;
	if (!install.ok) {
		result.notes.push(`install failed:\n${tail(install.out, 15)}`);
		mark("❌");
		return result;
	}

	const host = await inspectHost(hostRoot);
	if (host.version !== version) {
		result.notes.push(`resolved ${HOST_PKG}@${host.version}, expected ${version}`);
		result.stages.install = false;
		mark("❌");
		return result;
	}
	// A sibling that floated off the tested version invalidates the run: this
	// package imports host internals, and a mixed tree tests neither version.
	const familyDir = join(dir, "node_modules", FAMILY_PREFIX);
	const floated = [];
	if (existsSync(familyDir)) {
		for (const name of readdirSync(familyDir)) {
			const path = join(familyDir, name, "package.json");
			if (!existsSync(path)) continue;
			const resolved = readJson(path, `manifest of ${name}`).version;
			if (resolved !== version && !name.startsWith("pi-client") && name !== "pi-protocol") {
				floated.push(`${name}@${resolved}`);
			}
		}
	}
	if (floated.length) result.notes.push(`deps floated: ${floated.join(", ")}`);

	const typecheck = await run("pnpm", ["exec", "tsc", "--noEmit"], { cwd: dir });
	result.stages.typecheck = typecheck.ok;
	if (!typecheck.ok) result.notes.push(`typecheck failed:\n${tail(typecheck.out, 15)}`);

	let tests = { ok: false, out: "" };
	if (opts.skipTests) {
		result.stages.tests = null;
	} else {
		tests = await run("pnpm", ["exec", "vitest", "run"], { cwd: dir });
		result.stages.tests = tests.ok;
		if (!tests.ok) result.notes.push(`tests failed:\n${tail(tests.out, 15)}`);
	}
	const counts = /Tests\s+(.+)/.exec(tests.out)?.[1]?.trim();
	result.tests = counts ?? (opts.skipTests ? "skipped" : "?");

	if (opts.keys) {
		const keys = await run("node", ["scripts/check-keybindings.mjs"], {
			cwd: dir,
			env: { PI_HOST_PKG: hostRoot },
		});
		const reds = (keys.out.match(/🔴/g) ?? []).length;
		result.stages.keys = reds === 0 && keys.ok;
		result.keys = { reds, table: /bindings table : (\d+)/.exec(keys.out)?.[1] ?? "?" };
		if (!result.stages.keys) result.notes.push(`keybinding audit:\n${tail(keys.out, 20)}`);
	} else {
		result.stages.keys = null;
	}

	result.host = host;
	result.pass = Object.values(result.stages).every((stage) => stage !== false);
	mark(result.pass ? "✅" : "❌");
	return result;
}

// ── report ───────────────────────────────────────────────────────────────
const cell = (stage) => (stage === null ? "–" : stage ? "✅" : "❌");

function report(plan, results) {
	const baseline = results.find((r) => r.version === plan.windowVersions.at(-1));
	console.log("\n=== compatibility matrix ===");
	console.log(
		["version  set      install typecheck tests        keys   dist"].join("  "),
	);
	for (const result of [...results].sort((a, b) => cmpVer(a.version, b.version))) {
		const set = result.inWindow ? "window " : "forward";
		const keys = result.keys ? (result.keys.reds ? `🔴${result.keys.reds}` : "✅") : "–";
		let dist = "–";
		if (result.host && baseline?.host) {
			const drift = TRACKED_HOST_FILES.filter(
				(rel) => result.host.files[rel] !== baseline.host.files[rel],
			);
			dist = drift.length === 0 ? `= ${baseline.version}` : `≠ ${drift.length} file(s)`;
		}
		console.log(
			[
				result.version.padEnd(7),
				set.padEnd(7),
				cell(result.stages.install).padEnd(7),
				cell(result.stages.typecheck).padEnd(9),
				String(result.tests ?? "?").padEnd(12),
				keys.padEnd(6),
				dist,
			].join("  "),
		);
	}

	const failures = results.filter((result) => !result.pass);
	const windowFails = failures.filter((result) => result.inWindow);
	const forwardFails = failures.filter((result) => !result.inWindow);
	// Highest version V such that everything tested at or below V passes.
	const measuredTop = [...results]
		.sort((a, b) => cmpVer(a.version, b.version))
		.reduce((top, result) => (result.pass ? result.version : top), null);

	console.log("\n=== verdict ===");
	console.log(
		`window   : ${plan.windowVersions.join(" / ")} — ` +
			(windowFails.length ? `❌ ${windowFails.length} failing` : "all pass") +
			`\nforward  : probe lines ${plan.forwardLines[0].line} … ${plan.capLine} — ` +
			(plan.forwardVersions.length
				? `${plan.forwardVersions.length} published, ` +
					(forwardFails.length ? `❌ ${forwardFails.length} failing` : "all pass")
				: "nothing published yet beyond the newest line"),
	);
	console.log(`peer     : declared ${readPeerRange() ?? "(missing)"}`);
	console.log(`           expected ${plan.expectedRange}   (floor = oldest window version, cap = newest line + ${opts.forward})`);

	if (measuredTop) console.log(`docs     : 实测自然兼容最高 ${measuredTop} — keep README/AGENTS.md in sync`);
	const lines = results.filter((result) => result.notes.length);
	if (lines.length) {
		console.log("\n--- notes ---");
		for (const result of lines) {
			for (const note of result.notes) console.log(`\n[${result.version}]\n${note}`);
		}
	}

	let exitCode = 0;
	if (windowFails.length) {
		console.log(
			`\n❌ A version inside the declared window fails — that is a broken promise,\n` +
				`   not a forward finding. Fix it or raise the floor (with a measured reason).`,
		);
		exitCode = 1;
	}
	if (results.some((result) => result.keys?.reds)) {
		console.log(
			`\n❌ A declared key is consumed upstream (🔴) on some host. Key choices belong\n` +
				`   to the operator: report the collision and the candidate alternatives, do\n` +
				`   not silently re-key. See AGENTS.md → 键位冲突检查义务.`,
		);
		exitCode = 1;
	}
	const declared = readPeerRange();
	if (declared !== plan.expectedRange) {
		console.log(
			`\n❌ package.json peer range (${declared ?? "missing"}) does not match the policy\n` +
				`   (${plan.expectedRange}). Update it so the declaration tracks the window.`,
		);
		exitCode = 1;
	}
	if (!exitCode) {
		console.log(
			forwardFails.length
				? "\n⚠ forward probes fail (see notes) — do NOT extend the peer range past the\n" +
						"  last all-green version without a decision; report the failure."
				: "\n✅ Declared range is honest for every published version that exists.",
		);
	}
	return exitCode;
}

function readPeerRange() {
	const pkg = readJson(join(REPO, "package.json"), "package.json");
	const raw = pkg.peerDependencies?.[HOST_PKG];
	if (!raw) return null;
	return raw.replace(/\s+/g, " ").trim();
}

// ── main ─────────────────────────────────────────────────────────────────
const versions = await publishedVersions(HOST_PKG);
const plan = planTargets(versions);
const targets = opts.versions
	? asc(opts.versions.split(",").map((v) => v.trim()))
	: [...plan.windowVersions, ...plan.forwardVersions];
const windowSet = new Set(plan.windowVersions);

console.log(
	`pi host family : ${HOST_PKG} (published: ${versions.length} versions)\n` +
		`window         : last ${opts.window} minor lines — ${plan.windowLines.map((l) => l.line).join(" / ")}\n` +
		`                 versions: ${plan.windowVersions.join(", ")}\n` +
		`forward        : up to ${opts.forward} lines after newest (${plan.forwardLines[0].line} … ${plan.capLine})\n` +
		`                 published: ${plan.forwardVersions.join(", ") || "(none yet)"}\n` +
		`sandboxes      : ${join(tmpdir(), "pi-toolkits-compat")}\n` +
		`targets        : ${targets.join(", ")}` +
		`\nconcurrency    : ${opts.concurrency}${opts.skipTests ? "   (tests skipped)" : ""}`,
);

const results = [];
const queue = [...targets];
const workers = [];
for (let i = 0; i < Math.max(1, Math.min(opts.concurrency, queue.length)); i++) {
	workers.push(
		(async () => {
			while (queue.length) {
				const version = queue.shift();
				results.push(await testVersion(version, windowSet.has(version)));
			}
		})(),
	);
}
await Promise.all(workers);

const exitCode = report(plan, results);
if (!opts.keep) rmSync(join(tmpdir(), "pi-toolkits-compat"), { recursive: true, force: true });
process.exit(exitCode);
