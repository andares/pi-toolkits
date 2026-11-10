import { describe, expect, it } from "vitest";
import { parseBlocks } from "./blocks.js";
import { diffBlocks } from "./diff.js";
import { buildFeedbackMarkdown } from "./feedback.js";

const parse = (markdown: string) => parseBlocks(markdown);

describe("buildFeedbackMarkdown", () => {
	it("writes a denial with global and block annotations", () => {
		const blocks = parse("## Milestones\n\n1. blocks\n\n## Risks");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 2,
			totalVersions: 5,
			blocks,
			diff: diffBlocks(parse("## Milestones\n\n1. blocks\n\n## Risks"), blocks),
			global: [{ verdict: "change", comment: "Keep the permission toggle out of the plan flow." }],
			perBlock: [
				{
					blockId: blocks[1]!.id,
					annotations: [{ verdict: "question", comment: "What stops a third round here?" }],
				},
			],
		});
		expect(text).toContain("## Plan feedback — v2 of 5 (no block changes)");
		expect(text).toContain("### Global");
		expect(text).toContain("- [change] Keep the permission toggle out of the plan flow.");
		expect(text).toContain("### Block: 1. blocks (unchanged)");
		expect(text).toContain("- [question] What stops a third round here?");
		expect(text).toContain(
			"Update the plan file to address every annotation above, then submit it again with plan_submit.",
		);
	});

	it("marks the changed count and quotes the previous first line for a modified block", () => {
		const before = parse("## Milestones\n\n1. blocks and server");
		const after = parse("## Milestones\n\n1. blocks, then the server");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 3,
			totalVersions: 5,
			blocks: after,
			diff: diffBlocks(before, after),
			previousBlocks: before,
			global: [],
			perBlock: [
				{
					blockId: after[1]!.id,
					annotations: [{ verdict: "change", comment: "Split it in two." }],
				},
			],
		});
		expect(text).toContain("## Plan feedback — v3 of 5 (1 block changed)");
		expect(text).toContain("### Block: 1. blocks, then the server (modified)");
		expect(text).toContain("> Previous first line: 1. blocks and server");
		expect(text).toContain("- [change] Split it in two.");
	});

	it("keeps an approval short when there is nothing to say", () => {
		const blocks = parse("## Plan");
		const text = buildFeedbackMarkdown({
			decision: "approve",
			version: 3,
			totalVersions: 3,
			blocks,
			diff: diffBlocks(blocks, blocks),
			global: [],
			perBlock: [],
		});
		expect(text).toBe(
			[
				"## Plan approved — v3 of 3 (no block changes)",
				"",
				"No notes were attached.",
				"",
				"The plan is approved. Start implementing it now.",
			].join("\n"),
		);
	});

	it("keeps notes attached to an approval", () => {
		const blocks = parse("## Plan");
		const text = buildFeedbackMarkdown({
			decision: "approve",
			version: 1,
			totalVersions: 1,
			blocks,
			diff: diffBlocks([], blocks),
			global: [{ verdict: "suggest", comment: "Commit per milestone." }],
			perBlock: [],
		});
		expect(text).toContain("## Plan approved — v1 of 1 (1 block changed)");
		expect(text).toContain("- [suggest] Commit per milestone.");
		expect(text).toContain("The plan is approved. Start implementing it now.");
	});

	it("asks what should change when a denial carries no annotations", () => {
		const blocks = parse("## Plan");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 1,
			totalVersions: 2,
			blocks,
			diff: diffBlocks([], blocks),
			global: [],
			perBlock: [],
		});
		expect(text).toContain(
			"No specific annotations were left — ask what should change before resubmitting.",
		);
	});

	it("drops empty comments and annotations pointing at unknown blocks", () => {
		const blocks = parse("## Plan");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 1,
			totalVersions: 1,
			blocks,
			diff: diffBlocks([], blocks),
			global: [{ verdict: "change", comment: "   " }],
			perBlock: [
				{ blockId: "deadbeef0000#0", annotations: [{ verdict: "change", comment: "ghost" }] },
			],
		});
		expect(text).not.toContain("### Global");
		expect(text).not.toContain("ghost");
		expect(text).toContain(
			"No specific annotations were left — ask what should change before resubmitting.",
		);
	});

	it("collapses multi-line comments onto one line", () => {
		const blocks = parse("## Plan");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 1,
			totalVersions: 1,
			blocks,
			diff: diffBlocks([], blocks),
			global: [{ verdict: "change", comment: "first line\nsecond line" }],
			perBlock: [],
		});
		expect(text).toContain("- [change] first line second line");
	});
});
