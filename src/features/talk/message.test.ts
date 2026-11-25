import { describe, expect, it } from "vitest";
import { parseBlocks } from "../review-page/blocks.js";
import { buildReplyMessage, clipForQuote, hasUnknownNote, QUOTE_LIMIT } from "./message.js";

const REPLY = [
	"## Approach",
	"",
	"The page reads the blocks the server ships, never the rendered HTML.",
	"",
	"## Milestones",
	"",
	"M1 captures the reply, M2 renders the page.",
].join("\n");

function build(notes: Array<{ blockId: string; text: string }>, message: string) {
	const blocks = parseBlocks(REPLY);
	const resolved = notes.map((note) => ({
		blockId: note.blockId === "approach" ? blocks[1].id : note.blockId,
		text: note.text,
	}));
	return {
		text: buildReplyMessage({
			blocks,
			notes: resolved,
			message,
			inContext: true,
			replyText: REPLY,
		}),
		blocks,
	};
}

describe("buildReplyMessage", () => {
	it("writes the two parts in a fixed shape", () => {
		const { text } = build(
			[
				{
					blockId: "approach",
					text: "this reverses the order: ship the headings first",
				},
			],
			"also keep it short",
		);
		expect(text).toBe(
			[
				"## Notes on your last reply",
				"",
				"Address every note below; each one is attached to the part of your reply it quotes.",
				"",
				"### Approach",
				"> The page reads the blocks the server ships, never the rendered HTML.",
				"",
				"- this reverses the order: ship the headings first",
				"",
				"## Operator's message",
				"",
				"also keep it short",
			].join("\n"),
		);
	});

	it("sends bare composer text when there are no notes", () => {
		const { text } = build([], "just this sentence");
		expect(text).toBe("just this sentence");
	});

	it("sends only the notes when the composer is empty", () => {
		const { text } = build([{ blockId: "approach", text: "wrong" }], "");
		expect(text.startsWith("## Notes on your last reply")).toBe(true);
		expect(text).not.toContain("## Operator's message");
		expect(text.endsWith("- wrong")).toBe(true);
	});

	it("quotes a heading without its markers", () => {
		const blocks = parseBlocks(REPLY);
		const text = buildReplyMessage({
			blocks,
			notes: [{ blockId: blocks[0].id, text: "rename" }],
			message: "",
			inContext: true,
			replyText: REPLY,
		});
		expect(text).toContain("### Approach");
		expect(text).toContain("> Approach\n");
		expect(text).not.toContain("> ## Approach");
	});

	it("uses the section path as the note heading", () => {
		const blocks = parseBlocks(REPLY);
		const { text } = build([{ blockId: blocks[3].id, text: "order is wrong" }], "");
		expect(text).toContain("### Milestones");
	});

	it("labels notes above the first heading with the block label", () => {
		const blocks = parseBlocks("preamble paragraph\n\n## Section\n\nbody");
		const text = buildReplyMessage({
			blocks,
			notes: [{ blockId: blocks[0].id, text: "reword" }],
			message: "",
			inContext: true,
			replyText: "",
		});
		expect(text).toContain("### preamble paragraph");
	});

	it("keeps document order, not the order the notes were written", () => {
		const blocks = parseBlocks(REPLY);
		const text = buildReplyMessage({
			blocks,
			notes: [
				{ blockId: blocks[3].id, text: "second note" },
				{ blockId: blocks[1].id, text: "first note" },
			],
			message: "",
			inContext: true,
			replyText: REPLY,
		});
		expect(text.indexOf("first note")).toBeLessThan(text.indexOf("second note"));
	});

	it("keeps multi-line notes inside one bullet", () => {
		const blocks = parseBlocks(REPLY);
		const text = buildReplyMessage({
			blocks,
			notes: [{ blockId: blocks[1].id, text: "1. no\n2. yes" }],
			message: "",
			inContext: true,
			replyText: REPLY,
		});
		expect(text).toContain("- 1. no\n  2. yes");
	});

	it("repeats the reply only when compaction pushed it out of context", () => {
		const blocks = parseBlocks(REPLY);
		const text = buildReplyMessage({
			blocks,
			notes: [{ blockId: blocks[1].id, text: "fix it" }],
			message: "",
			inContext: false,
			replyText: REPLY,
		});
		expect(text).toContain("## Your last reply (full text)");
		expect(text).toContain("M1 captures the reply");
	});

	it("drops blank notes instead of emitting an empty bullet", () => {
		const blocks = parseBlocks(REPLY);
		const text = buildReplyMessage({
			blocks,
			notes: [{ blockId: blocks[1].id, text: "   " }],
			message: "hello",
			inContext: true,
			replyText: REPLY,
		});
		expect(text).toBe("hello");
	});
});

describe("clipForQuote", () => {
	it("keeps short blocks intact", () => {
		expect(clipForQuote("short block")).toBe("short block");
	});

	it("clips at a line boundary and marks the cut", () => {
		const long = Array.from({ length: 40 }, (_, i) => `line ${i} of a long block`).join("\n");
		const clipped = clipForQuote(long, 120);
		expect(clipped.length).toBeLessThanOrEqual(140);
		expect(clipped.endsWith("…")).toBe(true);
		expect(clipped.split("\n").slice(0, -2).every((line) => /^line \d+ of a long block$/.test(line))).toBe(
			true,
		);
	});

	it("closes a fence it cut through", () => {
		const long = ["```ts", ...Array.from({ length: 60 }, (_, i) => `const x${i} = ${i};`), "```"].join(
			"\n",
		);
		const clipped = clipForQuote(long, 120);
		expect(clipped.split("```").length % 2).toBe(1);
		expect(clipped.trimEnd().endsWith("```")).toBe(true);
	});

	it("falls back to a hard slice when the first line alone exceeds the limit", () => {
		const clipped = clipForQuote("x".repeat(QUOTE_LIMIT * 2), 50);
		expect(clipped.length).toBe(50);
		expect(clipped.endsWith("…")).toBe(true);
	});
});

describe("hasUnknownNote", () => {
	it("flags notes for blocks the reply does not contain", () => {
		const blocks = parseBlocks(REPLY);
		expect(
			hasUnknownNote({
				blocks,
				notes: [{ blockId: "gone#0", text: "stale" }],
				message: "",
				inContext: true,
				replyText: "",
			}),
		).toBe(true);
		expect(
			hasUnknownNote({
				blocks,
				notes: [{ blockId: blocks[0].id, text: "fine" }],
				message: "",
				inContext: true,
				replyText: "",
			}),
		).toBe(false);
	});
});
