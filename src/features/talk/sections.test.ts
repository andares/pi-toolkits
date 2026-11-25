import { describe, expect, it } from "vitest";
import { parseBlocks } from "../review-page/blocks.js";
import { headingDepth, sectionPaths } from "./sections.js";

describe("sectionPaths", () => {
	it("labels every block with the chain of headings above it", () => {
		const blocks = parseBlocks(
			"# Plan\n\nintro\n\n## Approach\n\nbody\n\n### Milestones\n\ndetail\n\n## Risks\n\nrisk",
		);
		const paths = sectionPaths(blocks);
		expect(paths.get(blocks[0].id)).toBe("Plan");
		expect(paths.get(blocks[1].id)).toBe("Plan");
		expect(paths.get(blocks[3].id)).toBe("Plan > Approach");
		expect(paths.get(blocks[4].id)).toBe("Plan > Approach > Milestones");
		expect(paths.get(blocks[5].id)).toBe("Plan > Approach > Milestones");
		expect(paths.get(blocks[7].id)).toBe("Plan > Risks");
	});

	it("leaves blocks before the first heading without a path", () => {
		const blocks = parseBlocks("preamble\n\n## Later\n\nbody");
		expect(sectionPaths(blocks).get(blocks[0].id)).toBe("");
	});

	it("closes deeper sections when a shallower heading appears", () => {
		const blocks = parseBlocks("## A\n\n### B\n\ntext\n\n## C\n\ntext");
		const paths = sectionPaths(blocks);
		expect(paths.get(blocks[2].id)).toBe("A > B");
		expect(paths.get(blocks[4].id)).toBe("C");
	});
});

describe("headingDepth", () => {
	it("maps the levels actually present onto 0..3", () => {
		expect(headingDepth(2, [2, 3, 4])).toBe(0);
		expect(headingDepth(3, [2, 3, 4])).toBe(1);
		expect(headingDepth(6, [2, 3, 4, 5, 6])).toBe(3);
		expect(headingDepth(9, [2, 3])).toBe(0);
	});
});
