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
		expect(text).toContain("### Global notes (apply to the whole plan)");
		expect(text).toContain("- [change] Keep the permission toggle out of the plan flow.");
		expect(text).toContain("### Block notes (apply to the quoted block only)");
		expect(text).toContain("#### line 3 · 1. blocks (unchanged)");
		expect(text).toContain("> 1. blocks");
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
		expect(text).toContain("#### line 3 · 1. blocks, then the server (modified)");
		expect(text).toContain("> 1. blocks, then the server");
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
				"The plan is approved: start implementing it now.",
				'Approval only means "go" — every annotation above still applies while you build.',
				"Record the implementation work in the todo list (`todo` tool) as you go, and update each entry",
				"as it starts, finishes or gets blocked, so progress stays traceable.",
			].join("\n"),
		);
	});

	it("quotes the approved revision and asks for todo tracking on approval", () => {
		const blocks = parse("## Plan\n\nstep one");
		const text = buildFeedbackMarkdown({
			decision: "approve",
			version: 2,
			totalVersions: 2,
			blocks,
			diff: diffBlocks(blocks, blocks),
			global: [{ verdict: "suggest", comment: "Keep commits small." }],
			perBlock: [],
			planPath: "specs/demo.md",
			planText: "## Plan\n\nstep one\n",
		});
		expect(text).toContain("### Approved plan (specs/demo.md)");
		expect(text).toContain("## Plan\n\nstep one");
		expect(text).toContain("Record the implementation work in the todo list");
		expect(text).toContain("- [suggest] Keep commits small.");
	});

	it("does not quote a plan back on denial", () => {
		const blocks = parse("## Plan");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 1,
			totalVersions: 1,
			blocks,
			diff: diffBlocks([], blocks),
			global: [],
			perBlock: [],
			planPath: "specs/demo.md",
			planText: "## Plan",
		});
		expect(text).not.toContain("### Approved plan");
		expect(text).not.toContain("todo list");
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
		expect(text).toContain("Approval only means");
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
		expect(text).not.toContain("### Global notes");
		expect(text).not.toContain("ghost");
		expect(text).toContain(
			"No specific annotations were left — ask what should change before resubmitting.",
		);
	});

	it("keeps annotations on removed blocks", () => {
		const before = parse("## Plan\n\nremove this step");
		const after = parse("## Plan");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 2,
			totalVersions: 2,
			blocks: after,
			diff: diffBlocks(before, after),
			previousBlocks: before,
			global: [],
			perBlock: [
				{
					blockId: before[1].id,
					annotations: [{ verdict: "question", comment: "Why was this dropped?" }],
				},
			],
		});
		expect(text).toContain("#### was in the previous revision · remove this step (removed)");
		expect(text).toContain("> remove this step");
		expect(text).toContain("- [question] Why was this dropped?");
	});

	it("resolves an annotation keyed by the previous block id instead of dropping it", () => {
		const before = parse("## Plan\n\nwrite the parser first");
		const after = parse("## Plan\n\nwrite the block parser first");
		const text = buildFeedbackMarkdown({
			decision: "deny",
			version: 2,
			totalVersions: 2,
			blocks: after,
			diff: diffBlocks(before, after),
			previousBlocks: before,
			global: [],
			perBlock: [
				{
					// a tab that has not refreshed still refers to the old block
					blockId: before[1].id,
					annotations: [{ verdict: "change", comment: "still relevant" }],
				},
			],
		});
		expect(text).toContain("still relevant");
		expect(text).toContain("(modified)");
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
