import { describe, expect, it } from "vitest";
import { buildWorkOrder, serializeWorkOrder } from "./dispatch.js";
import { buildPlan } from "./plan.js";
import { detect } from "./detect.js";
import { project } from "./test-helpers.js";

const NOW = new Date("2026-10-26T10:00:00Z");

function planFor(files: Record<string, string>) {
	return buildPlan(detect(project(files)), { toolVersion: "test", now: NOW });
}

describe("buildWorkOrder", () => {
	it("contains no language directive at all", () => {
		const order = buildWorkOrder({ plan: planFor({ "README.md": "# demo\n" }) });
		// The work order must not tell the model which language to write or reply in —
		// it works that out from the project's own docs. Rendering language for the
		// framework's own files is computed in code and never appears here.
		expect(order).not.toMatch(/prose language/i);
		expect(order).not.toMatch(/\blanguage\b/i);
		expect(order).not.toMatch(/\b(English|Chinese)\b/);
		expect(order).toContain("Repository:");
		expect(order).toContain("Plan (machine-readable):");
	});

	it("keeps the project language out of the survey task detail", () => {
		const plan = planFor({ "README.md": "# 演示\n\n本项目只做演示，说明保持中文。\n" });
		expect(plan.language).toBe("zh");
		const order = buildWorkOrder({ plan });
		expect(order).not.toMatch(/\blanguage\b/i);
		const survey = plan.tasks.find((task) => task.id === "survey");
		expect(survey?.detail).not.toMatch(/\blanguage\b/i);
	});

	it("persists no language field in the serialized work order", () => {
		const plan = planFor({ "README.md": "# demo\n" });
		const raw = serializeWorkOrder(plan);
		expect(raw).not.toMatch(/\blanguage\b/i);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect("language" in parsed).toBe(false);
	});
});
