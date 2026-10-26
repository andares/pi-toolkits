import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildPlan } from "./plan.js";
import { detect } from "./detect.js";
import { installedProject, project, remove } from "./test-helpers.js";

const AGENTS = [
	"# demo — 项目指南",
	"",
	"> 本文件只保留每次会话都需要的内容。细节记忆按主题放在 `memory/`，用到再读。",
	"",
	"## 1. 定位",
	"",
	"演示项目。",
	"",
	"## 6. 已确定的架构决定",
	"",
	"- 渲染走原生。",
	"",
	"## 8. 必须处理的问题清单",
	"",
	"已迁至 `memory/PLAN.md` §5。",
	"",
	"## 9. 初始化状态",
	"",
	"项目初始化已完成（M0）。记录见 `memory/FINISHED.md`。",
	"",
	"## 附录 A：历史路线",
	"",
	"旧规划原文。",
	"",
	"## 2026-10-11 追加",
	"",
	"后来补的一节。",
	"",
].join("\n");

const LEGACY = {
	"AGENTS.md": AGENTS,
	"memory/PLAN.md": "# 计划\n\n## 路线\n\n- M1 未完成\n",
	"memory/FINISHED.md": "# 已完成\n\n## 摘要\n\n- M0：见 `implementations/2026-01-01_a.md`\n",
	"memory/ARCHITECTURE.md": "# 架构\n\n## 6. 已确定的架构决定\n\n- 分层。\n",
	"memory/DESIGN.md": "# 视觉\n\n## 令牌\n",
	"implementations/2026-01-01_a.md": "# a\n\n见 `memory/ARCHITECTURE.md`。\n",
	"specs/a.md": "# a\n\n证据：`implementations/2026-01-01_a.md`。\n",
	"specs/editor-presets.md": "# editor presets\n\n## 验收\n\n- [x] done\n",
	"todos/2026-01-02-editor-presets.md": "# 原始需求\n\n把预设做出来。\n",
	"src/a.ts": "// 见 `memory/DESIGN.md`\n",
};

describe("buildPlan", () => {
	it("plans a fresh install without inventing content", () => {
		const root = project({ "README.md": "# demo\n" });
		try {
			const plan = buildPlan(detect(root), { toolVersion: "test", now: new Date("2026-10-26T10:00:00Z") });
			expect(plan.mode).toBe("fresh");
			const created = plan.actions
				.filter((action) => action.kind === "create-file")
				.map((action) => (action.kind === "create-file" ? action.path : ""));
			expect(created).toContain("AGENTS.md");
			expect(created).toContain(".agents/memory/README.md");
			expect(created).toContain(".agents/README.md");
			expect(created).toContain("specs/PLAN.md");
			expect(created).toContain(".agents/memory/ARCHITECTURE.md");
			// Optional modules are not created as empty shells.
			expect(created).not.toContain(".agents/memory/DESIGN.md");
			expect(plan.tasks.map((task) => task.id)).toEqual(["survey", "fill-agents"]);
			expect(plan.actions.some((action) => action.kind === "move-dir")).toBe(false);
		} finally {
			remove(root);
		}
	});

	it("plans a conservative adoption of a legacy layout", () => {
		const root = project(LEGACY);
		try {
			const facts = detect(root);
			const plan = buildPlan(facts, { toolVersion: "test", now: new Date("2026-10-26T10:00:00Z") });
			expect(plan.mode).toBe("adopt");
			const moves = plan.actions.filter((action) => action.kind === "move-dir");
			expect(moves.map((action) => (action.kind === "move-dir" ? action.from : ""))).toEqual([
				"memory",
				"implementations",
			]);
			const fileMove = plan.actions.find((action) => action.kind === "move-file");
			expect(fileMove && fileMove.kind === "move-file" ? fileMove.to : "").toBe("specs/PLAN.md");
			const rewrite = plan.actions.find((action) => action.kind === "rewrite-refs");
			expect(rewrite && rewrite.kind === "rewrite-refs" ? rewrite.hits : 0).toBe(facts.refs.hits);
			expect(rewrite && rewrite.kind === "rewrite-refs" ? rewrite.pairs[0] : undefined).toEqual({
				from: "memory/PLAN.md",
				to: "specs/PLAN.md",
			});
			const ids = plan.tasks.map((task) => task.id);
			expect(ids).toContain("survey");
			expect(ids).toContain("edit-agents");
			expect(ids).toContain("triage-todos");
			expect(ids).toContain("coverage");
			const edit = plan.tasks.find((task) => task.id === "edit-agents");
			expect(edit?.detail).toMatch(/tombstone|§8|§9/);
			expect(edit?.detail).toMatch(/appendices|附录/i);
			const triage = plan.tasks.find((task) => task.id === "triage-todos");
			expect(triage?.detail).toMatch(/specs\/editor-presets\.md/);
			// A budget overrun is recorded as debt, not paid silently in this pass.
			expect(ids).not.toContain("budget-debt");
		} finally {
			remove(root);
		}
	});

	it("records AGENTS.md budget overflow as debt with the largest sections", () => {
		const big = Array.from({ length: 900 }, (_, index) => `- 规则 ${index}：这是一条很长的说明文字，用来把文件撑过硬预算。`).join("\n");
		const root = project({ "AGENTS.md": `# demo\n\n## 规则\n\n${big}\n` });
		try {
			const plan = buildPlan(detect(root), { toolVersion: "test", now: new Date("2026-10-26T10:00:00Z") });
			const debt = plan.tasks.find((task) => task.id === "budget-debt");
			expect(debt).toBeDefined();
			expect(debt?.detail).toMatch(/hard/);
			expect(debt?.detail).toMatch(/§规则/);
		} finally {
			remove(root);
		}
	});

	it("reports an installed framework as audit-only", () => {
		const root = installedProject();
		try {
			const plan = buildPlan(detect(root), { toolVersion: "test" });
			expect(plan.mode).toBe("audit-only");
			expect(plan.actions).toEqual([]);
			expect(plan.tasks).toEqual([]);
		} finally {
			remove(root);
		}
	});

	it("refuses a framework newer than the tool", () => {
		const root = installedProject({
			".agents/framework/state.toml": 'version = 99\ntool = "future"\n',
		});
		try {
			const plan = buildPlan(detect(root), { toolVersion: "test" });
			expect(plan.mode).toBe("unsupported");
		} finally {
			remove(root);
		}
	});

	it("never auto-merges two copies of the same directory", () => {
		const root = installedProject({
			"memory/PLAN.md": "# 旧计划\n\n见 `memory/PLAN.md`\n",
			"implementations/2026-01-01_old.md": "# old\n",
		});
		try {
			const plan = buildPlan(detect(root), { toolVersion: "test" });
			expect(plan.mode).toBe("reconcile");
			const moves = plan.actions.filter((action) => action.kind === "move-dir");
			expect(moves).toHaveLength(0);
			expect(plan.tasks.map((task) => task.id)).toContain("merge-legacy");
			expect(plan.warnings.join("\n")).toMatch(/both exist/);
		} finally {
			remove(root);
		}
	});

	it("asks for a CLAUDE.md dedupe when the two entries overlap", () => {
		const shared = [
			"# demo",
			"",
			"## Rules",
			"",
			"- Package manager is pnpm; never run npm install in this repo.",
			"- Tests must stay green before a commit is reported.",
			"- Never invent a fact; read the code instead of guessing.",
			"",
		].join("\n");
		const root = project({ "AGENTS.md": shared, "CLAUDE.md": shared });
		try {
			const plan = buildPlan(detect(root), { toolVersion: "test" });
			const task = plan.tasks.find((item) => item.id === "dedupe-claude");
			expect(task).toBeDefined();
			expect(task?.detail).toMatch(/duplicates/);
		} finally {
			remove(root);
		}
	});

	it("adds the deep pass only when asked", () => {
		const root = project(LEGACY);
		try {
			const shallow = buildPlan(detect(root), { toolVersion: "test" });
			const deep = buildPlan(detect(root), { toolVersion: "test", deep: true });
			const shallowEdit = shallow.tasks.find((task) => task.id === "edit-agents")?.detail ?? "";
			const deepEdit = deep.tasks.find((task) => task.id === "edit-agents")?.detail ?? "";
			expect(shallowEdit).not.toMatch(/Deep pass/);
			expect(deepEdit).toMatch(/Deep pass/);
		} finally {
			remove(root);
		}
	});
});


describe("review regressions", () => {
	it("moves a canonical memory PLAN.md when specs has no plan", () => {
		const root = installedProject({
			".agents/memory/PLAN.md": "# Plan\n\n## Route\n\n- open\n",
		});
		try {
			remove(join(root, "specs/PLAN.md"));
			const plan = buildPlan(detect(root), { toolVersion: "test" });
			const move = plan.actions.find((action) => action.kind === "move-file");
			expect(move && move.kind === "move-file" ? move.from : "").toBe(
				".agents/memory/PLAN.md",
			);
			expect(plan.tasks.some((task) => task.id === "edit-plan")).toBe(true);
		} finally {
			remove(root);
		}
	});

	it("does not ask to rewrite paths that are already canonical", () => {
		const root = project({
			"AGENTS.md": [
				"# demo",
				"",
				"> Memory contract (agent-framework v1).",
				"",
				"## Plan and memory index",
				"",
				"`specs/PLAN.md` `.agents/memory/` `.agents/implementations/`",
				"",
			].join("\n"),
		});
		try {
			const plan = buildPlan(detect(root), { toolVersion: "test" });
			const edit = plan.tasks.find((task) => task.id === "edit-agents");
			expect(edit?.detail ?? "").not.toMatch(/Update every path/);
		} finally {
			remove(root);
		}
	});
});


it("assigns a destination to non-plan legacy documents", () => {
	const root = project({
		"AGENTS.md": "# demo\n",
		"TODO.md": "# TODO\n\n- open item\n",
		"docs/adr/0001-storage.md": "# Storage decision\n",
	});
	try {
		const plan = buildPlan(detect(root), { toolVersion: "test" });
		const task = plan.tasks.find((item) => item.id === "merge-legacy-docs");
		expect(task).toBeDefined();
		expect(task?.detail).toContain("TODO.md");
		expect(task?.detail).toContain("docs/adr/0001-storage.md");
		expect(task?.targets).toContain("TODO.md");
	} finally {
		remove(root);
	}
});
