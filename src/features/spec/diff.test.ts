import { describe, expect, it } from "vitest";
import { parseBlocks } from "./blocks.js";
import { blockSimilarity, countChanged, diffBlocks } from "./diff.js";

const parse = (markdown: string) => parseBlocks(markdown);

describe("diffBlocks", () => {
	it("reports everything unchanged for identical revisions", () => {
		const doc = parse("alpha\n\nbeta\n\ngamma");
		const entries = diffBlocks(doc, parse("alpha\n\nbeta\n\ngamma"));
		expect(entries.map((entry) => entry.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
		expect(countChanged(entries)).toBe(0);
	});

	it("calls a reworded block modified, not added+removed", () => {
		const before = parse("Write the parser first, then the server.");
		const after = parse("Write the block parser first, then the HTTP server.");
		const entries = diffBlocks(before, after);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.status).toBe("modified");
		expect(entries[0]?.prevId).toBe(before[0]?.id);
		expect(entries[0]?.id).toBe(after[0]?.id);
	});

	it("reports an appended block as added", () => {
		const before = parse("alpha\n\nbeta");
		const after = parse("alpha\n\nbeta\n\ngamma");
		const entries = diffBlocks(before, after);
		expect(entries.map((entry) => entry.status)).toEqual(["unchanged", "unchanged", "added"]);
		expect(entries[2]?.id).toBe(after[2]?.id);
	});

	it("reports a deleted block as removed, in the position it left", () => {
		const before = parse("alpha\n\nbeta\n\ngamma");
		const after = parse("alpha\n\ngamma");
		const entries = diffBlocks(before, after);
		expect(entries.map((entry) => entry.status)).toEqual(["unchanged", "removed", "unchanged"]);
		expect(entries[1]?.id).toBe(before[1]?.id);
	});

	it("reports a block that only changed position as moved", () => {
		const before = parse("alpha\n\nbeta");
		const after = parse("beta\n\nalpha");
		const entries = diffBlocks(before, after);
		expect(entries).toHaveLength(2);
		// Which of the two keeps the anchor is arbitrary; the contract is that
		// exactly one is unchanged and the other is moved — never add+remove.
		expect(entries.map((entry) => entry.status).sort()).toEqual(["moved", "unchanged"]);
		expect(countChanged(entries)).toBe(1);
	});

	it("does not pair unrelated blocks as modified", () => {
		const before = parse("Deploy the worker container.");
		const after = parse("Buy milk and eggs.");
		const entries = diffBlocks(before, after);
		expect(entries.map((entry) => entry.status)).toEqual(["removed", "added"]);
	});

	it("handles a full rewrite without inventing modifications", () => {
		const before = parse("one\n\ntwo\n\nthree");
		const after = parse("alpha\n\nbeta\n\ngamma");
		const entries = diffBlocks(before, after);
		expect(countChanged(entries)).toBe(6);
		expect(entries.some((entry) => entry.status === "unchanged")).toBe(false);
	});

	it("keeps a rotation as one move, not as edits", () => {
		const before = parse("one\n\ntwo\n\nthree");
		const after = parse("three\n\none\n\ntwo");
		const entries = diffBlocks(before, after);
		expect(entries.filter((entry) => entry.status === "modified")).toHaveLength(0);
		expect(entries.filter((entry) => entry.status === "moved")).toHaveLength(1);
		expect(entries.filter((entry) => entry.status === "unchanged")).toHaveLength(2);
		expect(entries).toHaveLength(3);
	});

	it("keeps reading order: removals before the blocks that replace them", () => {
		const before = parse("keep\n\nold block to delete\n\ntail");
		const after = parse("keep\n\nnew block entirely\n\ntail");
		const entries = diffBlocks(before, after);
		expect(entries.map((entry) => entry.status)).toEqual([
			"unchanged",
			"removed",
			"added",
			"unchanged",
		]);
	});

	it("diffs against an empty previous revision as pure additions", () => {
		const after = parse("alpha\n\nbeta");
		const entries = diffBlocks([], after);
		expect(entries.map((entry) => entry.status)).toEqual(["added", "added"]);
	});
	it("accounts for every old and new block exactly once across reorder/edit churn", () => {
		let seed = 17;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const vocabulary = ["alpha step", "beta step", "gamma step", "delta step", "epsilon step"];
		for (let round = 0; round < 80; round += 1) {
			const before = vocabulary
				.map((text) => ({ text, score: random() }))
				.sort((a, b) => a.score - b.score)
				.slice(0, 3 + Math.floor(random() * 3))
				.map((entry) => entry.text);
			const after = before.map((text) => (random() < 0.35 ? `${text} with detail` : text));
			if (random() < 0.5) after.push("zeta step");
			// Deterministic rotation instead of a biased random comparator.
			const shift = Math.floor(random() * Math.max(after.length, 1));
			after.push(...after.splice(0, shift));
			const previous = parse(before.join("\n\n"));
			const next = parse(after.join("\n\n"));
			const entries = diffBlocks(previous, next);
			expect(
				entries.filter((entry) => entry.status !== "removed").map((entry) => entry.id),
			).toEqual(next.map((block) => block.id));
			const coveredPrevious = entries.flatMap((entry) => {
				if (entry.status === "added") return [];
				if (entry.status === "unchanged") return [entry.id];
				return entry.prevId ? [entry.prevId] : [];
			});
			expect(new Set(coveredPrevious).size).toBe(previous.length);
		}
	});
});

describe("blockSimilarity", () => {
	it("is 1 for identical text and low for unrelated text", () => {
		const a = parse("Write the block parser.")[0]!;
		const b = parse("Write the block parser.")[0]!;
		const c = parse("Completely different sentence about cooking.")[0]!;
		expect(blockSimilarity(a, b)).toBe(1);
		expect(blockSimilarity(a, c)).toBeLessThan(0.2);
	});

	it("works on CJK text (bigrams, not words)", () => {
		const a = parse("先做块模型，再做服务器。")[0]!;
		const b = parse("先做块模型，然后做服务器。")[0]!;
		const c = parse("今天天气不错，出去走走。")[0]!;
		expect(blockSimilarity(a, b)).toBeGreaterThan(0.5);
		expect(blockSimilarity(a, c)).toBeLessThan(0.2);
	});
});
