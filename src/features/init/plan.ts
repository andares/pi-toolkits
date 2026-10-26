/**
 * init feature — turn facts into a plan.
 *
 * The plan is split into two halves on purpose:
 *
 *  - **actions** are deterministic and executed by this extension (snapshot,
 *    move, reference rewrite, scaffold, state). They are safe to run twice and
 *    never rewrite prose.
 *  - **tasks** are judgement calls handed to the model in a work order. They
 *    are explicit, bounded, and each one carries its own acceptance criteria.
 *
 * The default is the *conservative pass*: install the framework, fix mechanical
 * drift (tombstones, duplicate sections, appendix order, retired `todos/`) and
 * produce a coverage table. Splitting an over-budget AGENTS.md is recorded as
 * debt, not attempted in the same pass.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	AGENTS_FILE,
	BUDGETS,
	CLAUDE_FILE,
	CONTRACT_FILE,
	FRAMEWORK_DIR,
	FRAMEWORK_VERSION,
	IMPLEMENTATIONS_DIR,
	MEMORY_DIR,
	MEMORY_FILES,
	PLANS_DIR,
	PLAN_FILE,
	PROMPTS_DIR,
	REPORTS_DIR,
	ROOT_MODULES,
	SIGNPOST_FILE,
	SNAPSHOTS_DIR,
	SPECS_DIR,
	STATE_FILE,
	STATE_GITIGNORE,
	type ProjectLanguage,
} from "./spec.js";
import { duplicateHeadings, largestSections, sectionsAfterAppendix, tombstones } from "./analyze.js";
import { countBareRefs } from "./detect.js";
import { indexBlock, rootsBlock } from "./render.js";
import type {
	Action,
	CreateFileAction,
	DocInfo,
	Facts,
	FrameworkState,
	Plan,
	PlanMode,
	RootInfo,
	Task,
} from "./types.js";

export interface PlanOptions {
	/** `--deep`: allow structural rewrites (off by default). */
	readonly deep?: boolean;
	readonly toolVersion: string;
	readonly now?: Date;
}

export function iso(now: Date): string {
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const pad = (value: number): string => String(Math.trunc(Math.abs(value))).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
		now.getHours(),
	)}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(offset / 60)}:${pad(
		offset % 60,
	)}`;
}

/** File-name-safe stamp for one run's plans and reports. */
export function runStamp(createdAt: string): string {
	return createdAt.replace(/[:+]/g, "-");
}

function projectName(root: string): string {
	const name = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "project";
	return name;
}

/* -------------------------------------------------------------------------- */
/* Language tokens                                                             */
/* -------------------------------------------------------------------------- */

/** Flat token map handed to templates; every value is a string. */
type Tokens = Record<string, string>;

export const CONTRACT_LINES: Record<ProjectLanguage, string> = {
	zh: [
		"> 记忆契约（agent-framework v1）：一个事实一个家；不猜事实；进度只在 todo 工具。",
		"> 计划在 `specs/`（PLAN.md + 单元方案），记忆在 `.agents/memory/`，证据在 `.agents/implementations/`。",
		"> 结构审计：`/ask-init check`；写记忆前先读 `.agents/memory/README.md`。",
	].join("\n"),
	en: [
		"> Memory contract (agent-framework v1): one fact, one home; never invent facts; progress lives in the todo tool.",
		"> Plans in `specs/` (PLAN.md + unit specs), memory in `.agents/memory/`, evidence in `.agents/implementations/`.",
		"> Audit with `/ask-init check`; read `.agents/memory/README.md` before writing memory.",
	].join("\n"),
};

const HEADINGS: Record<ProjectLanguage, Record<string, string>> = {
	zh: {
		what: "这是什么",
		rules: "硬规则（不可违反）",
		commands: "命令",
		layout: "目录与分层",
		index: "计划与记忆索引",
		impact: "变更影响索引",
		roots: "工作区根（多仓库）",
		terms: "术语",
		maintenance: "框架维护",
	},
	en: {
		what: "What this is",
		rules: "Hard rules (do not violate)",
		commands: "Commands",
		layout: "Layout",
		index: "Plan and memory index",
		impact: "Change impact index",
		roots: "Workspace roots",
		terms: "Terms",
		maintenance: "Framework maintenance",
	},
};

const DOC_TITLE: Record<ProjectLanguage, string> = {
	zh: "项目指南（AGENTS.md）",
	en: "project guide (AGENTS.md)",
};

function buildTokens(facts: Facts, now: Date, created: ReadonlySet<string>): Tokens {
	const language = facts.language;
	const headings = HEADINGS[language];
	return {
		project: projectName(facts.root),
		frameworkVersion: String(FRAMEWORK_VERSION),
		date: iso(now).slice(0, 10),
		contract: CONTRACT_LINES[language],
		docTitle: DOC_TITLE[language],
		softBudget: String(BUDGETS.agentsMdSoftChars),
		hardBudget: String(BUDGETS.agentsMdHardChars),
		memoryBudget: String(BUDGETS.memoryFileChars),
		implementationsBudget: String(BUDGETS.implementationsFiles),
		statePath: STATE_FILE,
		contractPath: CONTRACT_FILE,
		implementationsDir: IMPLEMENTATIONS_DIR,
		...Object.fromEntries(
			Object.entries(headings).map(([key, value]) => [`h_${key}`, value]),
		),
		index: indexBlock(facts, language, created),
		roots: rootsBlock(facts.roots, language),
	};
}

/* -------------------------------------------------------------------------- */
/* Mode                                                                        */
/* -------------------------------------------------------------------------- */

function frameworkInstalled(facts: Facts): boolean {
	return (
		facts.dirs[MEMORY_DIR] &&
		facts.dirs[IMPLEMENTATIONS_DIR] &&
		(facts.dirs[FRAMEWORK_DIR] || existsSync(join(facts.root, STATE_FILE)))
	);
}

function selectMode(facts: Facts): PlanMode {
	if (facts.state && facts.state.version > FRAMEWORK_VERSION) return "unsupported";
	if (facts.state) {
		if (facts.state.version < FRAMEWORK_VERSION) return "upgrade";
		const layoutOk =
			frameworkInstalled(facts) &&
			!facts.deprecated.memory &&
			!facts.deprecated.implementations &&
			!facts.retiredTodos &&
			// A PLAN.md left in memory is pre-v1 layout, not an installed plan home.
			!existsSync(join(facts.root, MEMORY_DIR, "PLAN.md")) &&
			existsSync(join(facts.root, CONTRACT_FILE));
		return layoutOk ? "audit-only" : "reconcile";
	}
	const anyContent =
		Boolean(facts.context.agents || facts.context.claude) ||
		facts.deprecated.memory ||
		facts.deprecated.implementations ||
		facts.deprecated.prompts ||
		facts.retiredTodos ||
		facts.memory.length > 0 ||
		facts.legacyMemory.length > 0 ||
		facts.specs.length > 0 ||
		facts.implementations.length > 0;
	return anyContent ? "adopt" : "fresh";
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

function buildState(
	facts: Facts,
	now: Date,
	toolVersion: string,
	mode: PlanMode,
): FrameworkState {
	const previous = facts.state;
	const modules = [
		...ROOT_MODULES.filter((module) => facts.dirs[module.dir]).map((module) => module.dir),
		...facts.modulesPresent,
	];
	return {
		version: FRAMEWORK_VERSION,
		tool: toolVersion,
		created: previous?.created ?? iso(now),
		updated: iso(now),
		profile: "core",
		modules: [...new Set(modules)],
		lang: facts.language,
		budgets: previous?.budgets,
		roots: facts.roots.length > 0 ? facts.roots : (previous?.roots ?? []),
		managed: previous?.managed ?? [],
		migrations: [
			...(previous?.migrations ?? []),
			{ at: iso(now), to: String(FRAMEWORK_VERSION), notes: mode },
		],
	};
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

function surveyTask(facts: Facts): Task {
	const read = [
		...facts.project.manifests,
		...facts.project.lockfiles,
		facts.project.license ?? "",
		...facts.project.ci.slice(0, 4),
		facts.context.agents ? AGENTS_FILE : "",
		facts.context.claude ? CLAUDE_FILE : "",
	]
		.filter((value) => value.length > 0)
		.slice(0, 14);
	return {
		id: "survey",
		kind: "survey",
		detail: [
			"Read the project and record only evidence; anything you cannot verify is `TBD`.",
			`Read: ${read.join(", ") || "(no manifests found — walk the tree)"}`,
			`Also: directory tree (depth 2-3, skip build dirs), \`git log --oneline -20\`, README.`,
			`Language for everything you write: ${facts.language}.`,
		].join("\n"),
		acceptance: [
			"every command in AGENTS.md was read from a manifest/CI/script, not guessed",
			"positions and hard rules cite a file instead of a hunch",
		],
	};
}

function editAgentsTask(facts: Facts, deep: boolean): Task | undefined {
	const doc = facts.context.agents;
	if (!doc) return undefined;
	const text = doc.text;
	const steps: string[] = [];
	if (!/agent-framework|\.agents\/memory/.test(text)) {
		steps.push("Add the 3-line memory contract near the top (`.agents/memory/README.md` has the wording).");
	}
	if (!text.includes(PLAN_FILE) || !text.includes(MEMORY_DIR)) {
		steps.push(
			`Merge the plan/memory index into AGENTS.md: \`${PLAN_FILE}\` + \`${SPECS_DIR}/<unit>.md\`, then one row per file in \`${MEMORY_DIR}/\`.`,
		);
	}
	const hasLegacyPaths =
		countBareRefs(text, "memory/") > 0 || countBareRefs(text, "implementations/") > 0;
	if (!text.includes(IMPLEMENTATIONS_DIR) || hasLegacyPaths) {
		steps.push(
			`Update every path in the layout/records sections to the framework paths (\`${IMPLEMENTATIONS_DIR}/\`, \`${MEMORY_DIR}/\`).`,
		);
	}
	const dead = tombstones(doc);
	if (dead.length > 0) {
		steps.push(
			`Remove tombstone sections whose content already lives elsewhere: ${dead
				.map((heading) => `§${heading.text}`)
				.join(", ")}.`,
		);
	}
	const dupes = duplicateHeadings([
		doc,
		...facts.memory,
		...facts.legacyMemory,
	]).slice(0, 4);
	if (dupes.length > 0) {
		steps.push(
			`Collapse duplicated sections to a pointer (keep the owning file, delete the copy after checking no fact is unique): ${dupes
				.map(
					(group) =>
						`"${group.occurrences[0].heading}" (${group.occurrences
							.map((occurrence) => occurrence.path)
							.join(" / ")})`,
				)
				.join("; ")}.`,
		);
	}
	const after = sectionsAfterAppendix(doc);
	if (after.length > 0) {
		steps.push(
			`Move appendices to the end (currently followed by: ${after
				.map((heading) => `§${heading.text}`)
				.join(", ")}).`,
		);
	}
	if (facts.roots.length > 0 && !/Workspace roots|工作区根/.test(text)) {
		steps.push("Add the workspace-roots table (memory stays in the main repo; roots get scope cards).");
	}
	if (deep) {
		steps.push(
			"Deep pass: split over-budget sections into their owning memory files, updating the index in the same edit.",
		);
	}
	if (steps.length === 0) return undefined;
	return {
		id: "edit-agents",
		kind: "edit-agents",
		targets: [AGENTS_FILE],
		detail: steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
		acceptance: [
			"no fact was dropped: every removed sentence is either still present verbatim in the destination or listed in the coverage table",
			`AGENTS.md stays under ${BUDGETS.agentsMdHardChars} characters (soft: ${BUDGETS.agentsMdSoftChars})`,
		],
	};
}

function budgetTask(facts: Facts): Task | undefined {
	const doc = facts.context.agents;
	if (!doc) return undefined;
	if (doc.bytes <= BUDGETS.agentsMdHardChars) return undefined;
	const largest = largestSections(doc, 4);
	return {
		id: "budget-debt",
		kind: "budget-debt",
		detail: [
			`AGENTS.md is ${doc.bytes} characters (soft ${BUDGETS.agentsMdSoftChars}, hard ${BUDGETS.agentsMdHardChars}).`,
			"This pass does not rewrite prose: record the overflow in `specs/PLAN.md` as debt.",
			"Largest sections (candidates to move into their owning memory file, leaving a pointer):",
			...largest.map(({ heading, chars }) => `  - §${heading.text} — ${chars} chars`),
			"Suggested homes: glossary → `.agents/memory/TERMS.md`, component inventory → `.agents/memory/ARCHITECTURE.md`, visual rules → `.agents/memory/DESIGN.md`.",
		].join("\n"),
		acceptance: ["the debt is written into specs/PLAN.md with the measured number", "no section was moved in this pass"],
	};
}

/** The plan document that should move into an empty `specs/PLAN.md`. */
function planMoveSource(facts: Facts): DocInfo | undefined {
	if (existsSync(join(facts.root, PLAN_FILE))) return undefined;
	// Prefer the root-level plan: it has to leave the root anyway. A second
	// source is merged by the model instead of being chosen for it.
	return (
		facts.legacyDocs.find((doc) => doc.rel === "PLAN.md") ??
		facts.legacyMemory.find((doc) => doc.rel === "memory/PLAN.md") ??
		facts.memory.find((doc) => doc.rel === `${MEMORY_DIR}/PLAN.md`)
	);
}

function mergePlanTask(facts: Facts): Task | undefined {
	const moved = planMoveSource(facts);
	const sources = [
		facts.legacyDocs.find((doc) => doc.rel === "PLAN.md"),
		facts.legacyMemory.find((doc) => doc.rel === "memory/PLAN.md"),
		facts.memory.find((doc) => doc.rel === `${MEMORY_DIR}/PLAN.md`),
	].filter((doc): doc is DocInfo => doc !== undefined && doc !== moved);
	if (!moved && sources.length === 0) return undefined;

	const detail: string[] = [];
	if (moved) {
		detail.push(
			`\`${moved.rel}\` was moved to \`${PLAN_FILE}\` verbatim (content untouched); shape it now.`,
		);
	}
	for (const source of sources) {
		// The legacy memory directory is moved before the model runs, so the
		// instruction must point at the post-move path, not the vanished one.
		const current = source.rel.startsWith("memory/")
			? `${MEMORY_DIR}/${source.rel.slice("memory/".length)}`
			: source.rel;
		detail.push(`Merge \`${current}\` into \`${PLAN_FILE}\`; remove the source afterwards.`);
	}
	detail.push(
		"Keep: route/milestones still open, open questions, and decisions that still bind.",
		"Move decision records to `.agents/memory/ARCHITECTURE.md` (leave a pointer).",
		"Move closed work to `.agents/memory/FINISHED.md` as summary + evidence pointer.",
		"Progress lists stay out of both files (todo tool owns progress).",
	);
	return {
		id: moved ? "edit-plan" : "merge-plan",
		kind: "merge-plan",
		targets: [
			...(moved ? [moved.rel] : []),
			...sources.map((source) =>
				source.rel.startsWith("memory/")
					? `${MEMORY_DIR}/${source.rel.slice("memory/".length)}`
					: source.rel,
			),
			PLAN_FILE,
		],
		detail: detail.join("\n"),
		acceptance: [
			`\`${PLAN_FILE}\` contains every still-open item from every source`,
			"no completed items and no progress table remain in the plan",
			"nothing was deleted without a coverage-table row",
		],
	};
}

function triageTodosTask(facts: Facts): Task | undefined {
	if (!facts.retiredTodos) return undefined;
	const specs = facts.specs.map((doc) => doc.rel.replace(`${SPECS_DIR}/`, "").replace(/\.md$/, ""));
	const byTodo = facts.todos.map((todo) => {
		const slug = todo.rel.replace(/^todos\//, "").replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
		const tokens = slug.split("-").filter((token) => token.length >= 4);
		const match = specs.find(
			(name) =>
				name.includes(slug) ||
				slug.includes(name) ||
				tokens.some((token) => name.includes(token)),
		);
		return `- ${todo.rel} → ${match ? `${SPECS_DIR}/${match}.md` : "new spec draft"}`;
	});
	return {
		id: "triage-todos",
		kind: "triage-todos",
		targets: [SPECS_DIR],
		detail: [
			"`todos/` is retired. Each requirement becomes a spec:",
			...byTodo,
			"For an existing spec, append the verbatim wording under `## Requirement (verbatim)`.",
			"For a new one, create `specs/<unit>.md` from the spec template and keep the wording verbatim.",
			"Only then delete `todos/` (the snapshot still has the originals).",
		].join("\n"),
		acceptance: [
			"every todos/ file has a destination spec with its original wording",
			"`todos/` no longer exists",
		],
	};
}

function rootCardsTask(facts: Facts): Task | undefined {
	const missing = facts.roots.filter((root) => root.agentsMd === "none");
	if (missing.length === 0) return undefined;
	return {
		id: "root-cards",
		kind: "root-cards",
		targets: missing.map((root) => join(root.absolute, "AGENTS.md")),
		detail: [
			"Create a scope card (≤30 lines) in each root that has none:",
			...missing.map((root) => `- ${root.label}: \`${root.absolute}/AGENTS.md\``),
			"Content: what lives here, its commands, and which main-repo memory file describes it.",
			"Never copy the framework rules into a root: pi-add-dir injects each root AGENTS.md verbatim into every request.",
			"Writes outside the main repository are ordinary tool calls and therefore subject to the permission gate.",
		].join("\n"),
		acceptance: ["each scope card is ≤30 lines", "no rule is duplicated from the main AGENTS.md"],
	};
}

/**
 * Non-plan legacy documents need an explicit destination too. Without this task
 * they would appear in the coverage table but nobody would be asked to move
 * their content — the table would be a checklist without an owner.
 */
function legacyDocsTask(facts: Facts): Task | undefined {
	const docs = facts.legacyDocs.filter((doc) => doc.rel !== "PLAN.md");
	if (docs.length === 0) return undefined;
	const destinationFor = (rel: string): string => {
		if (/^(TODO|TASKS|ROADMAP)\.md$/i.test(rel)) return PLAN_FILE;
		if (/^(adr|decisions|docs\/adr|docs\/decisions)\//.test(rel)) {
			return `${MEMORY_DIR}/ARCHITECTURE.md (decision records)`;
		}
		return `${MEMORY_DIR}/ARCHITECTURE.md or docs/ (whichever owns the content)`;
	};
	return {
		id: "merge-legacy-docs",
		kind: "merge-legacy",
		targets: docs.map((doc) => doc.rel),
		detail: [
			"Migrate these legacy documents instead of leaving them beside the framework:",
			...docs.map((doc) => `- ${doc.rel} → ${destinationFor(doc.rel)}`),
			"Keep decisions as decisions, open work as open work, and prose as documentation; do not flatten everything into one file.",
			"Only remove a source after its coverage rows say where each section went.",
		].join("\n"),
		acceptance: [
			"every listed document has a destination or a written reason to keep it",
			"no open item is lost and no decision is silently dropped",
		],
	};
}

function coverageTask(facts: Facts, now: Date): Task | undefined {
	const sources = [
		...(facts.context.agents ? [AGENTS_FILE] : []),
		...facts.legacyMemory.map((doc) => doc.rel),
		...facts.legacyDocs.map((doc) => doc.rel),
		...facts.todos.map((doc) => doc.rel),
	];
	if (sources.length === 0) return undefined;
	const report = `${REPORTS_DIR}/coverage-${runStamp(iso(now))}.md`;
	return {
		id: "coverage",
		kind: "coverage",
		targets: [report],
		detail: [
			"Fill the coverage table: one row per source section (`##`/`###`) with destination or reason.",
			`sources: ${sources.join(", ")}`,
			`report: ${report} (table columns: source#heading | destination | reason)`,
			`Then run the framework_audit tool; it reports unaccounted sections and budget/duplication findings.`,
		].join("\n"),
		acceptance: [
			"0 unaccounted source sections",
			"every 'dropped' row explains why the fact is no longer needed",
		],
	};
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

export function buildPlan(facts: Facts, options: PlanOptions): Plan {
	const now = options.now ?? new Date();
	const language = facts.language;
	const deep = options.deep === true;
	const mode = selectMode(facts);
	const warnings = [...facts.warnings];
	if (facts.isGit && facts.gitClean === false) {
		warnings.push(
			`worktree is not clean (${facts.gitDirtyCount} entries): commit or stash first so the migration diff stays reviewable`,
		);
	}

	if (mode === "audit-only") {
		return {
			mode,
			root: facts.root,
			language,
			frameworkVersion: FRAMEWORK_VERSION,
			toolVersion: options.toolVersion,
			createdAt: iso(now),
			actions: [],
			tasks: [],
			artifacts: {},
			summary: [
				`framework v${FRAMEWORK_VERSION} is installed and matches the layout`,
				"nothing to migrate — run an audit instead",
			],
			warnings,
			facts,
		};
	}

	const actions: Action[] = [];
	const tasks: Task[] = [];
	const summary: string[] = [];

	/* Snapshot every path this plan may touch. */
	const snapshotPaths = [
		AGENTS_FILE,
		CLAUDE_FILE,
		facts.deprecated.memory ? "memory" : "",
		facts.deprecated.implementations ? "implementations" : "",
		facts.deprecated.prompts ? "prompts" : "",
		facts.retiredTodos ? "todos" : "",
		PLAN_FILE,
		STATE_FILE,
		...facts.legacyDocs.map((doc) => doc.rel),
		...facts.memory.map((doc) => doc.rel),
		// The rewrite can touch any file that mentions a legacy path, so the
		// snapshot has to cover exactly those files: that is what makes the
		// "nothing is written before it is snapshotted" guarantee true.
		...facts.refs.paths,
	]
		.filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
		.filter((rel) => existsSync(join(facts.root, rel)));
	if (snapshotPaths.length > 0) {
		actions.push({
			kind: "snapshot",
			paths: snapshotPaths,
			files: 0,
		});
	}

	/* Moves first: a destination must not be pre-created by the scaffold, or the
	 * move sees a non-empty target and refuses. A conflict is never auto-merged:
	 * it becomes a model task. */
	const moves: Array<{ from: string; to: string; files: number }> = [];
	const conflicts: string[] = [];
	if (facts.deprecated.memory) {
		if (facts.dirs[MEMORY_DIR]) conflicts.push("memory/ and .agents/memory/ both exist");
		else
			moves.push({
				from: "memory",
				to: MEMORY_DIR,
				files: facts.deprecatedFiles.memory,
			});
	}
	if (facts.deprecated.implementations) {
		if (facts.dirs[IMPLEMENTATIONS_DIR])
			conflicts.push("implementations/ and .agents/implementations/ both exist");
		else
			moves.push({
				from: "implementations",
				to: IMPLEMENTATIONS_DIR,
				files: facts.deprecatedFiles.implementations,
			});
	}
	if (facts.deprecated.prompts) {
		if (facts.dirs[PROMPTS_DIR]) conflicts.push("prompts/ and .agents/prompts/ both exist");
		else moves.push({ from: "prompts", to: PROMPTS_DIR, files: facts.deprecatedFiles.prompts });
	}
	// The plan file changes home too. Moving it as a file keeps the content
	// byte-identical; the model only shapes it afterwards. This must happen
	// before the directory move (the source would be gone).
	const planMove = planMoveSource(facts);
	if (planMove) actions.push({ kind: "move-file", from: planMove.rel, to: PLAN_FILE });

	for (const move of moves) {
		actions.push({
			kind: "move-dir",
			from: move.from,
			to: move.to,
			files: move.files,
			trackedOnly: facts.isGit,
		});
	}

	/* Parent directories only. Move destinations are created by the move itself,
	 * otherwise a pre-created destination would look like a conflict. */
	const dirs = [".agents", FRAMEWORK_DIR, SPECS_DIR].filter(
		(rel) => !existsSync(join(facts.root, rel)),
	);
	if (!moves.some((move) => move.to === MEMORY_DIR)) dirs.push(MEMORY_DIR);
	if (!moves.some((move) => move.to === IMPLEMENTATIONS_DIR)) dirs.push(IMPLEMENTATIONS_DIR);
	const missingDirs = dirs.filter(
		(rel, index) => dirs.indexOf(rel) === index && !existsSync(join(facts.root, rel)),
	);
	if (missingDirs.length > 0) actions.push({ kind: "create-dirs", paths: missingDirs });
	for (const conflict of conflicts) warnings.push(`conflict: ${conflict} — merge by hand (task merge-legacy)`);
	if (conflicts.length > 0) {
		tasks.push({
			id: "merge-legacy",
			kind: "merge-legacy",
			detail: [
				"Two locations for the same framework directory exist. Merge deliberately:",
				...conflicts.map((conflict) => `- ${conflict}`),
				"Keep the canonical `.agents/` copy as the destination; carry over anything unique; leave no duplicate fact.",
			].join("\n"),
			acceptance: ["the legacy directory is gone", "the coverage table lists every merged file"],
		});
	}

	/* Reference rewrite pairs, longest first. */
	const pairs: Array<{ from: string; to: string }> = [];
	if (facts.legacyMemory.some((doc) => doc.rel === "memory/PLAN.md")) {
		pairs.push({ from: "memory/PLAN.md", to: PLAN_FILE });
	}
	if (facts.memory.some((doc) => doc.rel === `${MEMORY_DIR}/PLAN.md`)) {
		pairs.push({ from: `${MEMORY_DIR}/PLAN.md`, to: PLAN_FILE });
	}
	for (const move of moves) pairs.push({ from: `${move.from}/`, to: `${move.to}/` });

	/* Scaffold. `created` feeds the index block, so it is built first. */
	const creates: CreateFileAction[] = [];
	const created = new Set<string>();
	const planWillExist =
		existsSync(join(facts.root, PLAN_FILE)) ||
		facts.memory.some((doc) => doc.rel === `${MEMORY_DIR}/PLAN.md`) ||
		facts.legacyMemory.some((doc) => doc.rel === "memory/PLAN.md") ||
		facts.legacyDocs.some((doc) => doc.rel === "PLAN.md");
	const add = (
		path: string,
		template: string,
		tokens: Record<string, string>,
		note: string,
	): void => {
		if (existsSync(join(facts.root, path))) return;
		creates.push({ kind: "create-file", path, template, tokens, note });
		created.add(path);
	};

	if (!planWillExist) add(PLAN_FILE, "plan", {}, "plan home");
	add(
		SIGNPOST_FILE,
		"signpost",
		{ frameworkVersion: String(FRAMEWORK_VERSION) },
		"signpost for the hidden agent directory",
	);
	add(CONTRACT_FILE, "memory-readme", { frameworkVersion: String(FRAMEWORK_VERSION) }, "framework contract");
	add(STATE_GITIGNORE, "state-gitignore", {}, "ignore runtime state");
	for (const spec of MEMORY_FILES) {
		if (!spec.core) continue;
		const dest = `${MEMORY_DIR}/${spec.file}`;
		const legacy = `memory/${spec.file}`;
		if (existsSync(join(facts.root, dest)) || existsSync(join(facts.root, legacy))) continue;
		add(dest, `seed-${spec.role}`, {}, `${spec.owns}`);
	}
	if (!facts.context.agents) {
		// Fresh (or CLAUDE-only): create the entry skeleton. For an existing
		// CLAUDE.md the task list imports its unique content afterwards.
		add(AGENTS_FILE, "agents-skeleton", {}, "framework entry");
	}

	const tokens = buildTokens(facts, now, created);
	for (const action of creates) {
		actions.push({
			...action,
			tokens: { ...tokens, ...action.tokens } as Record<string, string>,
		});
	}

	/* Rewrite last: it also normalises the files this run just created (the
	 * contract and the signpost quote canonical paths), so a second run finds
	 * nothing left to rewrite. */
	if (pairs.length > 0 && facts.refs.hits > 0) {
		actions.push({
			kind: "rewrite-refs",
			pairs,
			files: facts.refs.paths.length,
			hits: facts.refs.hits,
		});
	}

	/* Tasks. */
	if (mode !== "upgrade") tasks.push(surveyTask(facts));
	const edit = editAgentsTask(facts, deep);
	if (edit) tasks.push(edit);
	else if (!facts.context.agents) {
		tasks.push({
			id: "fill-agents",
			kind: "fill-file",
			targets: [AGENTS_FILE],
			detail: [
				"Fill the AGENTS.md skeleton from evidence: positioning, hard rules, commands, layout, change-impact index, terms.",
				"Replace every `TODO(ask-init)` marker; leave nothing invented — use `TBD` when the repo does not say.",
			].join("\n"),
			acceptance: [
				"no TODO(ask-init) marker remains",
				"the memory index points at files that exist",
			],
		});
	}
	if (facts.context.claude && facts.context.agents) {
		const agentsLines = new Set(
			facts.context.agents.text
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 20),
		);
		const claudeLines = facts.context.claude.text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 20);
		const shared = claudeLines.filter((line) => agentsLines.has(line)).length;
		const overlap = claudeLines.length > 0 ? shared / claudeLines.length : 0;
		if (overlap >= 0.6) {
			tasks.push({
				id: "dedupe-claude",
				kind: "merge-legacy",
				targets: [CLAUDE_FILE, AGENTS_FILE],
				detail: [
					`${CLAUDE_FILE} duplicates ${Math.round(overlap * 100)}% of AGENTS.md.`,
					"pi loads AGENTS.md and ignores CLAUDE.md in the same directory; other tools read CLAUDE.md.",
					"Keep AGENTS.md canonical and reduce CLAUDE.md to a short pointer, unless it carries rules that are specific to another tool.",
				].join("\n"),
				acceptance: [
					"no rule exists only in CLAUDE.md",
					"CLAUDE.md no longer duplicates AGENTS.md",
				],
			});
		}
	}
	if (facts.context.claude && !facts.context.agents) {
		tasks.push({
			id: "merge-claude",
			kind: "merge-legacy",
			targets: [CLAUDE_FILE, AGENTS_FILE],
			detail: [
				"`CLAUDE.md` exists but `AGENTS.md` is the pi entry.",
				"Carry every unique rule into AGENTS.md (or the memory file that owns it), then reduce CLAUDE.md to a short pointer so the two cannot drift.",
			].join("\n"),
			acceptance: ["no rule exists only in CLAUDE.md", "CLAUDE.md no longer duplicates AGENTS.md"],
		});
	}
	const mergePlan = mergePlanTask(facts);
	if (mergePlan) tasks.push(mergePlan);
	const legacyDocs = legacyDocsTask(facts);
	if (legacyDocs) tasks.push(legacyDocs);
	const triage = triageTodosTask(facts);
	if (triage) tasks.push(triage);
	const roots = rootCardsTask(facts);
	if (roots) tasks.push(roots);
	const budget = budgetTask(facts);
	if (budget) tasks.push(budget);
	const coverage = coverageTask(facts, now);
	if (coverage) tasks.push(coverage);

	/* State last: it records what this run created and moved. */
	actions.push({ kind: "write-state", state: buildState(facts, now, options.toolVersion, mode) });

	/* Summary for the confirmation panel. */
	const modeLine: Record<PlanMode, string> = {
		fresh: "fresh project: install framework v1",
		adopt: "existing project: adopt framework v1 (conservative pass)",
		reconcile: "framework present but layout drifted: reconcile",
		upgrade: `framework ${facts.state?.version ?? 0} → ${FRAMEWORK_VERSION}: upgrade`,
		"audit-only": "already installed: audit only",
		unsupported: "framework is newer than this tool: refusing",
	};
	summary.push(modeLine[mode]);
	for (const move of moves) {
		summary.push(`move ${move.from}/ → ${move.to}/ (${move.files} files)`);
	}
	if (planMove) summary.push(`move ${planMove.rel} → ${PLAN_FILE} (content untouched)`);
	const rewrite = actions.find((action) => action.kind === "rewrite-refs");
	if (rewrite && rewrite.kind === "rewrite-refs") {
		summary.push(
			`rewrite ${rewrite.hits} path references in ${rewrite.files} files (dry-run counts)`,
		);
	}
	if (creates.length > 0) {
		summary.push(`create ${creates.length} files (contract, signpost, seeds, state)`);
	}
	if (tasks.length > 0) {
		summary.push(`hand ${tasks.length} tasks to the model: ${tasks.map((task) => task.id).join(", ")}`);
	}
	if (snapshotPaths.length > 0) {
		summary.push(`snapshot ${snapshotPaths.length} paths before writing`);
	}
	if (mode === "upgrade") {
		summary.push(
			"no upgrade recipe exists for this version pair: review `.agents/memory/README.md` and migrate by hand",
		);
	}

	return {
		mode,
		root: facts.root,
		language,
		frameworkVersion: FRAMEWORK_VERSION,
		toolVersion: options.toolVersion,
		createdAt: iso(now),
		actions,
		tasks,
		artifacts: {
			plan: `${PLANS_DIR}/plan-${runStamp(iso(now))}.json`,
			coverage: coverage ? coverage.targets?.[0] : undefined,
			rewrite: pairs.length > 0 ? `${REPORTS_DIR}/rewrite-${runStamp(iso(now))}.md` : undefined,
			snapshot: snapshotPaths.length > 0 ? `${SNAPSHOTS_DIR}/${runStamp(iso(now))}` : undefined,
		},
		summary,
		warnings,
		facts,
	};
}

/** Roots that are registered but missing on disk (used by the plan and audit). */
export function staleRoots(facts: Facts): RootInfo[] {
	return facts.roots.filter((root) => !root.exists);
}
