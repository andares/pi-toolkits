/**
 * Append-only event ledger — the mechanics two features share.
 *
 * Both the acceptance ledger (`.agents/uat/ledger.jsonl`) and the keep ledger
 * (`<agent-dir>/pi-toolkits-keep/keep.jsonl`) are the same shape: one JSON
 * object per line, deduplicated by `id`, read whole and folded into state by a
 * pure function. Three properties are load-bearing in both places:
 *
 *   - appends never rewrite the file, so two processes can add lines at the
 *     same time without a lock;
 *   - a reader tolerates a malformed or half-written line instead of failing
 *     the whole stream;
 *   - the line boundary is repaired on append — an interrupted write must not
 *     glue two JSON objects into one unparseable line, which would silently
 *     drop both records.
 *
 * Only the mechanics live here. Each feature owns its event vocabulary and its
 * validator.
 */
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";

/** Fields every ledger event carries. */
export interface LedgerEventBase {
	readonly v: number;
	readonly id: string;
	readonly ts: string;
}

/** Monotonic-enough id: time plus 6 random base36 chars. */
export function newLedgerEventId(now: Date = new Date()): string {
	const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	return `e-${now.getTime().toString(36)}-${random}`;
}

/**
 * Append one event. The file always ends with a newline: if a previous write
 * was interrupted mid-line, this repairs the boundary instead of gluing two
 * JSON objects together.
 */
export function appendLedgerLine(file: string, event: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const line = JSON.stringify(event);
	if (existsSync(file) && statSync(file).size > 0 && !endsWithNewline(file)) {
		appendFileSync(file, `\n${line}\n`, "utf8");
		return;
	}
	appendFileSync(file, `${line}\n`, "utf8");
}

function endsWithNewline(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const size = statSync(file).size;
		const buffer = Buffer.alloc(1);
		readSync(fd, buffer, 0, 1, size - 1);
		return buffer[0] === 0x0a;
	} finally {
		closeSync(fd);
	}
}

/** Parse the stream, skipping malformed lines and duplicate ids. */
export function parseLedgerLines<T extends LedgerEventBase>(
	raw: string,
	isEvent: (value: unknown) => value is T,
): { events: T[]; skipped: number } {
	const events: T[] = [];
	const seen = new Set<string>();
	let skipped = 0;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			skipped += 1;
			continue;
		}
		if (!isEvent(parsed)) {
			skipped += 1;
			continue;
		}
		if (seen.has(parsed.id)) continue;
		seen.add(parsed.id);
		events.push(parsed);
	}
	return { events, skipped };
}

/** Read and parse a ledger file. A missing or unreadable file is empty. */
export function readLedgerLines<T extends LedgerEventBase>(
	file: string,
	isEvent: (value: unknown) => value is T,
): { events: T[]; skipped: number } {
	if (!existsSync(file)) return { events: [], skipped: 0 };
	try {
		return parseLedgerLines(readFileSync(file, "utf8"), isEvent);
	} catch {
		return { events: [], skipped: 1 };
	}
}
