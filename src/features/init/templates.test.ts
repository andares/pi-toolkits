import { describe, expect, it } from "vitest";
import { countBareRefs } from "./detect.js";
import { renderTemplate, templateNames } from "./templates.js";

const TOKENS: Record<string, string> = {
	project: "demo",
	date: "2026-10-26",
	contract: "> Memory contract (agent-framework v1).",
	docTitle: "project guide (AGENTS.md)",
	softBudget: "12000",
	hardBudget: "20000",
	memoryBudget: "80000",
	implementationsBudget: "200",
	index: "| File | Owns | Read when |\n| --- | --- | --- |\n| `specs/PLAN.md` | route | before work |",
	roots: "",
	frameworkVersion: "1",
	statePath: ".agents/framework/state.toml",
	contractPath: ".agents/memory/README.md",
	implementationsDir: ".agents/implementations",
	h_what: "What this is",
	h_rules: "Hard rules",
	h_commands: "Commands",
	h_layout: "Layout",
	h_index: "Plan and memory index",
	h_impact: "Change impact index",
	h_roots: "Workspace roots",
	h_terms: "Terms",
	h_maintenance: "Framework maintenance",
};

describe("templates", () => {
	it("renders every shipped template without leaving placeholders", () => {
		for (const name of templateNames()) {
			const text = renderTemplate(name, TOKENS, "en");
			expect(text, name).not.toMatch(/\{\{/);
			expect(text.length, name).toBeGreaterThan(20);
		}
	});

	it("renders the localized seeds", () => {
		expect(renderTemplate("seed-finished", TOKENS, "zh")).toContain("# 已完成");
		expect(renderTemplate("plan", TOKENS, "zh")).toContain("# 计划");
		expect(renderTemplate("seed-architecture", TOKENS, "en")).toContain("# Architecture");
	});

	it("keeps the shipped contract free of legacy path references", () => {
		for (const name of ["memory-readme", "signpost", "agents-skeleton"]) {
			const text = renderTemplate(name, TOKENS, "en");
			expect(countBareRefs(text, "memory/"), name).toBe(0);
			expect(countBareRefs(text, "implementations/"), name).toBe(0);
		}
	});

	it("fails loudly instead of writing an unresolved placeholder", () => {
		expect(() => renderTemplate("agents-skeleton", {}, "en")).toThrow(/no value for/);
		expect(() => renderTemplate("nope", TOKENS, "en")).toThrow(/unknown template/);
	});
});
