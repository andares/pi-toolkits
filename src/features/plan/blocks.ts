/**
 * plan blocks — the review unit of `/ask-plan`.
 *
 * A block is one blank-line-separated paragraph of the plan markdown: that is
 * the granularity the operator annotates at ("this step is wrong"), so there is
 * deliberately no AST here — no inline spans, no line-level addressing.
 *
 * Two rules make the model survive edits:
 *   - a fenced code block is ONE block, even though it usually contains blank
 *     lines (splitting it would turn a snippet into nonsense fragments);
 *   - a block's identity is a hash of its normalized text, so reflowing prose
 *     or re-indenting does not read as "changed", while any word change does.
 *
 * Duplicate paragraphs are legal in a plan (two identical steps, two identical
 * bullets), so the id carries the occurrence index: `hash#0`, `hash#1`, …
 */
import { createHash } from "node:crypto";

export type BlockKind = "heading" | "text" | "list" | "code" | "table" | "quote";

export interface Block {
	/** `hash#occurrence` — stable across reflow, distinguishes duplicates. */
	id: string;
	kind: BlockKind;
	/** Raw markdown of the block (trimmed, inner blank lines kept). */
	text: string;
	/** Hash of the normalized text — equal hash means "not changed". */
	hash: string;
	/** 0-based position in the document. */
	index: number;
	/** 1-based line number of the block's first line. */
	line: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}\s/;
const QUOTE_RE = /^ {0,3}>\s?/;
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const TABLE_SEPARATOR_RE = /^ {0,3}\|?[\s:-]*-{3,}[\s:|-]*$/;

/** Normalize a block for hashing: reflow-insensitive, case-sensitive. */
export function normalizeBlockText(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** 12 hex chars of sha1 — short enough to read in an id, wide enough to not collide. */
export function hashBlockText(text: string): string {
	return createHash("sha1").update(normalizeBlockText(text)).digest("hex").slice(0, 12);
}

function classify(lines: readonly string[]): BlockKind {
	const first = lines[0] ?? "";
	if (FENCE_RE.test(first)) return "code";
	if (HEADING_RE.test(first)) return "heading";
	if (QUOTE_RE.test(first)) return "quote";
	if (lines.length >= 2 && first.includes("|") && TABLE_SEPARATOR_RE.test(lines[1] ?? "")) {
		return "table";
	}
	if (LIST_RE.test(first)) return "list";
	return "text";
}

interface Chunk {
	lines: string[];
	line: number;
}

/** Split markdown into chunks: blank-line separated, fence-aware. */
function splitChunks(markdown: string): Chunk[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const chunks: Chunk[] = [];
	let current: string[] = [];
	let startLine = 1;
	/** Open fence: its character and its opening run length. */
	let fence: { char: string; length: number } | null = null;

	const flush = (): void => {
		if (current.length === 0) return;
		chunks.push({ lines: current, line: startLine });
		current = [];
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const fenceMatch = FENCE_RE.exec(line);

		if (fence) {
			if (current.length === 0) startLine = i + 1;
			current.push(line);
			// Close only on a run of the same character at least as long as the
			// opener (CommonMark): ``` inside a ~~~~ block is content.
			if (
				fenceMatch &&
				fenceMatch[1]?.startsWith(fence.char) &&
				fenceMatch[1].length >= fence.length
			) {
				fence = null;
			}
			continue;
		}

		if (fenceMatch) {
			if (current.length === 0) startLine = i + 1;
			fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
			current.push(line);
			continue;
		}

		if (line.trim() === "") {
			flush();
			continue;
		}

		if (current.length === 0) startLine = i + 1;
		current.push(line);
	}

	flush();
	return chunks;
}

/**
 * Parse plan markdown into blocks. An empty document yields no blocks; a
 * document that is only blank lines yields none either (never a phantom block).
 */
export function parseBlocks(markdown: string): Block[] {
	const seen = new Map<string, number>();
	return splitChunks(markdown).map((chunk, index) => {
		const text = chunk.lines.join("\n").trim();
		const hash = hashBlockText(text);
		const occurrence = seen.get(hash) ?? 0;
		seen.set(hash, occurrence + 1);
		return {
			id: `${hash}#${occurrence}`,
			kind: classify(chunk.lines),
			text,
			hash,
			index,
			line: chunk.line,
		};
	});
}

/** One-line label for a block: its first line, clipped — used in feedback text. */
export function blockLabel(block: Block, maxLength = 80): string {
	const first = (block.text.split("\n")[0] ?? "").trim();
	return first.length > maxLength ? `${first.slice(0, maxLength - 1)}…` : first;
}
