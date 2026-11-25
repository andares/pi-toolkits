/**
 * keep feature — session facts and the ledger rebuild.
 *
 * Everything here answers a question about a *session file*, not about the
 * ledger: which session am I in, is it persisted, what was its first user
 * message, and can an older session's keep breadcrumb be recovered from its
 * tail. Nothing in this module calls `SessionManager.list` — the host's own
 * listing costs 576 ms for this project's 109 sessions and 9.8 s for the whole
 * agent dir, which is fine behind a progress spinner and far too slow here.
 */
import {
	closeSync,
	existsSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KEEP_ENTRY, KEEP_NOTE_MAX, KEEP_TAIL_BYTES } from "./constants.js";
import { appendKeep, isKeepLedgerEvent, type KeepState } from "./ledger.js";
import { readLedgerLines } from "../../lib/event-ledger.js";

/** What the current session is, as far as keep is concerned. */
export interface KeepSessionInfo {
	readonly session: string;
	readonly file: string;
	readonly cwd: string;
	readonly name?: string;
	/** A user or assistant message exists, so the session file is on disk. */
	readonly hasConversation: boolean;
	readonly firstUserText?: string;
}

/** Resolve symlinks so the ledger always names one canonical session file. */
export function canonicalSessionFile(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		// Keep a stable absolute path even when the file was just deleted; the
		// caller still performs the separate persistence check.
		return resolve(file);
	}
}

type ContextEntry = ReturnType<ExtensionContext["sessionManager"]["buildContextEntries"]>[number];

/** Text of a message content field (`string` or text blocks). */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: unknown; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ");
}

function roleOf(entry: ContextEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: unknown } | undefined;
	return typeof message?.role === "string" ? message.role : undefined;
}

/**
 * Describe the session this context belongs to.
 *
 * Returns `undefined` for in-memory sessions (`--no-session`): there is no
 * file to reload, so keep must refuse rather than record a path that will
 * never exist.
 */
export function currentSessionInfo(ctx: ExtensionContext): KeepSessionInfo | undefined {
	const manager = ctx.sessionManager;
	const file = manager.getSessionFile();
	if (!file) return undefined;

	const entries = manager.buildContextEntries();
	let hasConversation = false;
	let firstUserText: string | undefined;
	for (const entry of entries) {
		const role = roleOf(entry);
		if (role !== "user" && role !== "assistant") continue;
		hasConversation = true;
		if (role === "user" && firstUserText === undefined && entry.type === "message") {
			const text = contentText((entry.message as { content?: unknown }).content).trim();
			if (text.length > 0) firstUserText = text;
		}
	}

	return {
		session: manager.getSessionId(),
		file: canonicalSessionFile(file),
		cwd: manager.getCwd(),
		name: manager.getSessionName(),
		hasConversation,
		firstUserText,
	};
}

/** Collapse whitespace and cap the note: a reminder, not a summary. */
export function truncateNote(text: string, max = KEEP_NOTE_MAX): string {
	// Notes are rendered directly in the terminal and in the model transcript.
	// Collapse whitespace, then remove terminal-control characters so a pasted
	// escape sequence cannot become terminal input/output on the next list.
	const clean = text.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
	const chars = [...clean];
	if (chars.length <= max) return clean;
	return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/**
 * Pick the note for a keep: explicit argument, then the note this session got
 * last time, then the session display name, then the first user message.
 */
export function defaultNote(input: {
	readonly explicit?: string;
	readonly info: KeepSessionInfo;
	readonly previous?: string;
}): string {
	const explicit = input.explicit?.trim();
	if (explicit) return truncateNote(explicit);
	const previous = input.previous?.trim();
	if (previous) return truncateNote(previous);
	const name = input.info.name?.trim();
	if (name) return truncateNote(name);
	const first = input.info.firstUserText?.trim();
	if (first) return truncateNote(first);
	return "(no note)";
}

/** First line of a session file (the header), read without loading the file. */
export function readSessionHeader(file: string): { id?: string; cwd?: string } | undefined {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return undefined;
	}
	try {
		const size = statSync(file).size;
		const length = Math.min(8192, size);
		if (length === 0) return undefined;
		const buffer = Buffer.allocUnsafe(length);
		readSync(fd, buffer, 0, length, 0);
		const text = buffer.toString("utf8");
		const end = text.indexOf("\n");
		const line = end === -1 ? text : text.slice(0, end);
		const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown };
		if (parsed.type !== "session") return undefined;
		return {
			id: typeof parsed.id === "string" ? parsed.id : undefined,
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
		};
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** Complete lines from the end of a file (the first, partial line is dropped). */
export function readTailLines(file: string, bytes = KEEP_TAIL_BYTES): string[] {
	let fd: number;
	let size: number;
	try {
		size = statSync(file).size;
		fd = openSync(file, "r");
	} catch {
		return [];
	}
	try {
		const length = Math.min(bytes, size);
		if (length === 0) return [];
		const buffer = Buffer.allocUnsafe(length);
		readSync(fd, buffer, 0, length, size - length);
		const text = buffer.toString("utf8");
		const lines = text.split("\n");
		// The window almost never starts on a line boundary.
		if (length < size) lines.shift();
		return lines.filter((line) => line.trim().length > 0);
	} catch {
		return [];
	} finally {
		closeSync(fd);
	}
}

export interface RebuildResult {
	readonly scanned: number;
	readonly restored: number;
}

/**
 * Re-add keeps whose ledger line was lost, using the breadcrumb the session
 * file still carries. Only the tail is read: a breadcrumb is appended at quit
 * time, so it sits at the end (and if the session was reopened afterwards the
 * last keep is no longer the tail's business — `keep` events are authoritative
 * and this path only ever adds).
 */
export function rebuildKeepLedger(input: {
	readonly dir: string;
	readonly ledger: string;
	readonly state: KeepState;
	readonly now?: Date;
}): RebuildResult {
	const now = input.now ?? new Date();
	if (!existsSync(input.dir)) return { scanned: 0, restored: 0 };

	// Any event for a session proves its keep history is present. In particular,
	// an explicit drop must never be undone by its still-present breadcrumb.
	const known = new Set(input.state.entries.map((entry) => entry.session));
	for (const event of readLedgerLines(input.ledger, isKeepLedgerEvent).events) {
		known.add(event.session);
	}
	const files = readdirSync(input.dir).filter((name) => name.endsWith(".jsonl"));
	let scanned = 0;
	let restored = 0;

	for (const name of files) {
		const file = join(input.dir, name);
		scanned += 1;
		const lines = readTailLines(file);
		if (lines.length === 0) continue;
		if (!lines.some((line) => line.includes(KEEP_ENTRY))) continue;

		const header = readSessionHeader(file);
		if (!header?.id || known.has(header.id)) continue;

		let breadcrumb: { note?: unknown; at?: unknown } | undefined;
		for (const line of lines) {
			if (!line.includes(KEEP_ENTRY)) continue;
			try {
				const parsed = JSON.parse(line) as { customType?: unknown; data?: unknown };
				if (parsed.customType !== KEEP_ENTRY) continue;
				if (!parsed.data || typeof parsed.data !== "object") continue;
				breadcrumb = parsed.data as { note?: unknown; at?: unknown };
			} catch {
				// A malformed line is not a breadcrumb; keep looking.
			}
		}
		if (!breadcrumb) continue;

		const note = typeof breadcrumb.note === "string" ? truncateNote(breadcrumb.note) : "(no note)";
		const at = typeof breadcrumb.at === "number" && Number.isFinite(breadcrumb.at)
			? new Date(breadcrumb.at)
			: now;
		appendKeep(
			input.ledger,
			{
				session: header.id,
				file: canonicalSessionFile(file),
				cwd: header.cwd ?? input.state.entries[0]?.cwd ?? "",
				note,
			},
			at,
		);
		known.add(header.id);
		restored += 1;
	}

	return { scanned, restored };
}

/** Cheap existence probe used by tests and by the picker's `missing` flag. */
export function sessionFileExists(file: string): boolean {
	return existsSync(file);
}
