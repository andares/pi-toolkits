#!/usr/bin/env node
/**
 * check-keybindings — probe the installed pi host for keybinding conflicts.
 *
 * Why this exists: pi 1.0 made `fullscreen` the default `tuiMode`, and in
 * fullscreen mode `TuiAltScreen.handleViewportInput()` consumes the
 * `tui.altScreen.*` family BEFORE deferring input to the focused overlay
 * (dialogs like the /model selector). On Windows/WSL several of those
 * bindings differ from the Linux defaults (`tui.altScreen.search` resolves to
 * ctrl+f instead of ctrl+shift+f). A selector-scoped key that looks free in
 * the table can therefore be dead on arrival — that is how the favorites
 * toggle silently lost ctrl+f in 1.0.
 *
 * This script uses the host's OWN `matchesKey` + resolved keybinding table
 * (including the platform/WSL overrides and ~/.pi/agent/keybindings.json), so
 * it reports what pi actually dispatches, not what a comment claims.
 *
 * Usage:
 *   pnpm check:keybindings                 # audit the keys this plugin declares
 *   pnpm check:keybindings alt+f ctrl+alt+f # audit candidate keys
 *   pnpm check:keybindings --all           # dump every host binding
 *   PI_HOST_PKG=/abs/path/to/@earendil-works/pi-coding-agent node scripts/check-keybindings.mjs
 *
 * Exit code: 1 when a key declared by this plugin is consumed upstream (hard
 * conflict), 0 otherwise. Candidate keys are reported, never fatal.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// ── host resolution ──────────────────────────────────────────────────────
// The host's keybinding table is not an exported subpath, so import the dist
// file directly. A layout change here is itself a finding: report it loudly.
const hostRoots = [
	process.env.PI_HOST_PKG,
	join(REPO, "node_modules/@earendil-works/pi-coding-agent"),
].filter(Boolean);

async function loadHost() {
	const failures = [];
	for (const root of hostRoots) {
		const entry = join(root, "dist/core/keybindings.js");
		try {
			const mod = await import(entry);
			const pkg = JSON.parse(
				readFileSync(join(root, "package.json"), "utf8"),
			);
			return { mod, version: pkg.version, path: entry, root };
		} catch (error) {
			failures.push(`${entry}: ${error.code ?? error.message}`);
		}
	}
	console.error("Could not load the pi host keybinding table.");
	for (const line of failures) console.error(`  ${line}`);
	console.error(
		"If the host dist layout moved, update this script AND re-run the\n" +
			"keybinding audit mandated in AGENTS.md.",
	);
	process.exit(2);
}

const host = await loadHost();
const { KEYBINDINGS, KeybindingsManager, useWindowsKeybindings } = host.mod;
const kb = KeybindingsManager.create(); // includes the user's keybindings.json
const allIds = Object.keys(KEYBINDINGS);

// ── key inventory: parse the plugin's own declarations (single source) ────
function declaredKeys() {
	const files = [
		["favorites", "src/features/favorites/constants.ts"],
		["stash", "src/features/stash/stash.ts"],
	];
	/** A key spec is a single base key or a modifier combo — not e.g. a status id. */
	const isKeySpec = (value) =>
		value.includes("+") ||
		(value.length === 1 && /[a-z0-9]/i.test(value)) ||
		value.toLowerCase() in SPECIAL;
	const found = [];
	for (const [feature, rel] of files) {
		const src = readFileSync(join(REPO, rel), "utf8");
		const re = /export const (\w+)(?:\s*:\s*[\w<>[\]| ]+)?\s*=\s*"([^"]+)"/g;
		for (const [, name, value] of src.matchAll(re)) {
			if (!/KEY$/.test(name)) continue;
			if (!isKeySpec(value)) {
				console.log(
					`  (skipped ${name} = ${JSON.stringify(value)} in ${rel}: not a key spec)`,
				);
				continue;
			}
			found.push({ feature, name, key: value, file: rel });
		}
	}
	if (found.length === 0) {
		console.error("Parsed no key constants — the declaration shape changed.");
		process.exit(2);
	}
	return found;
}

// ── byte synthesis (letters only; that is the family this plugin uses) ────
const SPECIAL = {
	escape: "\x1b",
	esc: "\x1b",
	enter: "\r",
	return: "\r",
	tab: "\t",
	space: " ",
	backspace: "\x7f",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
};

/** Raw bytes a non-kitty terminal sends for `keyId`, or undefined. */
function legacyBytes(keyId) {
	const parts = keyId.toLowerCase().split("+");
	const base = parts.pop();
	const mods = new Set(parts);
	const letter = base.length === 1 ? base : undefined;
	if (!letter || !/[a-z]/.test(letter)) return SPECIAL[base];
	const ctrl = String.fromCharCode(letter.charCodeAt(0) & 0x1f);
	if (mods.has("ctrl") && mods.has("alt")) return `\x1b${ctrl}`;
	if (mods.has("ctrl")) return ctrl;
	if (mods.has("alt")) return `\x1b${letter}`;
	if (mods.has("shift")) return letter.toUpperCase();
	return letter;
}

/** Kitty keyboard protocol (CSI-u) bytes for `keyId`, or undefined. */
function kittyBytes(keyId) {
	const parts = keyId.toLowerCase().split("+");
	const base = parts.pop();
	const letter = base.length === 1 ? base : undefined;
	if (!letter || !/[a-z]/.test(letter)) return undefined;
	const code = letter.charCodeAt(0);
	const mods = new Set(parts);
	const modifier =
		1 +
		(mods.has("shift") ? 1 : 0) +
		(mods.has("alt") ? 2 : 0) +
		(mods.has("ctrl") ? 4 : 0);
	return `\x1b[${code};${modifier}u`;
}

// ── policy ───────────────────────────────────────────────────────────────
// Modeled on the real dispatch order in pi-tui's
// TuiAltScreen.handleViewportInput() (verified 1.0.4):
//
//   1. tui.altScreen.search            → consumed UNCONDITIONALLY
//   2. searchNext/Previous/Close       → only while the transcript search box
//                                        itself is focused (never with a dialog
//                                        open — so those are NOT fatal)
//   3. shouldDeferViewportInputToOverlay() → overlay (dialog) gets the key
//   4. pageUp/halfPage/lineUp/previousPrompt/nextPrompt/top/bottom
//                                      → viewport scrolling; below the defer
//                                        guard, i.e. only when nothing is
//                                        focused over it
//
// Everything the host does not claim here reaches the patched component, where
// our handleInput wrapper runs before the search box sees the key.
const POLICIES = [
	{
		tier: "RED",
		label:
			"🔴 consumed upstream — the key never reaches the component we patch",
		fatal: true,
		match: (id) => id === "tui.altScreen.search",
	},
	{
		tier: "ORANGE",
		label:
			"🟠 transcript-search overlay key — only active while that search box is focused",
		fatal: false,
		match: (id) =>
			/^tui\.altScreen\.(searchNext|searchPrevious|searchClose)$/.test(id),
	},
	{
		tier: "BLUE",
		label: "🔵 viewport/app binding — verify which screen owns it",
		fatal: false,
		match: (id) => /^tui\.altScreen\./.test(id) || /^app\./.test(id),
	},
	{
		tier: "YELLOW",
		label:
			"🟡 editor/input binding — suppressed only where we intercept (selector scope)",
		fatal: false,
		match: (id) => /^tui\.(editor|input|select)\./.test(id),
	},
];

/** Group claimants by policy tier (first match wins, so tiers stay disjoint). */
function classify(claimants) {
	const remaining = new Set(claimants);
	const groups = [];
	for (const policy of POLICIES) {
		const ids = [...remaining].filter(policy.match);
		if (!ids.length) continue;
		for (const id of ids) remaining.delete(id);
		groups.push({ ...policy, ids });
	}
	if (remaining.size) {
		groups.push({
			tier: "BLUE",
			label: "🔵 unclassified host binding — review manually",
			fatal: false,
			ids: [...remaining],
		});
	}
	return groups;
}

/**
 * Machine-layer grabs the host table cannot see. Encodes real incidents:
 * ctrl+alt+f passed the host audit but was taken by a Windows screenshot
 * tool; ctrl+v / ctrl+shift+f are Windows Terminal defaults. Advisories are
 * never fatal — the host table cannot know any user's machine — but every
 * ⚠ demands a real keypress on the target machine before shipping the key.
 */
const EXTERNAL_GRABS = [
	{
		match: (key) => key === "ctrl+v",
		note: "Windows Terminal default: Paste (and pasting a model name into the search box is a feature, not a slot to steal)",
	},
	{
		match: (key) => key === "ctrl+shift+f",
		note: "Windows Terminal default: Find",
	},
	{
		match: (key) => /^ctrl\+alt\+[a-z0-9]$/i.test(key),
		note: "commonly bound by third-party Windows utilities (screenshot/efficiency tools took ctrl+alt+f); verify on the real machine",
	},
];

function audit(keyId) {
	const legacy = legacyBytes(keyId);
	const kitty = kittyBytes(keyId);
	const rows = [];
	for (const [mode, data] of [
		["legacy", legacy],
		["kitty", kitty],
	]) {
		if (data === undefined) continue;
		rows.push({ mode, data, claimants: allIds.filter((id) => kb.matches(data, id)) });
	}
	const printable = legacy !== undefined && legacy.length === 1 && legacy >= " " && legacy !== "\x7f";
	return { keyId, legacy, kitty, rows, printable };
}

function render(result) {
	const { keyId, legacy, kitty, rows, printable } = result;
	console.log(`\n${keyId}   legacy=${JSON.stringify(legacy ?? "?")}  kitty=${JSON.stringify(kitty ?? "?")}`);
	if (rows.length === 0) {
		console.log("  ⚠  no byte form derived (unsupported base key) — manual review needed");
		return { red: false, free: false };
	}
	let red = false;
	let free = true;
	for (const row of rows) {
		const tiers = classify(row.claimants);
		if (row.claimants.length === 0) {
			console.log(`  ${row.mode.padEnd(6)} ✅ free`);
			continue;
		}
		free = false;
		for (const tier of tiers) {
			if (tier.fatal) red = true;
			console.log(`  ${row.mode.padEnd(6)} ${tier.label}`);
			for (const id of tier.ids) console.log(`           - ${id}`);
		}
	}
	if (printable) {
		console.log(
			`  🔴 legacy bytes are the printable character ${JSON.stringify(legacy)}: ` +
				"without the kitty protocol this steals typed text from the selector's search box",
		);
		red = true;
	}
	for (const grab of EXTERNAL_GRABS) {
		if (grab.match(keyId)) {
			console.log(`  ⚠ machine layer: ${grab.note}`);
		}
	}
	return { red, free };
}

// ── main ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
console.log(
	`pi host        : ${host.version}  (${host.root})\n` +
		`platform       : ${process.platform}   WSL/Windows keybindings: ${useWindowsKeybindings()}\n` +
		`WSL_DISTRO_NAME: ${process.env.WSL_DISTRO_NAME ?? "(unset)"}\n` +
		`bindings table : ${allIds.length} binding ids`,
);

if (argv.includes("--all")) {
	console.log("\n=== host binding table (resolved) ===");
	for (const id of allIds) {
		const keys = kb.getKeys(id);
		if (keys.length) console.log(`  ${id.padEnd(34)} ${keys.join(", ")}`);
	}
}

const declared = declaredKeys();
const candidates = argv.filter((arg) => !arg.startsWith("-"));

console.log("\n=== keys declared by this plugin ===");
let failed = false;
for (const entry of declared) {
	console.log(`\n[${entry.feature}] ${entry.name} (${entry.file})`);
	const outcome = render(audit(entry.key));
	if (outcome.red) failed = true;
}

if (candidates.length) {
	console.log("\n=== candidate keys ===");
	for (const key of candidates) render(audit(key));
}

if (failed) {
console.log(
"\n❌ A declared key is consumed upstream (🔴 or a printable legacy form).\n" +
"   Replace it and re-run. Scope rules and the machine-layer ⚠ advisories:\n" +
"   see the 键位冲突检查义务 section in AGENTS.md.",
);
process.exit(1);
}
console.log("\n✅ No upstream conflict among the keys this plugin declares.");
