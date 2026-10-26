import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, rewriteText, stateToToml } from "./apply.js";
import { parseState } from "./detect.js";
import { detect } from "./detect.js";
import { buildPlan } from "./plan.js";
import { installedProject, project, remove } from "./test-helpers.js";
import type { Plan } from "./types.js";

const ORIGINAL_PLAN = "# 计划\n\n## 路线\n\n- M1 未完成\n";
const LEGACY: Record<string, string> = {
	"AGENTS.md": [
		"# demo — 项目指南",
		"",
		"细节记忆放在 `memory/`。",
		"",
		"## 8. 问题清单",
		"",
		"已迁至 `memory/PLAN.md` §5。",
		"",
	].join("\n"),
	"memory/PLAN.md": ORIGINAL_PLAN,
	"memory/FINISHED.md": "# 已完成\n\n## 摘要\n\n- M0：见 `implementations/2026-01-01_a.md`\n",
	"memory/ARCHITECTURE.md": "# 架构\n\n## 分层\n\n- 见 `memory/DESIGN.md`\n",
	"memory/DESIGN.md": "# 视觉\n",
	"implementations/2026-01-01_a.md": "# a\n\n见 `memory/ARCHITECTURE.md`。\n",
	"specs/a.md": "# a\n\n证据：`implementations/2026-01-01_a.md`。\n",
	"todos/2026-01-02-x.md": "# 原始需求\n\n做点事。\n",
	"src/a.ts": "// 见 `memory/DESIGN.md`\n",
};

function planFor(root: string): Plan {
	return buildPlan(detect(root), {
		toolVersion: "test",
		now: new Date("2026-10-26T10:00:00+08:00"),
	});
}

describe("rewriteText", () => {
	const pairs = [
		{ from: "memory/PLAN.md", to: "specs/PLAN.md" },
		{ from: "memory/", to: ".agents/memory/" },
	];

	it("applies the longest prefix first", () => {
		const result = rewriteText("see `memory/PLAN.md` and `memory/X.md`", pairs);
		expect(result.text).toBe("see `specs/PLAN.md` and `.agents/memory/X.md`");
		expect(result.hits).toBe(2);
	});

	it("leaves already-migrated paths and path tails alone", () => {
		const result = rewriteText("`.agents/memory/X.md` ~/.pi/agent/memory/y", pairs);
		expect(result.text).toBe("`.agents/memory/X.md` ~/.pi/agent/memory/y");
		expect(result.hits).toBe(0);
	});
});

describe("applyPlan", () => {
	it("moves the legacy layout, rewrites references and keeps the originals", () => {
		const root = project(LEGACY);
		try {
			const plan = planFor(root);
			const expectedHits = plan.facts.refs.hits;
			const applied = applyPlan(plan, { now: new Date("2026-10-26T10:00:00+08:00") });

			expect(existsSync(join(root, "memory"))).toBe(false);
			expect(existsSync(join(root, "implementations"))).toBe(false);
			expect(existsSync(join(root, ".agents/memory/FINISHED.md"))).toBe(true);
			expect(existsSync(join(root, ".agents/implementations/2026-01-01_a.md"))).toBe(true);

			// The plan file moves byte-identically; the model shapes it afterwards.
			expect(readFileSync(join(root, "specs/PLAN.md"), "utf8")).toBe(ORIGINAL_PLAN);

			// References are rewritten in prose and code alike.
			expect(readFileSync(join(root, "src/a.ts"), "utf8")).toContain(".agents/memory/DESIGN.md");
			expect(readFileSync(join(root, "specs/a.md"), "utf8")).toContain(
				".agents/implementations/2026-01-01_a.md",
			);
			const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
			expect(agents).toContain(".agents/memory/");
			expect(agents).toContain("specs/PLAN.md");

			// Snapshot keeps the pre-move bytes (and therefore the old paths).
			expect(applied.snapshot?.dir).toMatch(/^\.agents\/framework\/snapshots\//);
			const snapshotFile = join(root, applied.snapshot?.dir ?? "", "files/src/a.ts");
			expect(readFileSync(snapshotFile, "utf8")).toContain("memory/DESIGN.md");
			expect(existsSync(join(root, applied.snapshot?.dir ?? "", "manifest.json"))).toBe(true);

			// Counts reconcile with the survey.
			expect(applied.rewrites?.hits).toBe(expectedHits);

			// State, work order and coverage worklist exist and are readable.
			expect(applied.statePath).toBe(".agents/framework/state.toml");
			const state = parseState(readFileSync(join(root, ".agents/framework/state.toml"), "utf8"));
			expect(state.version).toBe(1);
			expect(state.migrations.length).toBeGreaterThan(0);
			expect(state.lang).toBe("zh");
			expect(applied.planPath).toMatch(/^\.agents\/framework\/plans\/plan-.*\.json$/);
			const order = JSON.parse(readFileSync(join(root, applied.planPath ?? ""), "utf8")) as {
				tasks: Array<{ id: string }>;
			};
			expect(order.tasks.map((task) => task.id)).toContain("triage-todos");
			expect(applied.created).toContain(".agents/memory/README.md");

			expect(plan.artifacts.coverage).toMatch(/^\.agents\/framework\/reports\/coverage-.*\.md$/);
			const coverage = readFileSync(join(root, plan.artifacts.coverage ?? ""), "utf8");
			expect(coverage).toContain("OPEN");
			expect(coverage).toContain("AGENTS.md");
		} finally {
			remove(root);
		}
	});

	it("is safe to run twice", () => {
		const root = project(LEGACY);
		try {
			const plan = planFor(root);
			applyPlan(plan, { now: new Date("2026-10-26T10:00:00+08:00") });
			const second = applyPlan(plan, { now: new Date("2026-10-26T10:05:00+08:00") });
			expect(second.moved).toHaveLength(0);
			expect(second.rewrites?.hits).toBe(0);
			expect(second.skipped.length).toBeGreaterThan(0);
			expect(existsSync(join(root, ".agents/memory/FINISHED.md"))).toBe(true);
			expect(existsSync(join(root, "memory"))).toBe(false);
		} finally {
			remove(root);
		}
	});

	it("writes nothing on a dry run", () => {
		const root = project(LEGACY);
		try {
			const plan = planFor(root);
			applyPlan(plan, {
				dryRun: true,
				now: new Date("2026-10-26T10:00:00+08:00"),
			});
			expect(existsSync(join(root, "memory"))).toBe(true);
			expect(existsSync(join(root, ".agents"))).toBe(false);
		} finally {
			remove(root);
		}
	});

	it("does not merge two copies of a directory on its own", () => {
		const root = installedProject({
			"memory/FINISHED.md": "# old finished\n",
		});
		try {
			const plan = planFor(root);
			expect(plan.mode).toBe("reconcile");
			applyPlan(plan, { now: new Date("2026-10-26T10:00:00+08:00") });
			expect(existsSync(join(root, "memory/FINISHED.md"))).toBe(true);
			expect(readFileSync(join(root, ".agents/memory/FINISHED.md"), "utf8")).toContain("Summary");
		} finally {
			remove(root);
		}
	});

	it("round-trips state through TOML", () => {
		const root = installedProject();
		try {
			const plan = planFor(root);
			const state = {
				version: 1,
				tool: "9.9.9",
				created: "2026-01-01T00:00:00+08:00",
				updated: "2026-01-02T00:00:00+08:00",
				profile: "core" as const,
				modules: ["design"],
				lang: "zh" as const,
				roots: [
					{
						label: "api",
						path: "../api",
						absolute: "/tmp/api",
						role: "backend",
						agentsMd: "scope-card" as const,
						source: "add-dir" as const,
						exists: true,
						lastSeen: "2026-01-02T00:00:00+08:00",
					},
				],
				managed: [],
				migrations: [{ at: "2026-01-02T00:00:00+08:00", to: "1", notes: "adopt" }],
			};
			const parsed = parseState(stateToToml(state));
			expect(parsed.roots[0]).toMatchObject({ label: "api", agentsMd: "scope-card" });
			expect(parsed.migrations[0].notes).toBe("adopt");
			expect(parsed.budgets).toBeUndefined();
			void plan;
		} finally {
			remove(root);
		}
	});
});


describe("review regressions", () => {
	it("preserves relative prefixes while rewriting", () => {
		const result = rewriteText("see `../memory/A.md` and `./implementations/B.md`", [
			{ from: "memory/", to: ".agents/memory/" },
			{ from: "implementations/", to: ".agents/implementations/" },
		]);
		expect(result.text).toBe(
			"see `../.agents/memory/A.md` and `./.agents/implementations/B.md`",
		);
		expect(result.hits).toBe(2);
	});

	it("records managed hashes after the reference rewrite", () => {
		const root = project(LEGACY);
		try {
			applyPlan(planFor(root), { now: new Date("2026-10-26T10:00:00+08:00") });
			const state = parseState(readFileSync(join(root, ".agents/framework/state.toml"), "utf8"));
			for (const entry of state.managed) {
				const digest = createHash("sha256")
					.update(readFileSync(join(root, entry.path)))
					.digest("hex");
				expect(entry.sha256, entry.path).toBe(digest);
			}
		} finally {
			remove(root);
		}
	});

	it("moves a root-level PLAN.md into the plan home", () => {
		const root = project({
			"AGENTS.md": "# demo\n\nSee `PLAN.md`.\n",
			"PLAN.md": "# Plan\n\n## Route\n\n- open item\n",
		});
		try {
			const plan = planFor(root);
			const move = plan.actions.find((action) => action.kind === "move-file");
			expect(move && move.kind === "move-file" ? move.from : "").toBe("PLAN.md");
			expect(plan.tasks.some((task) => task.id === "edit-plan")).toBe(true);
			const applied = applyPlan(plan, { now: new Date("2026-10-26T10:00:00+08:00") });
			expect(existsSync(join(root, "PLAN.md"))).toBe(false);
			expect(readFileSync(join(root, "specs/PLAN.md"), "utf8")).toContain("open item");
			// The moved source must be recoverable, not just the destination.
			expect(
				existsSync(join(root, applied.snapshot?.dir ?? "", "files/PLAN.md")),
			).toBe(true);
		} finally {
			remove(root);
		}
	});
});


it("does not corrupt non-UTF-8 files during reference rewriting", () => {
	const root = project(LEGACY);
	try {
		const latin = Buffer.from("// see `memory/DESIGN.md` — caf\xe9\n", "latin1");
		writeFileSync(join(root, "src/latin1.ts"), latin);
		applyPlan(planFor(root), { now: new Date("2026-10-26T10:00:00+08:00") });
		expect(readFileSync(join(root, "src/latin1.ts"))).toEqual(latin);
		expect(readFileSync(join(root, "src/a.ts"), "utf8")).toContain(".agents/memory/DESIGN.md");
	} finally {
		remove(root);
	}
});
