/**
 * headings — the outline entries a review page indexes.
 *
 * The review page needs a table of contents for BOTH modes (`/ask-spec` and
 * `/ask-talk`), so extraction lives here rather than in either feature, and the
 * page never parses rendered HTML to recover structure: the server ships the
 * same blocks it renders, plus this index over them.
 *
 * Only ATX headings (`## Title`) count. Setext (`Title` + `---`) is not
 * recognised by `parseBlocks` either, so an outline that claimed it would
 * disagree with the blocks the operator can actually annotate. Precision is
 * deliberately cheap here: a heading merged into a paragraph block still shows
 * up (its first line is a heading) and the anchor is the block, not the line.
 */
import type { Block } from "./blocks.js";

export interface Heading {
	/** Block the outline row jumps to. */
	blockId: string;
	/** 1–6, for indentation. */
	level: number;
	/** Display text: markers and inline emphasis removed. */
	text: string;
}

const ATX_RE = /^ {0,3}(#{1,6})\s+(.*)$/;

/**
 * Strip inline markdown from a heading so the outline reads as text.
 *
 * Display only — the message sent back to the model quotes the block itself,
 * never this cleaned string, so losing a marker here costs nothing.
 */
export function cleanHeadingText(raw: string): string {
	return raw
		.replace(/\s+#+\s*$/, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.trim();
}

/** The heading a block starts with, if any (its first line only). */
export function headingOf(block: Pick<Block, "kind" | "text">): { level: number; text: string } | undefined {
	if (block.kind !== "heading") return undefined;
	const match = ATX_RE.exec(block.text.split("\n")[0] ?? "");
	if (!match) return undefined;
	const raw = match[2] ?? "";
	const text = cleanHeadingText(raw);
	// A heading that is only markup (`## **`, `## ---`) has nothing to show and
	// nothing to jump to; treat it as absent rather than emitting a blank row.
	if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
	return { level: match[1].length, text };
}

/** Outline entries, in document order. */
export function extractHeadings(blocks: readonly Block[]): Heading[] {
	const headings: Heading[] = [];
	for (const block of blocks) {
		const found = headingOf(block);
		if (found) headings.push({ blockId: block.id, level: found.level, text: found.text });
	}
	return headings;
}
