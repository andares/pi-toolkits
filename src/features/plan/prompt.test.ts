import { describe, expect, it } from "vitest";
import { buildPlanKickoff, buildPlanSystemPrompt, PLAN_MODE_BANNER, SPEC_FRAMEWORK_GUIDE } from "./prompt.js";

describe("plan mode prompt", () => {
	it("states what the phase allows and how a turn may end", () => {
		expect(PLAN_MODE_BANNER).toContain("[ASK-PLAN — PLANNING]");
		expect(PLAN_MODE_BANNER).toContain("writing/editing\nmarkdown files");
		expect(PLAN_MODE_BANNER).toContain("Not allowed: editing other files");
		expect(PLAN_MODE_BANNER).toContain("plan_submit");
		expect(PLAN_MODE_BANNER).toContain("End every turn with either a question or a plan_submit call");
	});

	it("gives the spec framework in reading order", () => {
		const order = [
			"# SPEC: <name>",
			"## Context",
			"## Goal",
			"## Scope",
			"## Decisions",
			"## Approach",
			"## Data & contracts",
			"## Files",
			"## Milestones",
			"## Verification",
			"## Risks",
			"## Open questions",
		];
		let cursor = -1;
		for (const heading of order) {
			const index = SPEC_FRAMEWORK_GUIDE.indexOf(heading);
			expect(index, `${heading} missing`).toBeGreaterThan(-1);
			expect(index, `${heading} out of order`).toBeGreaterThan(cursor);
			cursor = index;
		}
	});

	it("explains paragraph-level review — the part that makes block annotations usable", () => {
		expect(SPEC_FRAMEWORK_GUIDE).toContain("The operator annotates **blocks**");
		expect(SPEC_FRAMEWORK_GUIDE).toContain("one idea per paragraph");
		expect(SPEC_FRAMEWORK_GUIDE).toContain("no blank lines between items");
		expect(SPEC_FRAMEWORK_GUIDE).toContain("fenced code blocks stay whole");
	});

	it("tells the model that notes arrive on approval too, and that a full rewrite ruins the diff", () => {
		expect(SPEC_FRAMEWORK_GUIDE).toContain("Annotations arrive whatever the decision");
		expect(SPEC_FRAMEWORK_GUIDE).toContain("change only the blocks that were annotated");
		expect(SPEC_FRAMEWORK_GUIDE).toContain("every block turns red");
	});

	it("combines banner and guide without dropping either", () => {
		const prompt = buildPlanSystemPrompt();
		expect(prompt).toContain(PLAN_MODE_BANNER);
		expect(prompt).toContain(SPEC_FRAMEWORK_GUIDE);
	});
});

describe("buildPlanKickoff", () => {
	it("names the task when one was given", () => {
		const kickoff = buildPlanKickoff("build /ask-plan");
		expect(kickoff).toContain("Task: build /ask-plan");
		expect(kickoff).toContain("plan_submit");
	});

	it("falls back to the session discussion", () => {
		expect(buildPlanKickoff(undefined)).toContain("the work we have been discussing in this session");
		expect(buildPlanKickoff("   ")).toContain("the work we have been discussing in this session");
	});
});
