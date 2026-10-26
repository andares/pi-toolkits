#!/usr/bin/env node
/**
 * approval-report — summarize the rolling approval log (`~/.pi/agent/approval-log`).
 *
 * The log exists to answer one question: which approval decisions should the
 * permission layer make on its own? This script is read-only and dependency
 * free. It streams every `audit-*.jsonl` file (lexical order = time order) and
 * prints the aggregates that lead to a rule:
 *
 *  - answer distribution and dialog latency (how much friction is there?),
 *  - deciding layer and tool/scope/effect mix (is the parser or a mode doing
 *    the work?),
 *  - target roots with their answers (which directories are almost always
 *    allowed? which ones are denied?),
 *  - opaque commands (where the decomposer needs teaching),
 *  - repeated ask patterns, including playwright calls,
 *  - session counters, for a rough ask rate.
 *
 * Usage:
 *   node scripts/approval-report.mjs [--dir <path>] [--since <ISO>]
 *                                    [--top <n>] [--min <n>] [--json]
 *
 * Exit code: 0 on success (including "no records"), 2 on bad arguments or an
 * unreadable directory.
 */
import { createReadStream, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const HELP = `Usage: node scripts/approval-report.mjs [options]

  --dir <path>    log directory (default: $PI_APPROVAL_LOG_DIR or ~/.pi/agent/approval-log)
  --since <ISO>   only records at or after this time
  --top <n>       rows per table (default 15)
  --min <n>       minimum asks before a root is proposed as a rule (default 3)
  --json          machine-readable output
  -h, --help      this text`;

function parseArgs(argv) {
	const options = {
		dir:
			process.env.PI_APPROVAL_LOG_DIR ??
			join(homedir(), ".pi", "agent", "approval-log"),
		since: undefined,
		top: 15,
		min: 3,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dir") {
			const value = argv[++i];
			if (!value) throw new Error("--dir needs a path");
			options.dir = resolve(value);
		} else if (arg === "--since") {
			const value = argv[++i];
			if (!value) throw new Error("--since needs an ISO timestamp");
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) {
				throw new Error(`--since is not a date: ${value}`);
			}
			options.since = date;
		} else if (arg === "--top") {
			const value = Number(argv[++i]);
			if (!Number.isFinite(value) || value < 1) {
				throw new Error("--top needs a positive number");
			}
			options.top = Math.floor(value);
		} else if (arg === "--min") {
			const value = Number(argv[++i]);
			if (!Number.isFinite(value) || value < 1) {
				throw new Error("--min needs a positive number");
			}
			options.min = Math.floor(value);
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(`${HELP}\n`);
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

function listFiles(dir) {
	try {
		return readdirSync(dir)
			.filter((name) => /^audit-\d{6,}\.jsonl$/.test(name))
			.sort();
	} catch (error) {
		throw new Error(
			`cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function clip(value, max = 160) {
	let text;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === undefined) return "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function bump(map, key, amount = 1) {
	map.set(key, (map.get(key) ?? 0) + amount);
}

function bucket() {
	return {
		asks: 0,
		allow: 0,
		allowSession: 0,
		deny: 0,
		denySession: 0,
		cancelled: 0,
		notPresented: 0,
		error: 0,
	};
}

function addAnswer(target, record) {
	target.asks++;
	const choice = record.answer?.choice;
	if (choice === "allow") target.allow++;
	else if (choice === "allow-session") target.allowSession++;
	else if (choice === "deny") target.deny++;
	else if (choice === "deny-session") target.denySession++;
	else if (record.outcome === "cancelled") target.cancelled++;
	else if (record.outcome === "not-presented") target.notPresented++;
	else target.error++;
}

function median(values) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

// Match playwright as an actually-invoked command (segment start, a package
// runner, node, or sudo) or as an MCP tool. A plain substring is too broad:
// `.../login/playwright-token` is an API endpoint and `grep -i playwright` is
// a search, not a browser run.
const PLAYWRIGHT = /(?:^|[;&|]\s*)(?:[^\s;|&]*\/)?playwright(?:[\s/]|$)|(?:^|[;&|]\s*)(?:sudo\s+)?(?:npx|pnpm|yarn|bun|node)\s+(?:(?:exec|run|dlx|--)\s+)*(?:[^\s;|&]*\/)?playwright(?:[\s/]|$)|mcp__[^\s]*playwright|browser_(?:navigate|click|type|screenshot|close)/i;

function patternKey(record) {
	const command = record.input?.command;
	if (typeof command === "string" && command !== "") return clip(command, 180);
	return `${record.tool ?? "?"} ${clip(record.input ?? {}, 140)}`;
}

async function readRecords(dir, files, since) {
	const records = [];
	let bad = 0;
	for (const name of files) {
		const input = createReadStream(join(dir, name), { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (line.trim() === "") continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				bad++;
				continue;
			}
			if (!record || typeof record !== "object") {
				bad++;
				continue;
			}
			if (since !== undefined) {
				const ts = new Date(record.ts);
				if (Number.isNaN(ts.getTime()) || ts < since) continue;
			}
			records.push(record);
		}
	}
	return { records, bad };
}

function summarize({ dir, files, records, bad, options }) {
	const events = new Map();
	const outcomes = new Map();
	const choices = new Map();
	const layers = new Map();
	const tools = new Map();
	const answers = bucket();
	const targets = new Map();
	const opaque = new Map();
	const patterns = new Map();
	const playwright = new Map();
	const modeChanges = [];
	const sessions = new Set();
	const latencies = [];
	const queueLatencies = [];
	const range = { first: undefined, last: undefined };
	const counters = { summaries: 0, calls: 0, asks: 0, blocks: 0 };

	for (const record of records) {
		const event = typeof record.event === "string" ? record.event : "?";
		bump(events, event);
		if (typeof record.session === "string") sessions.add(record.session);
		const ts = typeof record.ts === "string" ? record.ts : undefined;
		if (ts !== undefined) {
			if (range.first === undefined || ts < range.first) range.first = ts;
			if (range.last === undefined || ts > range.last) range.last = ts;
		}

		if (event === "ask") {
			addAnswer(answers, record);
			bump(outcomes, record.outcome ?? "?");
			bump(choices, record.answer?.choice ?? record.outcome ?? "?");
			const verdict = record.verdict ?? {};
			bump(layers, verdict.layer ?? "?");
			bump(tools, `${record.tool ?? "?"} · ${verdict.effect ?? "?"} · ${verdict.scope ?? "?"}`);
			if (typeof record.answer?.ms === "number") {
				latencies.push(record.answer.ms);
				// `ms` includes time spent queued behind another dialog from the same
				// assistant message; subtract it so the operator's own reaction time
				// is not inflated by batching.
				const queueMs =
					typeof record.answer.queueMs === "number" ? record.answer.queueMs : 0;
				queueLatencies.push(Math.max(0, record.answer.ms - queueMs));
			}
			const target = verdict.target;
			const root =
				typeof verdict.grantRoot === "string"
					? verdict.grantRoot
					: typeof target === "string"
						? dirname(target)
						: "(no target)";
			const entry = targets.get(root) ?? bucket();
			addAnswer(entry, record);
			targets.set(root, entry);

			if (Array.isArray(record.units)) {
				for (const unit of record.units) {
					if (unit?.opaque === true) {
						bump(opaque, clip(unit.raw ?? unit.note ?? "opaque", 160));
					}
				}
			}
			const key = patternKey(record);
			const pattern = patterns.get(key) ?? bucket();
			addAnswer(pattern, record);
			patterns.set(key, pattern);

			const haystack = `${record.tool ?? ""} ${record.input?.command ?? ""} ${clip(record.input ?? {}, 400)}`;
			if (PLAYWRIGHT.test(haystack)) {
				const pw = playwright.get(key) ?? bucket();
				addAnswer(pw, record);
				playwright.set(key, pw);
			}
		} else if (event === "allow") {
			bump(layers, `allow:${record.verdict?.layer ?? "?"}`);
		} else if (event === "block") {
			bump(layers, `block:${record.verdict?.layer ?? record.gate ?? "?"}`);
		} else if (event === "mode") {
			modeChanges.push(record);
		} else if (event === "session") {
			counters.summaries++;
			const counts = record.counts ?? {};
			if (typeof counts.calls === "number") counters.calls += counts.calls;
			if (typeof counts.asks === "number") counters.asks += counts.asks;
			if (typeof counts.blocks === "number") counters.blocks += counts.blocks;
		}
	}

	const sorted = (map) =>
		[...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

	const targetRows = [...targets.entries()]
		.map(([root, value]) => ({ root, ...value }))
		.sort((a, b) => b.asks - a.asks || a.root.localeCompare(b.root));

	const candidates = targetRows
		.filter((row) => row.asks >= options.min)
		.map((row) => ({
			root: row.root,
			asks: row.asks,
			answers: `${row.allow}+${row.allowSession} allow / ${row.deny}+${row.denySession} deny / ${row.cancelled + row.notPresented + row.error} other`,
			verdict:
				row.deny + row.denySession === 0 && row.allow + row.allowSession > 0
					? "candidate auto-allow"
					: row.denySession > 0 || row.deny >= 2
						? "candidate auto-deny"
						: "mixed",
		}))
		.filter((row) => row.verdict !== "mixed");

	return {
		dir,
		files,
		records: records.length,
		bad,
		range,
		events: Object.fromEntries(sorted(events)),
		asks: answers,
		outcomes: Object.fromEntries(sorted(outcomes)),
		choices: Object.fromEntries(sorted(choices)),
		medianMs: median(latencies),
		medianDialogMs: median(queueLatencies),
		layers: Object.fromEntries(sorted(layers)),
		tools: Object.fromEntries(sorted(tools)),
		targets: targetRows.slice(0, options.top),
		candidates,
		opaque: sorted(opaque)
			.slice(0, options.top)
			.map(([pattern, count]) => ({ pattern, count })),
		patterns: sorted(patterns)
			.slice(0, options.top)
			.map(([pattern, value]) => ({ pattern, ...value })),
		playwright: sorted(playwright)
			.slice(0, options.top)
			.map(([pattern, value]) => ({ pattern, ...value })),
		modeChanges: {
			total: modeChanges.length,
			recent: modeChanges.slice(-10),
		},
		sessions: {
			seen: sessions.size,
			...counters,
		},
	};
}

function fmt(value, width) {
	const text = String(value ?? "");
	return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function printReport(report) {
	const out = [];
	const push = (line = "") => out.push(line);

	push("Approval log report");
	push(`  dir:      ${report.dir}`);
	push(`  files:    ${report.files.length}${report.files.length === 0 ? "" : ` (${report.files[0]} … ${report.files.at(-1)})`}`);
	push(`  records:  ${report.records}${report.bad === 0 ? "" : ` (+${report.bad} unparseable lines skipped)`}`);
	if (report.range.first !== undefined) {
		push(`  range:    ${report.range.first} → ${report.range.last}`);
	}
	push(`  sessions: ${report.sessions.seen} seen (${report.sessions.summaries} summaries)`);
	push();

	push("Events");
	for (const [event, count] of Object.entries(report.events)) {
		push(`  ${fmt(event, 10)} ${count}`);
	}
	push();

	push("Asks");
	push(
		`  total ${report.asks.asks} · allowed ${report.asks.allow + report.asks.allowSession} · blocked ${report.asks.deny + report.asks.denySession} · cancelled ${report.asks.cancelled} · not-presented ${report.asks.notPresented} · error ${report.asks.error}`,
	);
	if (report.medianMs !== undefined) {
		push(
			`  median blocked ${(report.medianMs / 1000).toFixed(2)}s · ` +
				`median dialog ${((report.medianDialogMs ?? report.medianMs) / 1000).toFixed(2)}s`,
		);
	}
	for (const [choice, count] of Object.entries(report.choices)) {
		push(`  ${fmt(choice, 16)} ${count}`);
	}
	push();

	push("Deciding layer");
	for (const [layer, count] of Object.entries(report.layers)) {
		push(`  ${fmt(layer, 22)} ${count}`);
	}
	push();

	push("Asks by tool · effect · scope");
	for (const [key, count] of Object.entries(report.tools)) {
		push(`  ${fmt(key, 38)} ${count}`);
	}
	push();

	push(`Top target roots (${report.targets.length})`);
	for (const row of report.targets) {
		push(
			`  ${fmt(row.root, 46)} ${fmt(row.asks, 4)} asks · ${row.allow}+${row.allowSession} allow · ${row.deny}+${row.denySession} deny · ${row.cancelled + row.notPresented + row.error} other`,
		);
	}
	push();

	if (report.candidates.length > 0) {
		push("Rule candidates");
		for (const row of report.candidates) {
			push(`  [${row.verdict}] ${row.root} — ${row.asks} asks (${row.answers})`);
		}
		push();
	}

	if (report.opaque.length > 0) {
		push("Opaque units (parser gaps)");
		for (const row of report.opaque) {
			push(`  ${fmt(row.count, 4)} ${row.pattern}`);
		}
		push();
	}

	if (report.patterns.length > 0) {
		push("Repeated ask patterns");
		for (const row of report.patterns) {
			if (row.asks < 2) continue;
			push(
				`  ${fmt(row.asks, 4)} asks · ${row.allow}+${row.allowSession} allow · ${row.deny}+${row.denySession} deny · ${row.pattern}`,
			);
		}
		push();
	}

	if (report.playwright.length > 0) {
		push("Playwright");
		for (const row of report.playwright) {
			push(
				`  ${fmt(row.asks, 4)} asks · ${row.allow}+${row.allowSession} allow · ${row.deny}+${row.denySession} deny · ${row.pattern}`,
			);
		}
		push();
	}

	if (report.modeChanges.total > 0) {
		push("Recent mode changes");
		for (const record of report.modeChanges.recent) {
			const modes = record.modes
				? Object.entries(record.modes)
						.map(([key, value]) => `${key}=${value}`)
						.join(" ")
				: "?";
			push(
				`  ${record.ts ?? "?"} ${record.enabled ? "ON " : "OFF"} ${modes} (${record.source ?? "?"}/${record.via ?? "?"})`,
			);
		}
		push();
	}

	if (report.sessions.summaries > 0) {
		push("Session counters");
		push(
			`  ${report.sessions.calls} gated calls · ${report.sessions.asks} asks · ${report.sessions.blocks} blocks` +
				(report.sessions.calls > 0
					? ` · ask rate ${((report.sessions.asks / report.sessions.calls) * 100).toFixed(1)}%`
					: ""),
		);
		push();
	}

	process.stdout.write(`${out.join("\n")}\n`);
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n\n${HELP}\n`,
		);
		process.exitCode = 2;
		return;
	}

	let files;
	try {
		files = listFiles(options.dir);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 2;
		return;
	}
	if (files.length === 0) {
		process.stdout.write(`No approval log files under ${options.dir}\n`);
		return;
	}

	const { records, bad } = await readRecords(options.dir, files, options.since);
	const report = summarize({
		dir: options.dir,
		files,
		records,
		bad,
		options,
	});
	if (options.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		printReport(report);
	}
}

main().catch((error) => {
	process.stderr.write(
		`approval-report failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
