/**
 * init feature — the audit.
 *
 * The audit is what keeps the framework from decaying the way hand-maintained
 * memory does: budgets drift, sections get duplicated, appendices stop being
 * last, `todos/` outlives the work it described. Every finding has a stable code
 * so a report can be compared across runs and the model can fix by code.
 *
 * It is read-only and never "fixes" anything itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import {
	AUDIT_CODES,
	BUDGETS,
	CONTRACT_FILE,
	FRAMEWORK_VERSION,
	IMPLEMENTATIONS_DIR,
	MEMORY_DIR,
	OVERRIDE_FILE,
	PLAN_FILE,
	REPORTS_DIR,
	SPECS_DIR,
} from "./spec.js";
import {
	duplicateHeadings,
	extractFrameworkPaths,
	largestSections,
	sectionsAfterAppendix,
} from "./analyze.js";
import { parseCoverage } from "./coverage.js";
import { staleRoots } from "./plan.js";
import type { DocInfo, Facts, Finding, Severity } from "./types.js";

export interface AuditOptions {
	/** Coverage report to read; defaults to the newest one in reports/. */
	readonly coveragePath?: string;
}

function finding(
	code: string,
	severity: Severity,
	message: string,
	path?: string,
	line?: number,
): Finding {
	return { code, severity, message, path, line };
}

function git(root: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* Coverage report lookup                                                      */
/* -------------------------------------------------------------------------- */

export function latestCoverageReport(root: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(join(root, REPORTS_DIR)).sort();
	} catch {
		return undefined;
	}
	const matching = names.filter((name) => /^coverage-.*\.md$/.test(name));
	if (matching.length === 0) return undefined;
	return posix.join(REPORTS_DIR, matching[matching.length - 1]);
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

function checkStructure(facts: Facts): Finding[] {
	const out: Finding[] = [];
	if (
		!facts.state &&
		!facts.dirs[MEMORY_DIR] &&
		!facts.deprecated.memory &&
		facts.memory.length === 0
	) {
		out.push(
			finding(
				AUDIT_CODES.notInstalled,
				"info",
				"framework not installed (no .agents/memory, no state): run /ask-init",
			),
		);
	}
	if (facts.context.override) {
		out.push(
			finding(
				AUDIT_CODES.overrideContext,
				"warning",
				`${OVERRIDE_FILE} replaces ${"AGENTS.md"} in this directory: pi never loads the framework entry`,
				OVERRIDE_FILE,
			),
		);
	}
	const memoryExists = facts.memory.length > 0 || facts.dirs[MEMORY_DIR];
	if (memoryExists && !existsSync(join(facts.root, CONTRACT_FILE))) {
		out.push(
			finding(
				AUDIT_CODES.contractMissing,
				"error",
				`${CONTRACT_FILE} is missing: nothing states the write rules or budgets`,
				CONTRACT_FILE,
			),
		);
	}
	if (facts.state && facts.state.version !== FRAMEWORK_VERSION) {
		out.push(
			finding(
				AUDIT_CODES.stateVersion,
				facts.state.version > FRAMEWORK_VERSION ? "error" : "warning",
				`state says framework v${facts.state.version}, this tool implements v${FRAMEWORK_VERSION}`,
				".agents/framework/state.toml",
			),
		);
	}
	if (!facts.context.agents && facts.memory.length > 0) {
		out.push(
			finding(
				AUDIT_CODES.indexMismatch,
				"error",
				"memory exists but AGENTS.md is missing: the memory cannot be reached from the entry point",
				"AGENTS.md",
			),
		);
	}
	return out;
}

function checkIndex(facts: Facts): Finding[] {
	const agents = facts.context.agents;
	if (!agents) return [];
	const out: Finding[] = [];
	const missing = facts.memory.filter((doc) => {
		const name = doc.rel.replace(`${MEMORY_DIR}/`, "");
		return !agents.text.includes(doc.rel) && !agents.text.includes(name);
	});
	if (!agents.text.includes(PLAN_FILE) && !agents.text.includes(SPECS_DIR)) {
		out.push(
			finding(
				AUDIT_CODES.indexMismatch,
				"error",
				`AGENTS.md has no plan/memory index (neither \`${PLAN_FILE}\` nor \`${SPECS_DIR}/\` is mentioned)`,
				"AGENTS.md",
			),
		);
	}
	if (missing.length > 0) {
		out.push(
			finding(
				AUDIT_CODES.indexMismatch,
				"warning",
				`memory files not referenced from AGENTS.md: ${missing
					.map((doc) => doc.rel)
					.join(", ")}`,
				"AGENTS.md",
			),
		);
	}
	return out;
}

function checkLinks(facts: Facts): Finding[] {
	const docs: DocInfo[] = [
		...(facts.context.agents ? [facts.context.agents] : []),
		...facts.memory,
		...facts.legacyMemory,
		...facts.specs,
	];
	const out: Finding[] = [];
	const seen = new Set<string>();
	for (const doc of docs) {
		for (const rel of extractFrameworkPaths(doc.text)) {
			if (seen.has(rel)) continue;
			seen.add(rel);
			const target = rel.replace(/^memory\//, `${MEMORY_DIR}/`);
			if (existsSync(join(facts.root, target))) continue;
			out.push(
				finding(
					AUDIT_CODES.brokenLink,
					"warning",
					`reference points at a missing file: ${rel}`,
					doc.rel,
				),
			);
		}
	}
	return out;
}

function checkRefs(facts: Facts): Finding[] {
	if (facts.refs.hits === 0) return [];
	const areas = Object.entries(facts.refs.byArea)
		.sort((a, b) => b[1].hits - a[1].hits)
		.slice(0, 6)
		.map(([area, bucket]) => `${area} (${bucket.files} files / ${bucket.hits})`);
	const example = facts.refs.examples[0];
	return [
		finding(
			AUDIT_CODES.pathBareRef,
			"error",
			`${facts.refs.hits} bare path references in ${facts.refs.paths.length} files would break on a move: ${areas.join(", ")}${example ? `; e.g. ${example.path}:${example.line}` : ""}`,
			example?.path,
			example?.line,
		),
	];
}

function checkTracked(facts: Facts): Finding[] {
	if (!facts.isGit || facts.memory.length === 0) return [];
	const out: Finding[] = [];
	// `check-ignore -q` exits 0 and prints nothing when the path IS ignored, and
	// exits 1 when it is not; git() maps a non-zero exit to undefined, so an
	// empty string means "ignored".
	const ignored = git(facts.root, ["check-ignore", "-q", `${MEMORY_DIR}/README.md`]);
	if (ignored === "") {
		out.push(
			finding(
				AUDIT_CODES.stateUntracked,
				"error",
				`${MEMORY_DIR}/ is gitignored: memory would never be committed`,
				MEMORY_DIR,
			),
		);
		return out;
	}
	const tracked = git(facts.root, ["ls-files", "--", MEMORY_DIR]);
	if (tracked !== undefined && tracked.trim().length === 0) {
		// Right after a fresh install this is the normal state, so it must not be
		// an E-* finding: the work order asks the model to fix every error, and
		// "commit the project" is not a fix the model may choose on its own.
		out.push(
			finding(
				AUDIT_CODES.stateUncommitted,
				"warning",
				`${MEMORY_DIR}/ has no tracked files yet: commit them (this is expected immediately after an install)`,
				MEMORY_DIR,
			),
		);
	}
	return out;
}

function checkRoot(facts: Facts): Finding[] {
	const out: Finding[] = [];
	const legacy: string[] = [];
	if (facts.deprecated.memory) legacy.push("memory/");
	if (facts.deprecated.implementations) legacy.push("implementations/");
	if (facts.deprecated.prompts) legacy.push("prompts/");
	if (legacy.length > 0) {
		out.push(
			finding(
				AUDIT_CODES.rootAgentDir,
				"warning",
				`agent-only directories at the repository root (move under .agents/): ${legacy.join(", ")}`,
			),
		);
	}
	if (facts.retiredTodos) {
		out.push(
			finding(
				AUDIT_CODES.todosRemain,
				"warning",
				"todos/ is retired: requirement wording belongs in specs/<unit>.md",
				"todos/",
			),
		);
	}
	if (facts.rootEmptyFiles.length > 0) {
		out.push(
			finding(
				AUDIT_CODES.rootEmptyFile,
				"warning",
				`zero-byte files at the root: ${facts.rootEmptyFiles.slice(0, 8).join(", ")}${
					facts.rootEmptyFiles.length > 8 ? " …" : ""
				}`,
			),
		);
	}
	for (const root of staleRoots(facts)) {
		out.push(
			finding(
				AUDIT_CODES.rootMissing,
				"warning",
				`registered workspace root is missing: ${root.label} (${root.path})`,
			),
		);
	}
	for (const root of facts.roots.filter((entry) => entry.exists)) {
		try {
			const card = readFileSync(join(root.absolute, "AGENTS.md"), "utf8");
			const lines = card.split("\n").length;
			if (lines > 40 && !card.includes("agent-framework")) {
				out.push(
					finding(
						AUDIT_CODES.rootCardTooBig,
						"warning",
						`${root.label}/AGENTS.md is ${lines} lines: pi-add-dir injects it verbatim into every request — keep a scope card of at most 30 lines`,
						root.path,
					),
				);
			}
		} catch {
			// No card at all is the normal case for a code-only root.
		}
	}
	if (existsSync(join(facts.root, ".agents/skills"))) {
		out.push(
			finding(
				AUDIT_CODES.agentsSkills,
				"info",
				".agents/skills exists: pi treats it as project resources and will require project trust",
			),
		);
	}
	return out;
}

function checkBudgets(facts: Facts): Finding[] {
	const out: Finding[] = [];
	const agents = facts.context.agents;
	if (agents) {
		if (agents.bytes > BUDGETS.agentsMdHardChars) {
			const largest = largestSections(agents, 3)
				.map(({ heading, chars }) => `${heading.text} (${chars})`)
				.join(", ");
			out.push(
				finding(
					AUDIT_CODES.budgetAgents,
					"warning",
					`AGENTS.md is ${agents.bytes} chars (soft ${BUDGETS.agentsMdSoftChars}, hard ${BUDGETS.agentsMdHardChars}); largest sections: ${largest}`,
					"AGENTS.md",
				),
			);
		} else if (agents.bytes > BUDGETS.agentsMdSoftChars) {
			out.push(
				finding(
					AUDIT_CODES.budgetAgents,
					"info",
					`AGENTS.md is ${agents.bytes} chars, over the soft budget ${BUDGETS.agentsMdSoftChars}`,
					"AGENTS.md",
				),
			);
		}
	}
	for (const doc of facts.memory) {
		if (doc.bytes <= BUDGETS.memoryFileChars) continue;
		out.push(
			finding(
				AUDIT_CODES.budgetMemory,
				"warning",
				`${doc.rel} is ${doc.bytes} chars (budget ${BUDGETS.memoryFileChars}): split or archive`,
				doc.rel,
			),
		);
	}
	if (facts.implementations.length > BUDGETS.implementationsFiles) {
		out.push(
			finding(
				AUDIT_CODES.budgetMemory,
				"info",
				`${facts.implementations.length} change records: roll up per milestone and archive the originals`,
				IMPLEMENTATIONS_DIR,
			),
		);
	}
	return out;
}

function checkDuplication(facts: Facts): Finding[] {
	const docs = [
		...(facts.context.agents ? [facts.context.agents] : []),
		...facts.memory,
		...facts.legacyMemory,
	];
	const groups = duplicateHeadings(docs).filter(
		(group) => new Set(group.occurrences.map((occurrence) => occurrence.path)).size > 1,
	);
	return groups.slice(0, 6).map((group) =>
		finding(
			AUDIT_CODES.duplicateFact,
			"warning",
			`same section in several files: "${group.occurrences[0].heading}" → ${group.occurrences
				.map((occurrence) => `${occurrence.path}:${occurrence.line}`)
				.join(", ")}`,
		),
	);
}

function checkOrder(facts: Facts): Finding[] {
	const docs = [
		...(facts.context.agents ? [facts.context.agents] : []),
		...facts.memory,
		...facts.legacyMemory,
	];
	const out: Finding[] = [];
	for (const doc of docs) {
		const after = sectionsAfterAppendix(doc);
		if (after.length === 0) continue;
		out.push(
			finding(
				AUDIT_CODES.appendixOrder,
				"warning",
				`sections appended after the appendix: ${after.map((heading) => heading.text).join(", ")}`,
				doc.rel,
				after[0].line,
			),
		);
	}
	return out;
}

function checkMeta(facts: Facts): Finding[] {
	const out: Finding[] = [];
	const future = facts.memory.find((doc) => doc.rel.endsWith("/FUTURE.md"));
	if (future && !/触发|trigger/i.test(future.text)) {
		out.push(
			finding(
				AUDIT_CODES.futureNoTrigger,
				"warning",
				"FUTURE.md has no trigger wording: a deferred item without a revisit condition is a graveyard entry",
				future.rel,
			),
		);
	}
	const finished = facts.memory.find((doc) => doc.rel.endsWith("/FINISHED.md"));
	if (finished) {
		const sections = finished.text.split(/^##\s+/m).slice(1);
		const without = sections
			// A placeholder or a prose-only intro has no entries to prove. Only
			// sections with a list or a table can be "finished work without evidence".
			.filter((section) => /^\s*(?:[-*+]|\|)/m.test(section))
			.filter((section) => !/implementations\//.test(section) && !/specs\//.test(section))
			.map((section) => section.split("\n")[0].trim())
			.filter((title) => title.length > 0 && !/^(附录|appendix)/i.test(title));
		if (without.length > 0) {
			out.push(
				finding(
					AUDIT_CODES.finishedNoEvidence,
					"warning",
					`FINISHED.md sections with no evidence pointer: ${without.slice(0, 5).join(", ")}${
						without.length > 5 ? " …" : ""
					}`,
					finished.rel,
				),
			);
		}
	}
	return out;
}

function checkPlanDrift(facts: Facts): Finding[] {
	const plan = facts.specs.find((doc) => doc.rel === PLAN_FILE);
	if (!plan) return [];
	const out: Finding[] = [];
	const closed = facts.specs.filter((doc) => {
		if (doc.rel === PLAN_FILE) return false;
		const boxes = doc.text.match(/^- \[[ xX]\]/gm) ?? [];
		const open = boxes.filter((box) => /\[ \]/.test(box)).length;
		return boxes.length > 0 && open === 0 && plan.text.includes(doc.rel.replace(`${SPECS_DIR}/`, ""));
	});
	for (const doc of closed.slice(0, 5)) {
		out.push(
			finding(
				AUDIT_CODES.planSpecDrift,
				"warning",
				`${doc.rel} has every acceptance box checked but is still listed in ${PLAN_FILE}: close it and move the summary to FINISHED.md`,
				PLAN_FILE,
			),
		);
	}
	return out;
}

function checkCoverage(facts: Facts, coveragePath: string | undefined): Finding[] {
	const rel = coveragePath ?? latestCoverageReport(facts.root);
	if (!rel) return [];
	const absolute = join(facts.root, rel);
	if (!existsSync(absolute)) return [];
	const report = parseCoverage(readFileSync(absolute, "utf8"));
	if (report.open === 0) return [];
	return [
		finding(
			AUDIT_CODES.coverageOpen,
			"warning",
			`${report.open} source sections have no destination or reason in ${rel}`,
			rel,
		),
	];
}

function checkScaffold(facts: Facts): Finding[] {
	const docs = [
		...(facts.context.agents ? [facts.context.agents] : []),
		...facts.memory,
		...facts.specs,
	];
	let count = 0;
	for (const doc of docs) count += (doc.text.match(/TODO\(ask-init\)/g) ?? []).length;
	if (count === 0) return [];
	return [
		finding(
			AUDIT_CODES.scaffoldLeftover,
			"warning",
			`${count} TODO(ask-init) markers remain: the scaffold was not filled in`,
		),
	];
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

export function audit(facts: Facts, options: AuditOptions = {}): Finding[] {
	const findings = [
		...checkStructure(facts),
		...checkIndex(facts),
		...checkRefs(facts),
		...checkTracked(facts),
		...checkRoot(facts),
		...checkLinks(facts),
		...checkBudgets(facts),
		...checkDuplication(facts),
		...checkOrder(facts),
		...checkMeta(facts),
		...checkPlanDrift(facts),
		...checkCoverage(facts, options.coveragePath),
		...checkScaffold(facts),
	];
	const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
	return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code));
}

export function countFindings(findings: readonly Finding[]): {
	errors: number;
	warnings: number;
	infos: number;
} {
	return {
		errors: findings.filter((item) => item.severity === "error").length,
		warnings: findings.filter((item) => item.severity === "warning").length,
		infos: findings.filter((item) => item.severity === "info").length,
	};
}

/** Text for humans and for the model's self-check loop. */
export function renderFindings(
	findings: readonly Finding[],
	context: { root: string; frameworkVersion: number },
): string {
	const counts = countFindings(findings);
	const lines = [
		`agent-framework v${context.frameworkVersion} — audit`,
		`repo: ${context.root}`,
		`result: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.infos} info`,
		"",
	];
	if (findings.length === 0) {
		lines.push("No findings. The layout, budgets and references check out.");
		return lines.join("\n");
	}
	for (const severity of ["error", "warning", "info"] as const) {
		const group = findings.filter((item) => item.severity === severity);
		if (group.length === 0) continue;
		lines.push(`## ${severity}s`);
		for (const item of group) {
			const location = item.path ? ` [${item.path}${item.line ? `:${item.line}` : ""}]` : "";
			lines.push(`- ${item.code}${location} ${item.message}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

