/**
 * init feature — `/ask-init`.
 *
 * One command, two jobs:
 *
 *  1. **Install** the agent-memory framework into a project (fresh), and
 *  2. **Adopt / reconcile** it where documentation already exists — moving the
 *     old agent-only directories under `.agents/`, rewriting the path
 *     references, and handing the prose work to the model as a bounded work
 *     order.
 *
 * The split is deliberate: everything mechanical is code (deterministic,
 * snapshot-first, idempotent), everything that needs judgement is a task. That
 * keeps the command cheap, the diff reviewable, and "nothing was lost" checkable
 * through the coverage table instead of trust.
 *
 * Guards, in order:
 *  - never in the operator's home directory or at the filesystem root;
 *  - never while the agent is streaming (a plan needs a stable tree);
 *  - never without `write`/`edit` in the active tool set (`/ask` mode would
 *    reject the model's own work);
 *  - never writes without an explicit decision (TUI panel; no UI ⇒ report only).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stateToToml } from "./apply.js";
import { applyPlan } from "./apply.js";
import { audit, countFindings, renderFindings } from "./audit.js";
import { detect } from "./detect.js";
import { buildWorkOrder } from "./dispatch.js";
import { buildPlan, iso, runStamp } from "./plan.js";
import { rootsBlock } from "./render.js";
import {
	FRAMEWORK_DIR,
	FRAMEWORK_VERSION,
	REPORTS_DIR,
	STATE_FILE,
	type ProjectLanguage,
} from "./spec.js";
import { FRAMEWORK_AUDIT_TOOL } from "./tool.js";
import { confirmPlan, showReport } from "./ui.js";
import type { ApplyResult, Plan } from "./types.js";
import { registerAuditTool } from "./tool.js";

export interface InitOptions {
	/** Test seam; defaults to `ctx.cwd`. */
	readonly root?: string;
	/** Test seam for pi-add-dir roots; defaults to the session branch entry. */
	readonly addedRoots?: Array<{ label: string; absolute: string }>;
	readonly now?: Date;
	/** Test seam; defaults to the package version. */
	readonly toolVersion?: string;
}

export interface ParsedInitArgs {
	readonly sub: "run" | "plan" | "check" | "roots" | "help";
	readonly dryRun: boolean;
	readonly deep: boolean;
	readonly yes: boolean;
	readonly lang?: ProjectLanguage;
	/** Unknown arguments are an error, never a silent full run. */
	readonly error?: string;
}

const USAGE = [
	"/ask-init                 detect → confirm → scaffold → hand content work to the model",
	"/ask-init plan [--deep]   show the plan only (writes nothing)",
	"/ask-init check           audit the installed framework (read-only)",
	"/ask-init roots           sync pi-add-dir roots into the framework state",
	"/ask-init --dry-run       same as plan",
	"/ask-init --yes           skip the confirmation panel",
	"/ask-init --lang zh|en    language for generated prose",
].join("\n");

export function parseInitArgs(input: string): ParsedInitArgs {
	const tokens = input.trim().split(/\s+/).filter((token) => token.length > 0);
	let sub: ParsedInitArgs["sub"] = "run";
	let dryRun = false;
	let deep = false;
	let yes = false;
	let lang: ProjectLanguage | undefined;
	const unknown: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "plan" || token === "check" || token === "roots" || token === "help") {
			sub = token;
			continue;
		}
		if (token === "run") continue;
		if (token === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (token === "--deep") {
			deep = true;
			continue;
		}
		if (token === "--yes" || token === "-y") {
			yes = true;
			continue;
		}
		if (token === "--lang") {
			const value = tokens[index + 1];
			if (value === "zh" || value === "en") {
				lang = value;
				index += 1;
			} else {
				unknown.push(`${token} ${value ?? "(missing value)"}`);
				index += 1;
			}
			continue;
		}
		if (token.startsWith("--lang=")) {
			const value = token.slice("--lang=".length);
			if (value === "zh" || value === "en") lang = value;
			else unknown.push(token);
			continue;
		}
		unknown.push(token);
	}
	if (dryRun && sub === "run") sub = "plan";
	return {
		sub,
		dryRun,
		deep,
		yes,
		lang,
		error:
			unknown.length > 0
				? `unknown argument(s): ${unknown.join(", ")} — nothing was done`
				: undefined,
	};
}

/* -------------------------------------------------------------------------- */
/* Session roots                                                               */
/* -------------------------------------------------------------------------- */

interface AddDirState {
	dirs?: Array<{ label?: string; absolutePath?: string }>;
}

/** pi-add-dir records its directory list as a session custom entry. */
export function addedRootsFromBranch(ctx: ExtensionContext): Array<{
	label: string;
	absolute: string;
}> {
	let entries: unknown[] = [];
	try {
		entries = ctx.sessionManager.getBranch() as unknown[];
	} catch {
		return [];
	}
	let dirs: AddDirState["dirs"] = [];
	for (const entry of entries) {
		const record = entry as {
			type?: string;
			customType?: string;
			data?: AddDirState;
		};
		if (record.type !== "custom" || record.customType !== "add-dir:state") continue;
		if (Array.isArray(record.data?.dirs)) dirs = record.data.dirs;
	}
	return (dirs ?? [])
		.map((dir) => ({
			label: typeof dir?.label === "string" && dir.label.length > 0 ? dir.label : basename(String(dir?.absolutePath ?? "")),
			absolute: typeof dir?.absolutePath === "string" ? dir.absolutePath : "",
		}))
		.filter((dir) => dir.absolute.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function packageVersion(): string {
	try {
		const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function guardRoot(root: string): string | undefined {
	const absolute = resolve(root);
	if (absolute === resolve("/") || absolute === resolve(homedir())) {
		return "refusing to install a project framework at the filesystem root or in the home directory";
	}
	if (!existsSync(absolute)) return `directory does not exist: ${absolute}`;
	return undefined;
}

function guardTools(pi: ExtensionAPI): string | undefined {
	const active = new Set(pi.getActiveTools());
	const missing = ["write", "edit"].filter((name) => !active.has(name));
	if (missing.length === 0) return undefined;
	return `${missing.join("/")} is not active in this session (ask mode?) — leave that mode first, then run /ask-init`;
}

function activateAuditTool(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (active.includes(FRAMEWORK_AUDIT_TOOL)) return;
	pi.setActiveTools([...active, FRAMEWORK_AUDIT_TOOL]);
}

function deactivateAuditTool(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (!active.includes(FRAMEWORK_AUDIT_TOOL)) return;
	pi.setActiveTools(active.filter((name) => name !== FRAMEWORK_AUDIT_TOOL));
}

function writeRuntimeReport(root: string, name: string, text: string): string | undefined {
	if (!existsSync(join(root, FRAMEWORK_DIR))) return undefined;
	const rel = `${REPORTS_DIR}/${name}`;
	const absolute = join(root, rel);
	mkdirSync(join(root, REPORTS_DIR), { recursive: true });
	writeFileSync(absolute, text, "utf8");
	return rel;
}

function planText(plan: Plan): string {
	const lines = [
		`/ask-init — ${plan.mode}`,
		`root: ${plan.root}`,
		`framework: v${plan.frameworkVersion} · language: ${plan.language}`,
		"",
		"## plan",
		...plan.summary.map((line) => `- ${line}`),
	];
	if (plan.warnings.length > 0) {
		lines.push("", "## warnings", ...plan.warnings.map((line) => `- ${line}`));
	}
	if (plan.actions.length > 0) {
		lines.push("", "## mechanical actions");
		for (const action of plan.actions) {
			switch (action.kind) {
				case "snapshot":
					lines.push(`- snapshot ${action.paths.length} paths`);
					break;
				case "move-dir":
					lines.push(`- move ${action.from}/ → ${action.to}/ (${action.files} files)`);
					break;
				case "move-file":
					lines.push(`- move ${action.from} → ${action.to} (content untouched)`);
					break;
				case "rewrite-refs":
					lines.push(
						`- rewrite ${action.pairs.map((pair) => `${pair.from}→${pair.to}`).join(", ")} (${action.hits} refs in ${action.files} files)`,
					);
					break;
				case "create-dirs":
					lines.push(`- create dirs ${action.paths.join(", ")}`);
					break;
				case "create-file":
					lines.push(`- create ${action.path} (${action.note})`);
					break;
				case "write-state":
					lines.push("- write .agents/framework/state.toml");
					break;
			}
		}
	}
	if (plan.tasks.length > 0) {
		lines.push("", "## model tasks");
		for (const task of plan.tasks) lines.push(`- ${task.id}${task.targets ? ` [${task.targets.join(", ")}]` : ""}`);
	}
	return lines.join("\n");
}

function appliedText(applied: ApplyResult): string {
	const lines = ["## applied"];
	if (applied.snapshot) {
		lines.push(`- snapshot: ${applied.snapshot.dir} (${applied.snapshot.files} files)`);
	}
	for (const move of applied.moved) {
		lines.push(`- moved ${move.from}/ → ${move.to}/ (${move.files} files)`);
	}
	if (applied.rewrites) {
		lines.push(
			`- rewrote ${applied.rewrites.hits} references in ${applied.rewrites.files} files → ${applied.rewrites.report}`,
		);
	}
	if (applied.created.length > 0) {
		lines.push(`- created: ${applied.created.join(", ")}`);
	}
	if (applied.statePath) lines.push(`- state: ${applied.statePath}`);
	if (applied.planPath) lines.push(`- work order: ${applied.planPath}`);
	for (const skipped of applied.skipped) {
		lines.push(`- skipped ${skipped.path} (${skipped.reason})`);
	}
	return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Command                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write the roots observed in this session into the framework state, and show the
 * table. Only the state file is touched: the AGENTS.md roots section is a model
 * task (it needs prose and the change-impact context).
 */
async function syncRoots(
	ctx: ExtensionContext,
	root: string,
	facts: ReturnType<typeof detect>,
	now: Date,
): Promise<void> {
	if (!facts.state) {
		ctx.ui.notify("ask-init roots: no framework state yet — run /ask-init first.", "warning");
		return;
	}
	const before = facts.state.roots.map((entry) => `${entry.label}|${entry.absolute}`).join("\n");
	const after = facts.roots.map((entry) => `${entry.label}|${entry.absolute}`).join("\n");
	if (before === after) {
		ctx.ui.notify(`ask-init roots: up to date (${facts.roots.length} registered).`, "info");
	} else {
		// roots is a small write, but it still changes project state: keep the
		// same snapshot-first rule as the full migration.
		const backup = join(
			root,
			FRAMEWORK_DIR,
			"snapshots",
			`roots-${runStamp(iso(now))}`,
			"files",
			STATE_FILE,
		);
		mkdirSync(dirname(backup), { recursive: true });
		copyFileSync(join(root, STATE_FILE), backup);
		mkdirSync(join(root, FRAMEWORK_DIR), { recursive: true });
		writeFileSync(
			join(root, STATE_FILE),
			stateToToml({ ...facts.state, roots: facts.roots, updated: iso(now) }),
			"utf8",
		);
		ctx.ui.notify(`ask-init roots: ${facts.roots.length} roots written to ${STATE_FILE}.`, "info");
	}
	const table = rootsBlock(facts.roots, facts.language);
	if (table.length > 0) await showReport(ctx, "ask-init roots", table);
	if (facts.roots.length > 0 && facts.context.agents && !/Workspace roots|工作区根/.test(facts.context.agents.text)) {
		ctx.ui.notify(
			"ask-init roots: AGENTS.md has no roots section yet — /ask-init will add it (model task root-cards).",
			"info",
		);
	}
}

async function reportAudit(
	ctx: ExtensionContext,
	root: string,
	facts: ReturnType<typeof detect>,
	now: Date,
): Promise<void> {
	const findings = audit(facts);
	const text = renderFindings(findings, { root, frameworkVersion: FRAMEWORK_VERSION });
	const rel = writeRuntimeReport(root, `audit-${runStamp(iso(now))}.md`, text);
	const counts = countFindings(findings);
	ctx.ui.notify(
		`ask-init check: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.infos} info${rel ? ` → ${rel}` : ""}`,
		counts.errors > 0 ? "error" : counts.warnings > 0 ? "warning" : "info",
	);
	await showReport(ctx, "ask-init check", text, { path: rel });
}

/**
 * Apply the deterministic half, record it, then hand the prose work to the
 * model. Activation of the audit tool happens here and is asserted again in
 * `before_agent_start`, because pi rebuilds the tool loadout for the new run.
 */
async function applyAndDispatch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	plan: Plan,
	runtime: { auditActive: boolean },
	now: Date,
): Promise<ApplyResult> {
	const applied = applyPlan(plan, { now });
	runtime.auditActive = true;
	activateAuditTool(pi);

	pi.appendEntry("ask-init:run", {
		mode: plan.mode,
		summary: [...plan.summary, ...applied.summary],
		at: plan.createdAt,
	});

	ctx.ui.notify(
		`ask-init: ${plan.mode} applied — ${applied.summary.slice(0, 2).join(" · ")}`,
		"info",
	);
	await showReport(ctx, `ask-init ${plan.mode}`, appliedText(applied), {
		path: applied.planPath,
	});

	pi.sendUserMessage(buildWorkOrder({ plan, applied, planPath: applied.planPath }), {
		expandPromptTemplates: false,
	});
	ctx.ui.notify(
		"ask-init: work order dispatched; run /reload after the run so the new AGENTS.md enters the prompt.",
		"info",
	);
	return applied;
}

/**
 * The command body, kept out of `registerInit` so registration stays a thin
 * table of hooks and the dispatcher can be read on its own.
 */
function createRunHandler(
	pi: ExtensionAPI,
	options: InitOptions,
	runtime: { auditActive: boolean },
) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const parsed = parseInitArgs(args);
		if (parsed.sub === "help") {
			await showReport(ctx, "/ask-init", USAGE);
			return;
		}
		if (parsed.error) {
			ctx.ui.notify(`ask-init: ${parsed.error}`, "error");
			await showReport(ctx, "/ask-init", USAGE);
			return;
		}

		const root = options.root ?? ctx.cwd;
		const rootError = guardRoot(root);
		if (rootError) {
			ctx.ui.notify(`ask-init: ${rootError}`, "error");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("ask-init: the agent is still streaming — finish or abort first.", "warning");
			return;
		}

		const toolVersion = options.toolVersion ?? packageVersion();
		const now = options.now ?? new Date();
		const addedRoots = options.addedRoots ?? addedRootsFromBranch(ctx);
		const facts = detect(root, { addedRoots, lang: parsed.lang });

		const doCheck = (): Promise<void> => reportAudit(ctx, root, facts, now);

		if (parsed.sub === "check") {
			await doCheck();
			return;
		}

		if (parsed.sub === "roots") {
			await syncRoots(ctx, root, facts, now);
			return;
		}

		const plan = buildPlan(facts, {
			deep: parsed.deep,
			toolVersion,
			now,
		});

		if (parsed.sub === "plan") {
			await showReport(ctx, "ask-init plan", planText(plan));
			if (plan.warnings.length > 0) {
				ctx.ui.notify(`ask-init plan: ${plan.warnings.length} warning(s) — see the panel.`, "warning");
			}
			ctx.ui.notify("ask-init: report only — nothing was written.", "info");
			return;
		}

		if (plan.mode === "unsupported") {
			ctx.ui.notify(
				plan.warnings[plan.warnings.length - 1] ??
					"ask-init: this project's framework is newer than this tool.",
				"error",
			);
			await showReport(ctx, "ask-init", planText(plan));
			return;
		}
		if (plan.mode === "upgrade") {
			// There is no v1 upgrade recipe. Reporting is safe; applying a scaffold
			// over an older state file would be a guess, not a migration.
			await showReport(ctx, "ask-init upgrade", planText(plan));
			ctx.ui.notify(
				"ask-init: no automatic upgrade recipe for this state version — nothing was written. Migrate by hand after reviewing .agents/memory/README.md.",
				"warning",
			);
			return;
		}
		if (plan.mode === "audit-only") {
			await doCheck();
			return;
		}

		const toolError = guardTools(pi);
		if (toolError) {
			ctx.ui.notify(`ask-init: ${toolError}`, "error");
			return;
		}

		const decision = parsed.yes ? "proceed" : await confirmPlan(ctx, plan);
		if (decision === "cancel") {
			ctx.ui.notify("ask-init: cancelled — nothing was written.", "info");
			return;
		}
		if (decision === "dry-run") {
			await showReport(ctx, "ask-init plan", planText(plan));
			ctx.ui.notify("ask-init: report only — nothing was written.", "info");
			return;
		}

		await applyAndDispatch(pi, ctx, plan, runtime, now);
	};
}

export function registerInit(pi0: ExtensionAPI, options: InitOptions = {}): void {
	const pi = pi0;
	const runtime = { auditActive: false };

	registerAuditTool(pi);

	// ask mode replaces the active tool set at run start (loadout preparation
	// runs after `session_start`), so the audit tool is asserted here as well as
	// at dispatch time — the same lesson the scratchpad tool learned.
	pi.on("before_agent_start", () => {
		if (runtime.auditActive) activateAuditTool(pi);
	});
	pi.on("agent_end", () => {
		if (!runtime.auditActive) return;
		runtime.auditActive = false;
		deactivateAuditTool(pi);
	});

	pi.registerEntryRenderer<{ mode: string; summary: string[]; at: string }>(
		"ask-init:run",
		(entry) => {
			const data = entry.data as { mode?: string; summary?: string[]; at?: string } | undefined;
			const lines = [
				`ask-init · ${data?.mode ?? "run"} · ${data?.at ?? ""}`,
				...(data?.summary ?? []).map((line) => `  ${line}`),
			];
			return new Text(lines.join("\n"));
		},
	);

	pi.registerCommand("ask-init", {
		description:
			"Install or reconcile the agent memory framework (.agents/ + specs/) and migrate existing docs to it",
		getArgumentCompletions: (prefix: string) =>
			[
				{ value: "plan", label: "plan", description: "show the plan only (writes nothing)" },
				{ value: "check", label: "check", description: "audit the installed framework" },
				{ value: "roots", label: "roots", description: "sync pi-add-dir roots into state" },
				{ value: "--dry-run", label: "--dry-run", description: "same as plan" },
				{ value: "--deep", label: "--deep", description: "allow structural rewrites" },
				{ value: "--yes", label: "--yes", description: "skip the confirmation panel" },
				{ value: "--lang zh", label: "--lang zh", description: "Chinese prose" },
				{ value: "--lang en", label: "--lang en", description: "English prose" },
			].filter((item) => item.value.startsWith(prefix)),
		handler: createRunHandler(pi, options, runtime),
	});
}
