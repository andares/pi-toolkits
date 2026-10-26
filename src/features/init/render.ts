/**
 * init feature — markdown fragments shared by the plan, the scaffold and the
 * work order. Kept language-aware: the framework's own text is English, but
 * anything written into a project follows that project's language.
 */
import {
	MEMORY_DIR,
	MEMORY_FILES,
	PLAN_FILE,
	SPECS_DIR,
	type MemoryRole,
	type ProjectLanguage,
} from "./spec.js";
import type { Facts, RootInfo } from "./types.js";

const READ_WHEN: Record<MemoryRole, { zh: string; en: string }> = {
	contract: { zh: "写记忆之前", en: "before writing memory" },
	finished: { zh: "收口工作、查历史证据", en: "closing work, tracing evidence" },
	future: { zh: "决定延期/放弃之前", en: "before deferring or rejecting work" },
	architecture: { zh: "改分层、选型、跨模块改动前", en: "layering, versions, cross-module changes" },
	design: { zh: "动界面视觉之前", en: "before touching visual design" },
	terms: { zh: "命名、文案、界面术语之前", en: "naming, copy, UI terminology" },
	review: { zh: "周期性评审、方向修正", en: "periodic review, direction changes" },
	debugging: { zh: "排查运行期问题", en: "diagnosing runtime problems" },
	function: { zh: "改这个模块的功能之前", en: "before changing that module" },
};

const INDEX_TITLES: Record<ProjectLanguage, { plan: string; memory: string; none: string }> = {
	zh: { plan: "计划", memory: "记忆", none: "_（尚未出现）_" },
	en: { plan: "Plan", memory: "Memory", none: "_(none yet)_" },
};

/** Rows for the plan table of the AGENTS.md index. */
export function planIndexRows(language: ProjectLanguage): string[] {
	if (language === "zh") {
		return [
			`| \`${PLAN_FILE}\` | 路线级计划与未决问题 | 开工前 |`,
			`| \`${SPECS_DIR}/<unit>.md\` | 单工作单元：需求原文 / 方案 / 验收清单 | 做这个单元时 |`,
		];
	}
	return [
		`| \`${PLAN_FILE}\` | Route-level plan and open questions | before starting work |`,
		`| \`${SPECS_DIR}/<unit>.md\` | One unit of work: requirement / approach / acceptance | when doing that unit |`,
	];
}

/** Rows for the memory table: files that exist now plus the core ones created now. */
export function memoryIndexRows(
	facts: Facts,
	language: ProjectLanguage,
	created: ReadonlySet<string>,
): string[] {
	const rows: string[] = [];
	for (const spec of MEMORY_FILES) {
		const rel = `${MEMORY_DIR}/${spec.file}`;
		const present = facts.memory.some((doc) => doc.rel === rel);
		const legacyPresent = facts.legacyMemory.some(
			(doc) => doc.rel === `memory/${spec.file}`,
		);
		const willExist = present || legacyPresent || created.has(rel);
		if (!willExist) continue;
		const label = spec.file.startsWith("FUNCTION-")
			? `${MEMORY_DIR}/FUNCTION-<MODULE>.md`
			: rel;
		rows.push(
			language === "zh"
				? `| \`${label}\` | ${spec.owns} | ${READ_WHEN[spec.role].zh} |`
				: `| \`${label}\` | ${spec.owns} | ${READ_WHEN[spec.role].en} |`,
		);
	}
	if (created.has(`${MEMORY_DIR}/README.md`)) {
		rows.unshift(
			language === "zh"
				? `| \`${MEMORY_DIR}/README.md\` | 框架契约：文件职责、写入规则、预算、压缩法 | 写记忆之前 |`
				: `| \`${MEMORY_DIR}/README.md\` | Framework contract: roles, write rules, budgets, compaction | before writing memory |`,
		);
	}
	return rows;
}

/** The AGENTS.md index body (two labelled tables). */
export function indexBlock(
	facts: Facts,
	language: ProjectLanguage,
	created: ReadonlySet<string>,
): string {
	const titles = INDEX_TITLES[language];
	const planRows = planIndexRows(language);
	const memoryRows = memoryIndexRows(facts, language, created);
	const header =
		language === "zh" ? "| 文件 | 拥有什么 | 何时读 |\n| --- | --- | --- |" : "| File | Owns | Read when |\n| --- | --- | --- |";
	const parts = [
		`### ${titles.plan}`,
		"",
		header,
		...planRows,
		"",
		`### ${titles.memory}`,
		"",
		header,
		...(memoryRows.length > 0 ? memoryRows : [titles.none]),
	];
	return parts.join("\n");
}

/** The workspace-roots section, or an empty string when there are no roots. */
export function rootsBlock(roots: readonly RootInfo[], language: ProjectLanguage): string {
	if (roots.length === 0) return "";
	const title = language === "zh" ? "工作区根（多仓库）" : "Workspace roots";
	const note =
		language === "zh"
			? "> 记忆只住在主仓；下列目录的 `AGENTS.md` 只写本仓职责与本仓命令（≤30 行），不复制规则。"
			: "> Memory lives in the main repository only. A listed root's `AGENTS.md` states its role and commands (≤30 lines), never a copy of the rules.";
	const header =
		language === "zh"
			? "| 根 | 路径 | 职责 | 它的记忆 |\n| --- | --- | --- | --- |"
			: "| Root | Path | Role | Its memory |\n| --- | --- | --- | --- |";
	const rows = roots.map((root) => {
		const memory =
			root.agentsMd === "independent"
				? language === "zh"
					? "独立项目（自带记忆，不接管）"
					: "independent project (owns its memory)"
				: language === "zh"
					? `主仓 \`${MEMORY_DIR}/\``
					: `main repo \`${MEMORY_DIR}/\``;
		const role = root.role ?? (language === "zh" ? "待补充" : "to be filled in");
		return `| ${root.label} | \`${root.path}\`${root.exists ? "" : " (missing)"} | ${role} | ${memory} |`;
	});
	return [`## ${title}`, "", note, "", header, ...rows, ""].join("\n");
}
