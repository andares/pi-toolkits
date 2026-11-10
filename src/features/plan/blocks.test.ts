import { describe, expect, it } from "vitest";
import { blockLabel, hashBlockText, normalizeBlockText, parseBlocks } from "./blocks.js";

describe("parseBlocks", () => {
	it("splits paragraphs on blank lines", () => {
		const blocks = parseBlocks("first para\n\nsecond para\n\nthird");
		expect(blocks.map((block) => block.text)).toEqual(["first para", "second para", "third"]);
		expect(blocks.map((block) => block.index)).toEqual([0, 1, 2]);
	});

	it("keeps a fenced code block whole even with blank lines inside", () => {
		const markdown = ["intro", "", "```ts", "const a = 1;", "", "const b = 2;", "```", "", "tail"].join("\n");
		const blocks = parseBlocks(markdown);
		expect(blocks).toHaveLength(3);
		expect(blocks[1]?.kind).toBe("code");
		expect(blocks[1]?.text).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n```");
	});

	it("closes a fence only on a run as long as the opener", () => {
		const markdown = ["~~~~", "```", "still code", "```", "~~~", "still code", "~~~~"].join("\n");
		const blocks = parseBlocks(markdown);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.kind).toBe("code");
	});

	it("treats a heading line as its own block", () => {
		const blocks = parseBlocks("## Title\n\ntext");
		expect(blocks[0]?.kind).toBe("heading");
		expect(blocks[1]?.kind).toBe("text");
	});

	it("classifies lists, quotes and tables", () => {
		const blocks = parseBlocks("- one\n- two\n\n> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
		expect(blocks.map((block) => block.kind)).toEqual(["list", "quote", "table"]);
	});

	it("gives duplicate paragraphs distinct ids", () => {
		const blocks = parseBlocks("same\n\nsame");
		expect(blocks[0]?.hash).toBe(blocks[1]?.hash);
		expect(blocks[0]?.id).not.toBe(blocks[1]?.id);
		expect(blocks[0]?.id.endsWith("#0")).toBe(true);
		expect(blocks[1]?.id.endsWith("#1")).toBe(true);
	});

	it("reports 1-based start lines", () => {
		const blocks = parseBlocks("a\n\nb\n\n\nc");
		expect(blocks.map((block) => block.line)).toEqual([1, 3, 6]);
	});

	it("normalizes CRLF", () => {
		const blocks = parseBlocks("a\r\n\r\nb\r\n");
		expect(blocks.map((block) => block.text)).toEqual(["a", "b"]);
	});

	it("returns nothing for an empty or blank-only document", () => {
		expect(parseBlocks("")).toEqual([]);
		expect(parseBlocks("\n\n   \n\n")).toEqual([]);
	});
});

describe("block identity", () => {
	it("ignores reflow and indentation when hashing", () => {
		expect(normalizeBlockText("one two\n   three")).toBe("one two three");
		expect(hashBlockText("one two\n   three")).toBe(hashBlockText("one two three"));
	});

	it("is case sensitive — a rename is a change", () => {
		expect(hashBlockText("Plan")).not.toBe(hashBlockText("plan"));
	});
});

describe("blockLabel", () => {
	it("uses the first line and clips it", () => {
		const [block] = parseBlocks("## A very long heading that keeps going and going\n\nbody");
		expect(blockLabel(block!, 20)).toBe("## A very long head…");
	});
});
