/**
 * reply capture — "the agent's last formal reply", as text.
 *
 * The page annotates the answer, not the work that produced it: thinking blocks
 * and tool calls are separate content types on the assistant message. Only the
 * trailing run of `text` blocks is used, so commentary before a tool call inside
 * the same message is excluded too. The other rule is the turn boundary — a run may contain several assistant messages ("let me check
 * that first" → tools → the actual answer), and only the last one is the reply.
 *
 * The scan therefore walks backwards and stops at the first user/custom message
 * (or compaction boundary). Anything older than that belongs to a previous turn
 * and annotating it would be confusing: the model already moved on.
 */
import { createHash } from "node:crypto";

export interface ReplySnapshot {
	text: string;
	/** Session entry id, so callers can ask whether it survived compaction. */
	entryId: string;
	model?: string;
	/** ISO timestamp of the assistant message, when the host recorded one. */
	at: string;
	/** Hash of the text — how a re-run decides "same reply, keep the notes". */
	fingerprint: string;
}

interface ContentBlock {
	type?: unknown;
	text?: unknown;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
	model?: unknown;
	timestamp?: unknown;
}

interface EntryLike {
	id?: unknown;
	type?: unknown;
	message?: MessageLike;
}

function textOf(message: MessageLike): string {
	if (!Array.isArray(message.content)) return "";
	let parts: string[] = [];
	for (const block of message.content as ContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else {
			// Thinking and tool calls can occur BETWEEN text blocks in one assistant
			// message. Text before that boundary is commentary, not the final reply.
			parts = [];
		}
	}
	return parts.join("").trim();
}

function isTurnBoundary(entry: EntryLike): boolean {
	if (entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary") {
		return true;
	}
	return entry.type === "message" && entry.message?.role === "user";
}

/**
 * Last formal reply on the branch, or undefined when the current turn has none.
 *
 * `entries` is `ctx.sessionManager.getBranch()` (oldest → newest).
 */
export function extractLastReply(entries: readonly unknown[]): ReplySnapshot | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as EntryLike;
		if (!entry || typeof entry !== "object") continue;
		if (isTurnBoundary(entry)) return undefined;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = textOf(entry.message);
		// An assistant message with no text is a tool-only step of the same turn;
		// keep walking instead of reporting "no reply".
		if (text === "") continue;
		const timestamp = typeof entry.message.timestamp === "number" ? entry.message.timestamp : undefined;
		return {
			text,
			entryId: typeof entry.id === "string" ? entry.id : "",
			model: typeof entry.message.model === "string" ? entry.message.model : undefined,
			at: new Date(timestamp ?? Date.now()).toISOString(),
			fingerprint: createHash("sha1").update(text).digest("hex").slice(0, 16),
		};
	}
	return undefined;
}
