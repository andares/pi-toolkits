/**
 * sections — which chapter a block belongs to.
 *
 * Two consumers, one answer: the page indents outline rows by this, and the
 * message back to the model labels each quote with the chapter it came from
 * ("where exactly are you talking about?"). Both read the same structure, so a
 * note can never be filed under a heading the operator did not see.
 *
 * Paths are outermost → nearest ("Approach > M2 · the review page"): the model
 * is locating text, and the top-level chapters are what it remembers best.
 */
import type { Block } from "../review-page/blocks.js";
import { headingOf } from "../review-page/headings.js";

export interface SectionEntry {
	level: number;
	text: string;
}

/** One breadcrumb string per block id (blocks outside any heading get ""). */
export function sectionPaths(blocks: readonly Block[]): Map<string, string> {
	const paths = new Map<string, string>();
	const stack: SectionEntry[] = [];
	for (const block of blocks) {
		const heading = headingOf(block);
		if (heading) {
			// A new heading closes every open section at the same or deeper level.
			while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
			stack.push(heading);
		}
		paths.set(
			block.id,
			stack.map((entry) => entry.text).join(" > "),
		);
	}
	return paths;
}

/** Depth of a heading inside its outline (0 = top level present in the doc). */
export function headingDepth(level: number, levels: readonly number[]): number {
	const distinct = [...new Set(levels)].sort((a, b) => a - b);
	const index = distinct.indexOf(level);
	return index < 0 ? 0 : Math.min(index, 3);
}
