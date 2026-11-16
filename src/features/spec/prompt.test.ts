import { describe, expect, it } from "vitest";
import {
	buildSpecKickoff,
	buildSpecSystemPrompt,
	INTERVIEW_GUIDE,
	SPEC_MODE_BANNER,
	SPEC_FRAMEWORK_GUIDE,
} from "./prompt.js";

describe("spec review prompt", () => {
	it("states what the phase allows and how a turn may end", () => {
		expect(SPEC_MODE_BANNER).toContain("[ASK-SPEC — SPEC REVIEW]");
		expect(SPEC_MODE_BANNER).toContain("writing/editing\nmarkdown files");
		expect(SPEC_MODE_BANNER).toContain("Not allowed: editing other files");
		expect(SPEC_MODE_BANNER).toContain("spec_submit");
		expect(SPEC_MODE_BANNER).toContain("End every turn with either a question or a spec_submit call");
	});

	it("asks in rounds instead of guessing, and never names a tool the session lacks", () => {
		expect(INTERVIEW_GUIDE).toContain("in rounds");
		expect(INTERVIEW_GUIDE).toContain("Do not ask what you can read");
		expect(buildSpecSystemPrompt({ questionTool: false })).toContain("ask in plain text");
		expect(buildSpecSystemPrompt({ questionTool: true })).toContain("`ask_user_question` is available");
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
		const prompt = buildSpecSystemPrompt();
		expect(prompt).toContain(SPEC_MODE_BANNER);
		expect(prompt).toContain(SPEC_FRAMEWORK_GUIDE);
	});

	it("never tells the model which language to write in", () => {
		// Framework prompts are authored in English, which is our choice of
		// language for the prompt — not an instruction about the spec. The spec
		// follows the operator's own language, so any directive would be a bug.
		const prompt = buildSpecSystemPrompt().toLowerCase();
		for (const banned of ["in english", "in chinese", "language", "write in"]) {
			expect(prompt, `prompt must not mention "${banned}"`).not.toContain(banned);
		}
	});
});

describe("buildSpecKickoff", () => {
	it("names the task when one was given", () => {
		const kickoff = buildSpecKickoff("build /ask-spec");
		expect(kickoff).toContain("Task: build /ask-spec");
		expect(kickoff).toContain("spec_submit");
	});

	it("falls back to the session discussion", () => {
		expect(buildSpecKickoff(undefined)).toContain("the work we have been discussing in this session");
		expect(buildSpecKickoff("   ")).toContain("the work we have been discussing in this session");
	});
});
