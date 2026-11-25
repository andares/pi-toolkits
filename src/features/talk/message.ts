/**
 * talk message — what `Continue` sends back.
 *
 * Two parts, and nothing else:
 *   1. every note, each with the reply text it is attached to quoted above it;
 *   2. the operator's overall message from the composer.
 *
 * The full reply is deliberately NOT echoed: it is already in the model's
 * context, so quoting it again buys nothing and costs the whole answer. The
 * quote exists to locate a block, which is why it is clipped.
 *
 * The one exception is a reply that compaction pushed out of the context — then
 * the quotes point at text the model can no longer see, so the reply is sent
 * once, in full. That is a rare, explicitly expensive path.
 */
import type { Block } from "../review-page/blocks.js";
import { blockLabel } from "../review-page/blocks.js";
import { sectionPaths } from "./sections.js";

/** Longest quote — enough to find the block, not a second copy of the reply. */
export const QUOTE_LIMIT = 600;

export interface TalkNote {
	blockId: string;
	text: string;
}

export interface ReplyMessageInput {
	blocks: readonly Block[];
	/** Notes in any order; they are emitted in document order. */
	notes: readonly TalkNote[];
	/** Composer text. */
	message: string;
	/** Whether the whole reply is still in the model's active context. */
	inContext: boolean;
	replyText: string;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Clip a block for quoting, at a line boundary, closing an open fence.
 *
 * Line boundaries matter: half a code line reads as corruption, and a quote
 * that leaves a fence open would swallow the rest of the message into a code
 * block when the model's markdown renderer sees it.
 */
export function clipForQuote(text: string, limit = QUOTE_LIMIT): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;

	const lines = trimmed.split("\n");
	const kept: string[] = [];
	let size = 0;
	for (const line of lines) {
		// +2: the newline plus the ellipsis we may have to append.
		if (size + line.length + 2 > limit) break;
		kept.push(line);
		size += line.length + 1;
	}
	if (kept.length === 0) return `${trimmed.slice(0, limit - 1)}…`;

	let fence: { char: string; length: number } | undefined;
	for (const line of kept) {
		const match = FENCE_RE.exec(line);
		if (!match) continue;
		if (!fence) fence = { char: match[1][0], length: match[1].length };
		else if (match[1][0] === fence.char && match[1].length >= fence.length) fence = undefined;
	}
	// The ellipsis goes INSIDE the fence: a marker after the closing run would read
	// as prose continuing after the code block, which is not what was cut.
	kept.push("…");
	if (fence) kept.push(fence.char.repeat(fence.length));

	return kept.join("\n");
}

/**
 * Quote a block for the message body.
 *
 * A heading is quoted without its `#` markers: `> ## Alpha` right under the
 * `### Alpha` label reads as a nested heading inside a blockquote, which is noise
 * the model has to strip mentally. The text is what locates the block.
 */
function quote(block: Block, limit = QUOTE_LIMIT): string {
	const clipped = clipForQuote(block.text, limit);
	const body =
		block.kind === "heading"
			? clipped
					.split("\n")
					.map((line) => line.replace(/^ {0,3}#{1,6}\s+/, ""))
					.join("\n")
			: clipped;
	return body
		.split("\n")
		.map((line) => (line === "" ? ">" : `> ${line}`))
		.join("\n");
}

const HEADER = "## Notes on your last reply";
const INTRO =
	"Address every note below; each one is attached to the part of your reply it quotes.";
const MESSAGE_HEADER = "## Operator's message";

/** Block label used when a section path cannot be resolved (defensive only). */
function fallbackLabel(block: Block): string {
	return blockLabel(block, 60) || "reply";
}

export function buildReplyMessage(input: ReplyMessageInput): string {
	const message = input.message.trim();
	const paths = sectionPaths(input.blocks);

	// Document order, not the order the notes were written in: the model reads
	// them while scrolling the reply it is being asked to fix.
	const ordered = input.blocks
		.filter((block) => input.notes.some((note) => note.blockId === block.id))
		.map((block) => ({ block, note: input.notes.find((note) => note.blockId === block.id)! }))
		.filter(({ note }) => note.text.trim() !== "");

	if (ordered.length === 0) {
		// No notes: the composer text IS the message. No wrapper, nothing to parse.
		return message;
	}

	const sections = ordered.map(({ block, note }) => {
		const locus = paths.get(block.id) || fallbackLabel(block);
		return [`### ${locus}`, quote(block), "", `- ${note.text.trim().replace(/\n+/g, "\n  ")}`].join(
			"\n",
		);
	});

	const parts = [HEADER, "", INTRO, "", sections.join("\n\n")];
	if (!input.inContext) {
		parts.push(
			"",
			"## Your last reply (full text)",
			"",
			"The reply quoted above is no longer in your active context, so it is repeated here in full.",
			"",
			input.replyText.trim(),
		);
	}
	if (message !== "") parts.push("", MESSAGE_HEADER, "", message);
	return parts.join("\n");
}

/** True when a note points at a block that is not in the reply (stale page). */
export function hasUnknownNote(input: ReplyMessageInput): boolean {
	const ids = new Set(input.blocks.map((block) => block.id));
	return input.notes.some((note) => !ids.has(note.blockId) && note.text.trim() !== "");
}
