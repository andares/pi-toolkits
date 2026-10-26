/**
 * init feature — the agent-framework contract, as data.
 *
 * This file is the single source of truth for *where* the framework lives and
 * *what it expects*. Everything else (detect / plan / apply / audit) reads it,
 * so a layout change is one edit here plus a migration recipe.
 *
 * Layout principle (operator decision, 2026-10-26):
 *   - purely agent-facing content lives under `.agents/` (hidden, less noise at
 *     the repo root);
 *   - content people read stays at the root (`specs/`, `design/`, `docs/`, `legal/`).
 *
 * The three-way split is deliberate:
 *   `specs/`                    — the plan: what to do, how to accept it
 *   `.agents/memory/`           — memory: what is known, decided, why
 *   `.agents/implementations/`  — evidence: what was changed, when, with proof
 *   `.agents/prompts/`          — input: the operator's own words (optional)
 *
 * `todos/` is retired: a requirement becomes a spec, and the verbatim wording
 * goes into that spec's "requirement" section instead of a second directory.
 */

/** Bump when the contract changes in a way existing projects must migrate. */
export const FRAMEWORK_VERSION = 1;

/** Identity written into state and reports. */
export const FRAMEWORK_ID = "agent-framework";

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
export const OVERRIDE_FILE = "AGENTS.override.md";

/** Hidden home of everything that exists only for the agent. */
export const AGENTS_DIR = ".agents";
export const MEMORY_DIR = ".agents/memory";
export const IMPLEMENTATIONS_DIR = ".agents/implementations";
export const PROMPTS_DIR = ".agents/prompts";
export const FRAMEWORK_DIR = ".agents/framework";

export const STATE_FILE = ".agents/framework/state.toml";
export const STATE_GITIGNORE = ".agents/framework/.gitignore";
export const SNAPSHOTS_DIR = ".agents/framework/snapshots";
export const PLANS_DIR = ".agents/framework/plans";
export const REPORTS_DIR = ".agents/framework/reports";

/** The plan home stays at the root: humans review it. */
export const SPECS_DIR = "specs";
export const PLAN_FILE = "specs/PLAN.md";

/** The contract every agent reads before writing memory. */
export const CONTRACT_FILE = ".agents/memory/README.md";
/** A one-screen signpost for whoever opens `.agents/` first. */
export const SIGNPOST_FILE = ".agents/README.md";
/** Optional cascade of remembered decisions and functional specs. */
export const FUNCTION_PREFIX = "FUNCTION-";

/** Root-level plan/requirement files this framework supersedes. */
export const LEGACY_DOC_NAMES = [
	"TODO.md",
	"TASKS.md",
	"ROADMAP.md",
	"NOTES.md",
	"DEVNOTES.md",
	"DEVELOPMENT.md",
	"PLAN.md",
];

/** Directories that belong under `.agents/` in this framework. */
export const DEPRECATED_ROOT_DIRS = ["memory", "implementations", "prompts"] as const;

/** Retired entirely: requirement wording moves into `specs/<unit>.md`. */
export const RETIRED_ROOT_DIRS = ["todos"] as const;

/* -------------------------------------------------------------------------- */
/* Budgets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * AGENTS.md is paid for on *every* request, so it is the one file with a hard
 * budget. `memory/*.md` is read on demand: its budget is about navigability,
 * not tokens.
 */
export const BUDGETS = {
	/** Soft ceiling: the audit starts warning here. */
	agentsMdSoftChars: 12_000,
	/** Hard ceiling: the plan records the overflow as debt that must be paid. */
	agentsMdHardChars: 20_000,
	/** A memory file past this is hard to navigate; split or archive. */
	memoryFileChars: 80_000,
	/** Above this many change records, roll old ones up and archive them. */
	implementationsFiles: 200,
} as const;

/* -------------------------------------------------------------------------- */
/* Memory files                                                                */
/* -------------------------------------------------------------------------- */

export type MemoryRole =
	| "contract"
	| "finished"
	| "future"
	| "architecture"
	| "design"
	| "terms"
	| "review"
	| "debugging"
	| "function";

export interface MemoryFileSpec {
	/** File name inside `.agents/memory/` (or `FUNCTION-*` pattern). */
	readonly file: string;
	readonly role: MemoryRole;
	/** Always created (with a short seed) versus lazily on first use. */
	readonly core: boolean;
	/** One-line "owns what", used in plans, seeds and the index. */
	readonly owns: string;
	/** What must never be written there. */
	readonly never: string;
}

export const MEMORY_FILES: readonly MemoryFileSpec[] = [
	{
		file: "FINISHED.md",
		role: "finished",
		core: true,
		owns: "closed work: summary + evidence pointer + historical appendices",
		never: "spec bodies, duplicated progress lists",
	},
	{
		file: "FUTURE.md",
		role: "future",
		core: true,
		owns: "deferred / rejected / waiting-for-a-trigger registry",
		never: "schedule promises, half-plans that belong in specs/",
	},
	{
		file: "ARCHITECTURE.md",
		role: "architecture",
		core: true,
		owns: "layering, version baseline, decision records, investigation archive",
		never: "visual specs, progress, functional behaviour owned by FUNCTION-*",
	},
	{
		file: "DESIGN.md",
		role: "design",
		core: false,
		owns: "visual single source of truth: tokens, palette, spacing, component looks",
		never: "implementation details, component inventories",
	},
	{
		file: "TERMS.md",
		role: "terms",
		core: false,
		owns: "glossary and the discriminating rules behind each term",
		never: "visual specs, API documentation",
	},
	{
		file: "REVIEW.md",
		role: "review",
		core: false,
		owns: "review ledger: judgement, trade-off, destination",
		never: "a second copy of any spec",
	},
	{
		file: "DEBUGGING.md",
		role: "debugging",
		core: false,
		owns: "runtime diagnosis runbook (logs, crash dumps, live attach)",
		never: "code facts that belong in ARCHITECTURE",
	},
	{
		file: "FUNCTION-<MODULE>.md",
		role: "function",
		core: false,
		owns: "one module's functional specification and its exact rules",
		never: "copies of another module's rules",
	},
];

/** Memory file names that are recognised when auditing an existing project. */
export function isMemoryFileName(name: string): boolean {
	if (MEMORY_FILES.some((spec) => spec.file === name)) return true;
	return name.startsWith(FUNCTION_PREFIX) && name.endsWith(".md");
}

/* -------------------------------------------------------------------------- */
/* Optional root modules                                                       */
/* -------------------------------------------------------------------------- */

export interface RootModuleSpec {
	readonly dir: string;
	/** What the directory is for, in one line (English: shipped text). */
	readonly owns: string;
}

export const ROOT_MODULES: readonly RootModuleSpec[] = [
	{ dir: "specs", owns: "plans and unit specs (the plan home)" },
	{ dir: "design", owns: "design sources and their paired notes" },
	{ dir: "docs", owns: "user- and contributor-facing documentation" },
	{ dir: "legal", owns: "license originals, third-party notices and provenance" },
];

/* -------------------------------------------------------------------------- */
/* Scan limits                                                                 */
/* -------------------------------------------------------------------------- */

export const SCAN = {
	/** Files bigger than this are read for metadata only, never for content. */
	maxFileBytes: 1_500_000,
	/** Cap the tree walk so a runaway repo cannot stall the command. */
	maxFiles: 20_000,
	/** Depth for the generic walk. */
	maxDepth: 6,
	/** Directory names never descended into. */
	ignoreDirs: new Set([
		".git",
		"node_modules",
		"target",
		"dist",
		"build",
		"out",
		"release-out",
		".venv",
		"venv",
		"__pycache__",
		".cache",
		".turbo",
		".next",
		"coverage",
		".pytest_cache",
		".mypy_cache",
	]),
	/** Text extensions counted for path references. */
	refExtensions: new Set([
		".md",
		".mdx",
		".ts",
		".tsx",
		".js",
		".mjs",
		".cjs",
		".mts",
		".cts",
		".rs",
		".toml",
		".json",
		".yml",
		".yaml",
		".txt",
		".html",
		".css",
		".scss",
		".py",
		".sh",
		".fish",
		".pd",
		".nix",
		".go",
		".java",
		".kt",
		".swift",
		".c",
		".h",
		".cc",
		".cpp",
	]),
} as const;

/* -------------------------------------------------------------------------- */
/* Audit vocabulary                                                            */
/* -------------------------------------------------------------------------- */

export const AUDIT_CODES = {
	pathBareRef: "E-PATH-01",
	stateUntracked: "E-STATE-01",
	stateUncommitted: "W-STATE-01",
	stateVersion: "E-STATE-02",
	indexMismatch: "E-INDEX-01",
	brokenLink: "E-LINK-01",
	rootAgentDir: "W-ROOT-01",
	rootEmptyFile: "W-ROOT-02",
	rootMissing: "W-ROOT-03",
	rootCardTooBig: "W-ROOT-04",
	todosRemain: "W-TODO-01",
	budgetAgents: "W-BUDGET-01",
	budgetMemory: "W-BUDGET-02",
	duplicateFact: "W-DUP-01",
	appendixOrder: "W-ORDER-01",
	coverageOpen: "W-COV-01",
	futureNoTrigger: "W-META-01",
	finishedNoEvidence: "W-EVID-01",
	overrideContext: "W-OVERRIDE-01",
	contractMissing: "E-CONTRACT-01",
	scaffoldLeftover: "W-SCAFFOLD-01",
	agentsSkills: "I-AGENTS-01",
	notInstalled: "I-INSTALL-01",
	planSpecDrift: "W-PLAN-01",
} as const;

export type AuditCode = (typeof AUDIT_CODES)[keyof typeof AUDIT_CODES];

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Framework-owned text (contract, plan headers, audit codes) ships in English:
 * it is read by models and published on npm. Text *written into a project*
 * follows that project's language (`zh` when its docs are mostly CJK).
 */
export type ProjectLanguage = "zh" | "en";

/** Seed bodies for core memory files, kept deliberately tiny. */
export const SEEDS: Record<ProjectLanguage, Record<string, string>> = {
	en: {
		finished: [
			"# Finished work",
			"",
			"> Closed work only: a summary, the evidence pointer, and the historical appendix.",
			"> Never restate a spec here; link to it. Never keep an open item here.",
			"",
			"## Summary",
			"",
			"_Nothing closed yet._",
			"",
		].join("\n"),
		future: [
			"# Future and deferred",
			"",
			"> Every entry needs: what, why it waits, and the trigger that would bring it back.",
			"> Adopted entries move to `specs/PLAN.md` and leave a one-line pointer behind.",
			"",
			"_Nothing registered yet._",
			"",
		].join("\n"),
		architecture: [
			"# Architecture",
			"",
			"> Layering, version baseline, decision records (context / decision / consequence / date)",
			"> and the investigation archive. One fact, one home.",
			"",
			"## Layering",
			"",
			"_To be filled in by the init run (evidence only — read the code, do not guess)._",
			"",
			"## Decisions",
			"",
			"_No decisions recorded yet._",
			"",
		].join("\n"),
	},
	zh: {
		finished: [
			"# 已完成",
			"",
			"> 只放已收口的工作：摘要、证据指针、历史附录。",
			"> 不在这里重述规格（给指针），也不留未完成项。",
			"",
			"## 摘要",
			"",
			"_还没有已收口的条目。_",
			"",
		].join("\n"),
		future: [
			"# 远期与延期",
			"",
			"> 每条必须写清：是什么、为什么等、什么条件会把它拉回来（触发条件）。",
			"> 被采纳的条目移入 `specs/PLAN.md`，这里留一行指针。",
			"",
			"_还没有登记。_",
			"",
		].join("\n"),
		architecture: [
			"# 架构与决策",
			"",
			"> 分层、版本基线、决策记录（背景 / 决定 / 后果 / 日期）与调研存档。一个事实一个家。",
			"",
			"## 分层",
			"",
			"_由初始化那一轮填（只写读到的证据，不许猜）。_",
			"",
			"## 决策记录",
			"",
			"_还没有决策。_",
			"",
		].join("\n"),
	},
};

/** Seed body for `specs/PLAN.md`. */
export const PLAN_SEED: Record<ProjectLanguage, string> = {
	en: [
		"# Plan (open work)",
		"",
		"> Route-level plan and open questions only. A unit of work gets its own",
		"> `specs/<unit>.md` before implementation starts; closed work moves to",
		"> `.agents/memory/FINISHED.md` as a summary plus an evidence pointer.",
		"> Progress itself lives in the todo tool — never here.",
		"",
		"## Route",
		"",
		"_No milestones recorded yet._",
		"",
		"## Open questions",
		"",
		"_None._",
		"",
	].join("\n"),
	zh: [
		"# 计划（未完成）",
		"",
		"> 只放路线级计划与未决问题。每个工作单元开工前单独写 `specs/<unit>.md`；",
		"> 已收口的工作移入 `.agents/memory/FINISHED.md`，只留摘要与证据指针。",
		"> 进度本身只在 todo 工具里——这里不写。",
		"",
		"## 路线",
		"",
		"_还没有里程碑。_",
		"",
		"## 未决问题",
		"",
		"_无。_",
		"",
	].join("\n"),
};
