#!/usr/bin/env node
/**
 * check-compat — verify the pi host-compatibility policy against real hosts.
 *
 * The policy is directional and that direction is the whole point: pi releases
 * only move forward, so *compatibility can only be proven backwards*. Nothing
 * about a future release can be measured, and a claim about one would be a
 * wish, not a measurement.
 *
 *   window (mandatory, default 4 newest minor lines)
 *     Every published version in the 4 most recently released minor lines MUST
 *     pass. If it does not, we change OUR code — hardcode for the old shape,
 *     keep using an API upstream is about to deprecate, whatever it takes.
 *     Failing a window version is never a reason to raise the floor.
 *
 *   probe (detection only, default 4 more older minor lines, 4 + 4 = 8)
 *     After the window is green, walk further BACK through older minor lines.
 *     Passing probes extend the *measured* floor; the first failing probe line
 *     stops the walk and is NOT fixed — no code changes for probe-only hosts.
 *
 *   public floor
 *     The oldest version in the contiguous all-green run from the newest
 *     release downwards. That single number is what users see ("works with pi
 *     >= X"); the 4-version promise is an internal policy users need not know.
 *     The peer range encodes exactly it — `>=<floor>` — and deliberately has
 *     no upper bound: we do not claim any future release.
 *
 * Sandboxes live under the system temp dir (a Linux local disk) — never under
 * /mnt/*: pnpm/vitest there are two orders of magnitude slower. Every
 * @earendil-works/* sibling is pinned to the version under test with an
 * `overrides` block, because old hosts otherwise float pi-codemode/pi-mcp to a
 * newer release and die on exports that release removed — that is dependency
 * noise, not host incompatibility, and it poisoned a past matrix run.
 *
 * Per version: install → `tsc --noEmit` → `vitest run` → keybinding audit →
 * hash the host dist files this plugin patches or mirrors. Window failures and
 * keybinding 🔴 are fatal (exit 1); probe failures are findings that set the
 * public floor, never a reason to touch the code.
 *
 * Usage:
 *   pnpm check:compat                      # window 4 + probe 4, full gates
 *   pnpm check:compat --skip-tests         # install + dist + keys only (fast)
 *   pnpm check:compat --versions 1.2.0,1.3.0
 *   pnpm check:compat --window 4 --probe 4    # explicit policy knobs
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
	probe: Number(optValue("--probe", 4)),
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
 * window  = the N newest published minor lines (mandatory, all must pass).
 * probe   = the M published minor lines just below the window (detection only,
 *           walked newest → oldest, stopping at the first failing line).
 *           Lines that were never published (0.88–0.98) simply do not exist in
 *           the list, so the budget always means "M lines that really exist".
 */
function planTargets(versions) {
	const lines = minorLines(versions);
	if (lines.length < opts.window) {
		fatal(`only ${lines.length} minor lines published; window is ${opts.window}`);
	}
	const windowLines = lines.slice(0, opts.window);
	const probeLines = lines.slice(opts.window, opts.window + opts.probe);
	const windowVersions = asc(windowLines.flatMap((l) => l.versions));
	return {
		lines,
		newest: asc(lines[0].versions).at(-1),
		windowLines,
		windowVersions,
		probeLines,
		probeVersions: asc(probeLines.flatMap((l) => l.versions)),
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

/**
 * kind: "window" (mandatory — failures are ours to fix) or "probe" (detection
 * only — a failure just ends the backward walk).
 */
async function testVersion(version, kind) {
	const mark = (status) => console.log(`   ${status} ${version} (${kind})`);
	console.log(`  → ${version} (${kind}) install`);
	const dir = makeSandbox(version);
	const hostRoot = join(dir, "node_modules", ...HOST_PKG.split("/"));
	const result = { version, kind, pass: false, stages: {}, notes: [] };

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

async function runPool(versions, kind, limit = opts.concurrency) {
	const queue = [...versions];
	const out = [];
	const workers = [];
	for (let i = 0; i < Math.max(1, Math.min(limit, queue.length)); i++) {
		workers.push(
			(async () => {
				while (queue.length) out.push(await testVersion(queue.shift(), kind));
			})(),
		);
	}
	await Promise.all(workers);
	return out.sort((a, b) => cmpVer(a.version, b.version));
}

// ── report ───────────────────────────────────────────────────────────────
const cell = (stage) => (stage === null ? "–" : stage ? "✅" : "❌");

/**
 * Oldest version of the contiguous all-green run that starts at the newest
 * tested version. Probes stop at the first failing line, so this is the
 * measured public floor rather than the policy window.
 */
function measuredFloor(results) {
	const ordered = [...results].sort((a, b) => cmpVer(b.version, a.version));
	let floor = null;
	for (const result of ordered) {
		if (!result.pass) break;
		floor = result.version;
	}
	return floor;
}

function report(plan, results, { full }) {
	const baseline = results.find((r) => r.version === plan.windowVersions.at(-1));
	console.log("\n=== compatibility matrix ===");
	console.log(
		["version  set      install typecheck tests        keys   dist"].join("  "),
	);
	for (const result of [...results].sort((a, b) => cmpVer(a.version, b.version))) {
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
				result.kind.padEnd(7),
				cell(result.stages.install).padEnd(7),
				cell(result.stages.typecheck).padEnd(9),
				String(result.tests ?? "?").padEnd(12),
				keys.padEnd(6),
				dist,
			].join("  "),
		);
	}

	const failures = results.filter((result) => !result.pass);
	const windowFails = failures.filter((result) => result.kind === "window");
	const probeFails = failures.filter((result) => result.kind === "probe");
	const floor = measuredFloor(results);
	let probeState;
	if (!plan.probeLines.length) probeState = "probe budget empty (no older published line)";
	else if (probeFails.length) probeState = `stopped at ${probeFails[0].version} (probe-only: not fixed)`;
	else probeState = "all pass";

	console.log("\n=== verdict ===");
	console.log(
		`window (mandatory) : ${plan.windowVersions.join(" / ")} — ` +
			(windowFails.length ? `❌ ${windowFails.length} failing` : "all pass"),
	);
	console.log(
		`probe  (detection) : lines ${plan.probeLines.map((l) => l.line).join(" / ") || "(none)"} — ${probeState}`,
	);
	console.log(
		`public floor       : ${floor ?? "(none — the newest window version fails)"}` +
			`   ← the only number users see: "pi >= ${floor ?? "?"}"`,
	);
	const expectedRange = floor ? `>=${floor}` : null;
	console.log(`peer               : declared ${readPeerRange() ?? "(missing)"}`);
	console.log(
		`                     expected ${expectedRange ?? "(none)"}   (floor only — no upper bound,` +
			` no claim about future releases)`,
	);

	const notes = results.filter((result) => result.notes.length);
	if (notes.length) {
		console.log("\n--- notes ---");
		for (const result of notes) {
			for (const note of result.notes) console.log(`\n[${result.version}]\n${note}`);
		}
	}

	let exitCode = 0;
	if (windowFails.length) {
		console.log(
			`\n❌ A version inside the mandatory window fails (${windowFails
				.map((r) => r.version)
				.join(", ")}).\n` +
				`   This is ours to fix: hardcode the old shape, keep a deprecated-but-working\n` +
				`   host API — whatever it takes. Raising the floor is NOT an option.`,
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
	if (full && !windowFails.length) {
		const declared = readPeerRange();
		if (declared !== expectedRange) {
			console.log(
				`\n❌ package.json peer range (${declared ?? "missing"}) does not match the measured\n` +
					`   floor (${expectedRange}). Users only need the public floor; set it so the\n` +
					`   declaration tracks what was actually verified.`,
			);
			exitCode = 1;
		}
	}
	if (!exitCode) {
		console.log(
			probeFails.length
				? `\n✅ Window is green. The backward walk stopped at ${probeFails[0].version}; that\n` +
						`   is a detection result, not a bug to fix. Public floor stays ${floor}.`
				: `\n✅ Declared floor (>=${floor}) is backed by every published version from\n` +
						`   ${floor} to ${plan.newest}, and no future release is claimed.`,
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

console.log(
	`pi host family : ${HOST_PKG} (published: ${versions.length} versions)\n` +
		`window         : mandatory, last ${opts.window} minor lines — ${plan.windowLines.map((l) => l.line).join(" / ")}\n` +
		`                 versions: ${plan.windowVersions.join(", ")}\n` +
		`probe          : detection only, up to ${opts.probe} older lines — ` +
		`${plan.probeLines.map((l) => l.line).join(" / ") || "(none)"}\n` +
		`                 versions: ${plan.probeVersions.join(", ") || "(none)"}\n` +
		`sandboxes      : ${join(tmpdir(), "pi-toolkits-compat")}\n` +
		`concurrency    : ${opts.concurrency}${opts.skipTests ? "   (tests skipped)" : ""}`,
);

let results;
if (opts.versions) {
	// Explicit probe: no policy verdict beyond the per-version gates.
	const list = asc(opts.versions.split(",").map((v) => v.trim()));
	const windowSet = new Set(plan.windowVersions);
	console.log(`targets        : ${list.join(", ")}   (explicit --versions: policy checks skipped)`);
	results = await runPool(list, "window");
	for (const result of results) {
		result.kind = windowSet.has(result.version) ? "window" : "probe";
	}
} else {
	// 1. Mandatory window first — probes only make sense once it is green.
	console.log(`targets        : window ${plan.windowVersions.join(", ")}`);
	const windowResults = await runPool(plan.windowVersions, "window");
	results = [...windowResults];
	const windowGreen = windowResults.every((result) => result.pass);
	if (windowGreen && plan.probeLines.length) {
		// 2. Walk backwards line by line; the first failing line ends the walk.
		for (const line of plan.probeLines) {
			console.log(`  probe line ${line.line}: ${line.versions.join(", ")}`);
			const lineResults = await runPool(line.versions, "probe");
			results.push(...lineResults);
			if (lineResults.some((result) => !result.pass)) break;
		}
	} else if (windowGreen) {
		console.log("  probe: nothing older published to walk into");
	} else {
		console.log("  probe: skipped — the mandatory window must be green first");
	}
}

const exitCode = report(plan, results, { full: !opts.versions });
if (!opts.keep) rmSync(join(tmpdir(), "pi-toolkits-compat"), { recursive: true, force: true });
process.exit(exitCode);
