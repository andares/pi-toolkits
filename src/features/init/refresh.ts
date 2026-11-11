/**
 * init feature — `/ask-init refresh`: bring the framework-owned text up to date.
 *
 * Every feature this toolkit ships adds prose to the project: the memory
 * contract, the signpost, the workflow block in `AGENTS.md`, the acceptance
 * ledger contract. Re-running `/ask-init` cannot refresh them (it refuses to
 * overwrite an existing file — that is the rule that keeps it safe), so refresh
 * is the one path allowed to rewrite framework-owned bytes. It earns that with
 * three rules:
 *
 *  1. **Managed files are rewritten only when the disk still equals the anchor**
 *     — the hash of the bytes this tool rendered last time. Anything else is a
 *     hand edit, and overwriting it would destroy operator work: skip + report.
 *  2. **`AGENTS.md` is touched only between its workflow markers.** If the
 *     markers are absent the block is inserted deterministically (before the
 *     first appendix, else at the end); outside the block, not one byte moves.
 *  3. **Missing optional pieces are created** (the UAT contract), so a project
 *     that adopted the framework before the ledger existed can catch up.
 *
 * The command is idempotent: a second run reports "current" everywhere.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
	AGENTS_FILE,
	BUDGETS,
	CONTRACT_FILE,
	FRAMEWORK_VERSION,
	IMPLEMENTATIONS_DIR,
	SIGNPOST_FILE,
	STATE_FILE,
	STATE_GITIGNORE,
	UAT_CONTRACT_FILE,
	WORKFLOW_BLOCK_BEGIN,
	WORKFLOW_BLOCK_END,
} from "./spec.js";
import { loadState } from "./detect.js";
import { iso } from "./plan.js";
import { stateToToml } from "./apply.js";
import { renderTemplate } from "./templates.js";
import type { FrameworkState } from "./types.js";

export interface RefreshOptions {
	readonly dryRun?: boolean;
	readonly now?: Date;
	readonly toolVersion?: string;
}

export type BlockStatus = "current" | "updated" | "inserted" | "missing-agents";

export interface RefreshResult {
	readonly created: string[];
	readonly updated: string[];
	readonly skipped: Array<{ path: string; reason: string }>;
	readonly block: BlockStatus;
	readonly stateUpdated: boolean;
	readonly dryRun: boolean;
}

const MANAGED_TEMPLATES: ReadonlyArray<{ path: string; template: string; tokens: Record<string, string> }> = [
	{ path: CONTRACT_FILE, template: "memory-readme", tokens: {} },
	{ path: SIGNPOST_FILE, template: "signpost", tokens: {} },
	{ path: UAT_CONTRACT_FILE, template: "uat-readme", tokens: { implementationsDir: IMPLEMENTATIONS_DIR } },
	{ path: STATE_GITIGNORE, template: "state-gitignore", tokens: {} },
];

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function inside(root: string, rel: string): string {
	const absolute = resolve(root, rel);
	const base = resolve(root);
	if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
		throw new Error(`refusing to write outside the repository: ${rel}`);
	}
	return absolute;
}

function baseTokens(): Record<string, string> {
	return {
		frameworkVersion: String(FRAMEWORK_VERSION),
		softBudget: String(BUDGETS.agentsMdSoftChars),
		hardBudget: String(BUDGETS.agentsMdHardChars),
		memoryBudget: String(BUDGETS.memoryFileChars),
		implementationsBudget: String(BUDGETS.implementationsFiles),
		implementationsDir: IMPLEMENTATIONS_DIR,
		statePath: STATE_FILE,
		contractPath: CONTRACT_FILE,
		uatLedger: ".agents/uat/ledger.jsonl",
	};
}

/** Replace or insert the managed workflow block; never touches anything else. */
export function applyWorkflowBlock(
	text: string,
	block: string,
): { text: string; status: Exclude<BlockStatus, "missing-agents"> } {
	const begin = text.indexOf(WORKFLOW_BLOCK_BEGIN);
	const end = text.indexOf(WORKFLOW_BLOCK_END);
	if (begin >= 0 && end > begin) {
		const endLine = text.indexOf("\n", end);
		const stop = endLine === -1 ? text.length : endLine;
		const next = `${text.slice(0, begin)}${block.trimEnd()}${text.slice(stop)}`;
		return { text: next, status: next === text ? "current" : "updated" };
	}
	const appendix = /^##[ \t]+(?:附录|appendix)/im.exec(text);
	if (appendix?.index !== undefined) {
		return {
			text: `${text.slice(0, appendix.index)}${block.trimEnd()}\n\n${text.slice(appendix.index)}`,
			status: "inserted",
		};
	}
	return { text: `${text.trimEnd()}\n\n${block.trimEnd()}\n`, status: "inserted" };
}

export function refreshFramework(root: string, options: RefreshOptions = {}): RefreshResult {
	const loaded = loadState(root);
	if (!loaded.state) {
		throw new Error(
			loaded.error ?? "no agent framework installed (.agents/framework/state.toml is missing) — run /ask-init first",
		);
	}
	const state: FrameworkState = loaded.state;
	const now = options.now ?? new Date();
	const dryRun = options.dryRun === true;
	const created: string[] = [];
	const updated: string[] = [];
	const skipped: RefreshResult["skipped"] = [];
	const previous = new Map(state.managed.map((entry) => [entry.path, entry]));
	const nextManaged = new Map(state.managed.map((entry) => [entry.path, { ...entry }]));

	for (const spec of MANAGED_TEMPLATES) {
		const absolute = inside(root, spec.path);
		const rendered = renderTemplate(spec.template, { ...baseTokens(), ...spec.tokens }, "en");
		const exists = existsSync(absolute);
		const disk = exists ? readFileSync(absolute, "utf8") : undefined;
		const entry = previous.get(spec.path);
		const diskHash = exists ? sha256(disk ?? "") : undefined;
		// Only a template anchor proves "this is still the text we wrote". Legacy
		// state has none, and its disk hash cannot supply that proof: it is
		// refreshed from disk at the end of a run. We may adopt an anchor only
		// when the legacy file is already byte-identical to the current template.
		const safe = exists
			? entry?.templateSha256 !== undefined
				? diskHash === entry.templateSha256
				: diskHash === sha256(rendered)
			: true;

		if (!exists) {
			if (!dryRun) {
				mkdirSync(dirname(absolute), { recursive: true });
				writeFileSync(absolute, rendered, "utf8");
			}
			created.push(spec.path);
			nextManaged.set(spec.path, {
				path: spec.path,
				sha256: sha256(rendered),
				template: spec.template,
				templateSha256: sha256(rendered),
			});
			continue;
		}

		if (!safe) {
			skipped.push({
				path: spec.path,
				reason: "edited by hand since the framework last wrote it — left untouched",
			});
			continue;
		}

		if (disk === rendered) {
			nextManaged.set(spec.path, {
				path: spec.path,
				sha256: sha256(rendered),
				template: spec.template,
				templateSha256: sha256(rendered),
			});
			continue;
		}

		if (!dryRun) writeFileSync(absolute, rendered, "utf8");
		updated.push(spec.path);
		nextManaged.set(spec.path, {
			path: spec.path,
			sha256: sha256(rendered),
			template: spec.template,
			templateSha256: sha256(rendered),
		});
	}

	// The one block this tool owns inside a file it does not own.
	let block: BlockStatus = "missing-agents";
	const agentsPath = inside(root, AGENTS_FILE);
	if (existsSync(agentsPath)) {
		const text = readFileSync(agentsPath, "utf8");
		const rendered = renderTemplate("workflow-block", {}, "en");
		const result = applyWorkflowBlock(text, rendered);
		block = result.status;
		if (result.status !== "current" && !dryRun) {
			writeFileSync(agentsPath, result.text, "utf8");
		}
	}

	const changed = created.length + updated.length > 0 || block === "updated" || block === "inserted";
	const managedChanged =
		state.managed.length !== nextManaged.size ||
		[...nextManaged.values()].some((entry) => {
			const before = previous.get(entry.path);
			return (
				!before ||
				before.sha256 !== entry.sha256 ||
				before.template !== entry.template ||
				before.templateSha256 !== entry.templateSha256
			);
		});
	const toolChanged = state.tool !== (options.toolVersion ?? state.tool);
	const stateChanged = changed || managedChanged || toolChanged;
	if (!dryRun && stateChanged) {
		writeFileSync(
			inside(root, STATE_FILE),
			stateToToml({
				...state,
				tool: options.toolVersion ?? state.tool,
				updated: iso(now),
				managed: [...nextManaged.values()],
			}),
			"utf8",
		);
	}

	return {
		created,
		updated,
		skipped,
		block,
		stateUpdated: !dryRun && stateChanged,
		dryRun,
	};
}

/** One-line notice for the command handler. */
export function describeRefresh(result: RefreshResult): string {
	const parts: string[] = [];
	const verb = result.dryRun ? "would refresh" : "refreshed";
	if (result.created.length > 0) parts.push(`${verb} ${result.created.length} created file(s)`);
	if (result.updated.length > 0) parts.push(`${result.updated.length} framework file(s)`);
	if (result.block === "inserted") parts.push("workflow block inserted into AGENTS.md");
	if (result.block === "updated") parts.push("workflow block updated");
	if (parts.length === 0) parts.push("framework files are already current");
	if (result.skipped.length > 0) parts.push(`${result.skipped.length} left untouched (hand edits)`);
	return parts.join(" · ");
}
