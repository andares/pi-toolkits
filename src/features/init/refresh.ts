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
 * `/ask-init` runs this on every invocation: on an installed project the first
 * step is now the same comparison, so a repeat run either reports "current" or
 * repairs what is safe before the audit. Marker matching lives in `workflow.ts`
 * and refuses to touch ambiguous layouts.
 *
 * The command is idempotent: a second run reports "current" everywhere.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
	AGENTS_FILE,
	STATE_FILE,
} from "./spec.js";
import { loadState } from "./detect.js";
import { iso } from "./plan.js";
import { stateToToml } from "./apply.js";
import { MANAGED_SPECS, renderManaged, workflowBlockText } from "./parity.js";
import type { FrameworkState } from "./types.js";
import {
	applyWorkflowBlock,
	type BlockStatus,
} from "./workflow.js";

export { applyWorkflowBlock } from "./workflow.js";

export interface RefreshOptions {
	readonly dryRun?: boolean;
	readonly now?: Date;
	readonly toolVersion?: string;
	/** Treat a legacy managed file with no anchor as ours and update it. */
	readonly adoptLegacy?: boolean;
}

export interface RefreshResult {
	readonly created: string[];
	readonly updated: string[];
	/** Legacy files taken over because `--adopt` was explicit. */
	readonly adopted: string[];
	readonly skipped: Array<{ path: string; reason: string }>;
	readonly block: BlockStatus;
	readonly stateUpdated: boolean;
	readonly dryRun: boolean;
}

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
	const adopted: string[] = [];
	const skipped: RefreshResult["skipped"] = [];
	const previous = new Map(state.managed.map((entry) => [entry.path, entry]));
	const nextManaged = new Map(state.managed.map((entry) => [entry.path, { ...entry }]));

	for (const spec of MANAGED_SPECS) {
		const absolute = inside(root, spec.path);
		const rendered = renderManaged(spec);
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
				: diskHash === sha256(rendered) || options.adoptLegacy === true
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
				reason:
					entry?.templateSha256 !== undefined
						? "edited by hand since the framework last wrote it — left untouched"
						: "no template anchor and the bytes differ from the current template — cannot tell a hand edit from an older template; left untouched",
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

		if (entry?.templateSha256 === undefined && options.adoptLegacy === true) {
			adopted.push(spec.path);
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

	// The one block this tool owns inside a file it does not own. A malformed
	// marker layout is reported, never rewritten.
	let block: BlockStatus = "missing-agents";
	const agentsPath = inside(root, AGENTS_FILE);
	if (existsSync(agentsPath)) {
		const text = readFileSync(agentsPath, "utf8");
		const rendered = workflowBlockText();
		const result = applyWorkflowBlock(text, rendered);
		block = result.status;
		if ((result.status === "inserted" || result.status === "updated") && !dryRun) {
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
		adopted,
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
	if (result.adopted.length > 0) parts.push(`${result.adopted.length} legacy file(s) adopted`);
	if (result.block === "inserted") parts.push("workflow block inserted into AGENTS.md");
	if (result.block === "updated") parts.push("workflow block updated");
	if (result.block === "malformed") {
		parts.push("workflow markers in AGENTS.md are inconsistent — left untouched");
	}
	if (result.block === "hand-written") {
		parts.push("a hand-written Ask workflow section exists without markers — left untouched");
	}
	if (result.block === "missing-agents") {
		parts.push("AGENTS.md is missing — run /ask-init to rebuild it");
	}
	if (parts.length === 0) parts.push("framework files are already current");
	if (result.skipped.length > 0) parts.push(`${result.skipped.length} left untouched (hand edits or no anchor)`);
	return parts.join(" · ");
}
