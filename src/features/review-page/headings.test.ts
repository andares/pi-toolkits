import { describe, expect, it } from "vitest";
import { parseBlocks } from "../review-page/blocks.js";
import { cleanHeadingText, extractHeadings, headingOf } from "../review-page/headings.js";

describe("cleanHeadingText", () => {
	it("drops the closing hashes and inline emphasis", () => {
		expect(cleanHeadingText("**Approach** ##")).toBe("Approach");
		expect(cleanHeadingText("`code` and *em*")).toBe("code and em");
		expect(cleanHeadingText("[link](https://example.com)")).toBe("link");
	});
});

describe("extractHeadings", () => {
	it("lists ATX headings in document order with their levels", () => {
		const blocks = parseBlocks("# Title\n\nintro\n\n## Section\n\nbody\n\n### Deep\n\nmore");
		expect(extractHeadings(blocks)).toEqual([
			{ blockId: blocks[0].id, level: 1, text: "Title" },
			{ blockId: blocks[2].id, level: 2, text: "Section" },
			{ blockId: blocks[4].id, level: 3, text: "Deep" },
		]);
	});

	it("ignores hashes inside fenced code and non-heading blocks", () => {
		const blocks = parseBlocks("## Real\n\n```sh\n## not a heading\n```\n\nplain paragraph");
		expect(extractHeadings(blocks).map((heading) => heading.text)).toEqual(["Real"]);
	});

	it("indexes headings even when prose and the next heading have no blank lines", () => {
		const blocks = parseBlocks("## One\nfirst body\n## Two\nsecond body");
		expect(extractHeadings(blocks).map((heading) => heading.text)).toEqual(["One", "Two"]);
		expect(headingOf(blocks[0])).toEqual({ level: 2, text: "One" });
		expect(blocks[1]?.text).toBe("first body");
	});

	it("returns nothing for a reply without headings", () => {
		expect(extractHeadings(parseBlocks("just prose\n\nand more prose"))).toEqual([]);
		expect(extractHeadings(parseBlocks(""))).toEqual([]);
	});

	it("drops a heading whose text is only markup", () => {
		const blocks = parseBlocks("## **\n\nbody");
		expect(extractHeadings(blocks)).toEqual([]);
	});
});
