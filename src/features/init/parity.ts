/**
 * init feature — framework-owned text versus the installed tool.
 *
 * `/ask-init` must answer one question on a repeated run: *is the project's
 * framework text on par with the version of this tool, and if not, what can be
 * repaired without judgement?* This module is the read-only half of that
 * answer. It compares each managed file with the bytes this version renders,
 * distinguishes a hand edit from an older template, and reports required files
 * that are simply missing.
 *
 * It never writes. The operator's files are theirs: a managed file is rewritten
 * only when `refresh` has an anchor proving the disk still holds our bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspectWorkflowBlock, type WorkflowStatus } from "./workflow.js";
import {
	AGENTS_FILE,
	BUDGETS,
	CONTRACT_FILE,
	FRAMEWORK_VERSION,
	IMPLEMENTATIONS_DIR,
	MEMORY_DIR,
	MEMORY_FILES,
	PLAN_FILE,
	SIGNPOST_FILE,
	STATE_FILE,
	STATE_GITIGNORE,
	UAT_CONTRACT_FILE,
} from "./spec.js";
import { renderTemplate } from "./templates.js";
import type { FrameworkState } from "./types.js";

export interface ManagedSpec {
	readonly path: string;
	readonly template: string;
	readonly tokens: Record<string, string>;
}

/** Files `refresh` owns. The set is also what state.toml anchors. */
export const MANAGED_SPECS: readonly ManagedSpec[] = [
	{ path: CONTRACT_FILE, template: "memory-readme", tokens: {} },
	{ path: SIGNPOST_FILE, template: "signpost", tokens: {} },
	{
		path: UAT_CONTRACT_FILE,
		template: "uat-readme",
		tokens: { implementationsDir: IMPLEMENTATIONS_DIR },
	},
	{ path: STATE_GITIGNORE, template: "state-gitignore", tokens: {} },
];

export function baseTokens(): Record<string, string> {
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

/** The exact Markdown for the ask workflow block. */
export function workflowBlockText(): string {
	return renderTemplate("workflow-block", {}, "en");
}

export function renderManaged(spec: ManagedSpec): string {
	return renderTemplate(spec.template, { ...baseTokens(), ...spec.tokens }, "en");
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export type ManagedStatus = "current" | "stale" | "missing" | "hand-edited" | "unverifiable";

export interface ManagedParity {
	readonly path: string;
	readonly status: ManagedStatus;
	readonly reason?: string;
}

/**
 * Compare every managed file with the current template. `state` may be absent:
 * without anchors every differing file is `unverifiable`, never a hand edit.
 */
export function inspectManaged(
	root: string,
	state?: FrameworkState,
): ManagedParity[] {
	const byPath = new Map((state?.managed ?? []).map((entry) => [entry.path, entry]));
	return MANAGED_SPECS.map((spec) => {
		const absolute = join(root, spec.path);
		if (!existsSync(absolute)) return { path: spec.path, status: "missing" };
		let disk: string;
		try {
			disk = readFileSync(absolute, "utf8");
		} catch (error) {
			return {
				path: spec.path,
				status: "unverifiable",
				reason: `could not read the file (${error instanceof Error ? error.message : String(error)})`,
			};
		}
		const rendered = renderManaged(spec);
		const anchor = byPath.get(spec.path)?.templateSha256;
		if (anchor === undefined) {
			return disk === rendered
				? { path: spec.path, status: "current" }
				: {
						path: spec.path,
						status: "unverifiable",
						reason: "no template anchor: cannot tell a hand edit from an older template",
					};
		}
		if (sha256(disk) !== anchor) {
			return {
				path: spec.path,
				status: "hand-edited",
				reason: "the file no longer matches the bytes this tool last rendered",
			};
		}
		return disk === rendered
			? { path: spec.path, status: "current" }
			: { path: spec.path, status: "stale" };
	});
}

/**
 * Files the framework contract requires for a usable loop. Managed files are
 * reported separately (they have their own refresh path); this list is what
 * `/ask-init` can recreate mechanically from seeds.
 */
export function requiredFrameworkFiles(): string[] {
	return [
		AGENTS_FILE,
		...MEMORY_FILES.filter((file) => file.core).map((file) => `${MEMORY_DIR}/${file.file}`),
		PLAN_FILE,
	];
}

export function missingRequired(root: string): string[] {
	return requiredFrameworkFiles().filter((rel) => !isFile(join(root, rel)));
}

/** A directory named `AGENTS.md` is not an entry file; readiness checks types. */
function isFile(absolute: string): boolean {
	try {
		return statSync(absolute).isFile();
	} catch {
		return false;
	}
}

function isDirectory(absolute: string): boolean {
	try {
		return statSync(absolute).isDirectory();
	} catch {
		return false;
	}
}

/** The workflow block in AGENTS.md, or a reason it cannot be judged. */
export function inspectWorkflow(root: string): WorkflowStatus {
	const absolute = join(root, AGENTS_FILE);
	if (!existsSync(absolute)) return "missing-agents";
	try {
		const text = readFileSync(absolute, "utf8");
		return inspectWorkflowBlock(text, workflowBlockText()).status;
	} catch {
		return "malformed";
	}
}

export interface FrameworkParity {
	readonly managed: ManagedParity[];
	readonly requiredMissing: string[];
	readonly workflow: WorkflowStatus;
}

export function inspectFramework(root: string, state?: FrameworkState): FrameworkParity {
	return {
		managed: inspectManaged(root, state),
		requiredMissing: missingRequired(root),
		workflow: inspectWorkflow(root),
	};
}

/** Compact lines for the plan preview, the audit report and a no-op notice. */
export function describeParity(parity: FrameworkParity): string[] {
	const lines: string[] = [];
	const drift = parity.managed.filter((entry) => entry.status !== "current");
	if (drift.length === 0) {
		lines.push("- framework files: current");
	} else {
		for (const entry of drift) {
			lines.push(`- ${entry.status}: ${entry.path}${entry.reason ? ` (${entry.reason})` : ""}`);
		}
	}
	lines.push(`- workflow block: ${parity.workflow}`);
	if (parity.requiredMissing.length > 0) {
		lines.push(`- required files missing: ${parity.requiredMissing.join(", ")}`);
	}
	return lines;
}

/**
 * The tolerant "can the ask loop run here?" predicate.
 *
 * Deliberately feature-based, not byte-based: small edits to a memory file do
 * not break the loop, so they must not block `/ask-uat` or `record_change`.
 */
export interface FrameworkReadiness {
	readonly ready: boolean;
	readonly missing: string[];
}

export function frameworkReadiness(root: string): FrameworkReadiness {
	const missing = [STATE_FILE, AGENTS_FILE, CONTRACT_FILE].filter(
		(rel) => !isFile(join(root, rel)),
	);
	if (!isDirectory(join(root, IMPLEMENTATIONS_DIR))) missing.push(IMPLEMENTATIONS_DIR);
	return { ready: missing.length === 0, missing };
}
