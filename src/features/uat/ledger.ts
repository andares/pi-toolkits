/**
 * UAT feature — the acceptance ledger.
 *
 * `ledger.jsonl` is the only place where acceptance decisions live. It is an
 * append-only event stream, not a document to be rewritten:
 *
 *   - toggling a checkbox appends one line — there is no "submit", and closing
 *     the page cannot lose a decision that was already taken;
 *   - two sessions (or two branches) can append at the same time without
 *     clobbering each other; readers deduplicate by event `id`;
 *   - everything the page shows is derived from the stream, so the display can
 *     never drift from the record of what the operator actually did.
 *
 * Derivation is a pure function over (records on disk, events). That is
 * deliberate: the fallback index is the directory itself, so a project that
 * never called `record_change` still gets a correct (if less informative)
 * acceptance queue.
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
import { dirname, join } from "node:path";
import type { RecordEntry } from "./records.js";

export const LEDGER_VERSION = 1;

interface BaseEvent {
	readonly v: number;
	readonly id: string;
	readonly ts: string;
}

export interface CandidateEvent extends BaseEvent {
	readonly type: "candidate";
	/** Change-record id (file name without `.md`). */
	readonly report: string;
	readonly title: string;
	readonly behavior: string;
	readonly hint?: string;
	readonly area?: string;
	readonly files?: string[];
	readonly spec?: string;
}

export interface BatchEvent extends BaseEvent {
	readonly type: "batch";
	readonly batch: string;
	readonly candidates: number;
	readonly since?: string;
}

export interface ItemEvent extends BaseEvent {
	readonly type: "item";
	readonly item: string;
	readonly batch?: string;
	readonly title: string;
	readonly summary: string;
	readonly steps?: string[];
	readonly edge?: string[];
	/** "What not to worry about" — internals that changed without user impact. */
	readonly skip?: string;
	readonly reports: string[];
	readonly spec?: string;
	readonly area?: string;
}

export interface LinkEvent extends BaseEvent {
	readonly type: "link";
	readonly item: string;
	readonly reports: string[];
	readonly reason?: string;
}

export interface CheckEvent extends BaseEvent {
	readonly type: "check" | "uncheck";
	readonly item: string;
	readonly reason?: string;
}

export interface AmendEvent extends BaseEvent {
	readonly type: "amend";
	readonly item: string;
	readonly title?: string;
	readonly summary?: string;
	readonly steps?: string[];
	readonly edge?: string[];
	readonly skip?: string;
	readonly spec?: string;
}

export interface MergeEvent extends BaseEvent {
	readonly type: "merge";
	/** Surviving item. */
	readonly item: string;
	readonly sources: string[];
}

export interface DropEvent extends BaseEvent {
	readonly type: "drop";
	readonly item: string;
	readonly reason?: string;
}

export type UatEvent =
	| CandidateEvent
	| BatchEvent
	| ItemEvent
	| LinkEvent
	| CheckEvent
	| AmendEvent
	| MergeEvent
	| DropEvent;

export interface UatItemView {
	id: string;
	title: string;
	summary: string;
	steps: string[];
	edge: string[];
	skip?: string;
	spec?: string;
	area?: string;
	batch?: string;
	reports: string[];
	createdAt: string;
	/** Last time evidence was attached (item/link event), not just record time. */
	evidenceUpdatedAt: string;
	checkedAt?: string;
	/** New evidence landed after the last check: counts as unchecked. */
	reopened: boolean;
	dropped?: string;
	mergedInto?: string;
	/** Evidence ids that no longer exist on disk (the record was renamed/deleted). */
	missingReports: string[];
}

export interface PendingCandidate extends RecordEntry {
	behavior?: string;
	hint?: string;
	area?: string;
	spec?: string;
	files?: string[];
}

export interface UatBatchView {
	id: string;
	at: string;
	candidates: number;
}

export interface UatState {
	items: UatItemView[];
	/** Items that still need the operator (never checked, or reopened). */
	open: UatItemView[];
	checked: UatItemView[];
	pending: PendingCandidate[];
	batches: UatBatchView[];
	lastEventTs?: string;
	counts: {
		items: number;
		open: number;
		checked: number;
		pending: number;
		totalRecords: number;
	};
}

/** `<root>/.agents/uat/ledger.jsonl` */
export function ledgerPath(root: string): string {
	return join(root, ".agents/uat/ledger.jsonl");
}

/** Monotonic-enough id: time plus 6 random base36 chars. */
export function newEventId(now: Date = new Date()): string {
	const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	return `e-${now.getTime().toString(36)}-${random}`;
}

/**
 * Append one event. The file always ends with a newline: if a previous write
 * was interrupted mid-line, this repairs the boundary instead of gluing two
 * JSON objects together (a gluing would silently drop both on read).
 */
export function appendEvent(file: string, event: UatEvent): void {
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
export function parseEvents(raw: string): { events: UatEvent[]; skipped: number } {
	const events: UatEvent[] = [];
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

function isEvent(value: unknown): value is UatEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	if (typeof event.id !== "string" || typeof event.ts !== "string") return false;
	if (typeof event.v !== "number") return false;
	const string = (input: unknown): boolean => typeof input === "string";
	const strings = (input: unknown): boolean =>
		Array.isArray(input) && input.every((entry) => typeof entry === "string");
		const optionalString = (input: unknown): boolean => input === undefined || string(input);
	const optionalStrings = (input: unknown): boolean => input === undefined || strings(input);

	switch (event.type) {
		case "candidate":
			return (
				string(event.report) &&
				string(event.title) &&
				string(event.behavior) &&
				optionalString(event.hint) &&
				optionalString(event.area) &&
				optionalStrings(event.files) &&
				optionalString(event.spec)
			);
		case "batch":
			return string(event.batch) && typeof event.candidates === "number";
		case "item":
			return (
				string(event.item) &&
				string(event.title) &&
				string(event.summary) &&
				strings(event.reports) &&
				optionalStrings(event.steps) &&
				optionalStrings(event.edge) &&
				optionalString(event.skip) &&
				optionalString(event.spec) &&
				optionalString(event.area) &&
				optionalString(event.batch)
			);
		case "link":
			return string(event.item) && strings(event.reports);
		case "check":
		case "uncheck":
			return string(event.item) && optionalString(event.reason);
		case "amend":
			return (
				string(event.item) &&
				optionalString(event.title) &&
				optionalString(event.summary) &&
				optionalStrings(event.steps) &&
				optionalStrings(event.edge) &&
				optionalString(event.skip) &&
				optionalString(event.spec)
			);
		case "merge":
			return string(event.item) && strings(event.sources);
		case "drop":
			return string(event.item) && optionalString(event.reason);
		default:
			return false;
	}
}

export function readEvents(file: string): { events: UatEvent[]; skipped: number } {
	if (!existsSync(file)) return { events: [], skipped: 0 };
	try {
		return parseEvents(readFileSync(file, "utf8"));
	} catch {
		return { events: [], skipped: 1 };
	}
}

/** Latest candidate metadata per report id (last write wins). */
function candidateByReport(events: readonly UatEvent[]): Map<string, CandidateEvent> {
	const map = new Map<string, CandidateEvent>();
	for (const event of events) {
		if (event.type === "candidate") map.set(event.report, event);
	}
	return map;
}

/**
 * Derive everything the page needs. Pure: same inputs, same output.
 */
export function deriveState(
	records: readonly RecordEntry[],
	events: readonly UatEvent[],
): UatState {
	const items = new Map<string, UatItemView>();
	const batches: UatBatchView[] = [];
	const byId = new Map(records.map((record) => [record.id, record]));

	const ensure = (id: string, ts: string): UatItemView => {
		const existing = items.get(id);
		if (existing) return existing;
		const created: UatItemView = {
			id,
			title: id,
			summary: "",
			steps: [],
			edge: [],
			reports: [],
			createdAt: ts,
			evidenceUpdatedAt: ts,
			reopened: false,
			missingReports: [],
		};
		items.set(id, created);
		return created;
	};

	for (const event of events) {
		switch (event.type) {
			case "batch":
				batches.push({ id: event.batch, at: event.ts, candidates: event.candidates });
				break;
			case "item": {
				const item = ensure(event.item, event.ts);
				item.title = event.title;
				item.summary = event.summary;
				item.steps = event.steps ?? [];
				item.edge = event.edge ?? [];
				item.skip = event.skip;
				item.reports = unique([...item.reports, ...event.reports]);
				item.batch = event.batch ?? item.batch;
				item.spec = event.spec ?? item.spec;
				item.area = event.area ?? item.area;
				item.createdAt = event.ts;
				item.evidenceUpdatedAt = event.ts;
				break;
			}
			case "amend": {
				const item = ensure(event.item, event.ts);
				if (event.title !== undefined) item.title = event.title;
				if (event.summary !== undefined) item.summary = event.summary;
				if (event.steps !== undefined) item.steps = event.steps;
				if (event.edge !== undefined) item.edge = event.edge;
				if (event.skip !== undefined) item.skip = event.skip;
				if (event.spec !== undefined) item.spec = event.spec;
				break;
			}
			case "link": {
				const item = ensure(event.item, event.ts);
				item.reports = unique([...item.reports, ...event.reports]);
				item.evidenceUpdatedAt = event.ts;
				break;
			}
			case "merge": {
				const target = ensure(event.item, event.ts);
				for (const source of event.sources) {
					const sourceItem = items.get(source);
					if (!sourceItem || sourceItem.id === target.id) continue;
					target.reports = unique([...target.reports, ...sourceItem.reports]);
					// Merging an unchecked duplicate into an accepted item must not
					// silently accept the source's evidence. When both were accepted,
					// retain the earlier tick so newer evidence still reopens it.
					if (sourceItem.checkedAt === undefined) {
						target.checkedAt = undefined;
					} else if (target.checkedAt !== undefined) {
						target.checkedAt =
							sourceItem.checkedAt < target.checkedAt
								? sourceItem.checkedAt
								: target.checkedAt;
					}
					sourceItem.mergedInto = target.id;
				}
				break;
			}
			case "check":
				ensure(event.item, event.ts).checkedAt = event.ts;
				break;
			case "uncheck": {
				const item = ensure(event.item, event.ts);
				item.checkedAt = undefined;
				break;
			}
			case "drop": {
				const item = ensure(event.item, event.ts);
				item.dropped = event.reason ?? "dropped";
				break;
			}
			case "candidate":
				// Metadata only; the queue itself is derived from the records on disk.
				break;
		}
	}

	const live: UatItemView[] = [];
	for (const item of items.values()) {
		if (item.dropped !== undefined) continue;
		if (item.mergedInto !== undefined) continue;
		const evidenceEpoch = Math.max(
			0,
			Date.parse(item.evidenceUpdatedAt) || 0,
			...item.reports.map((report) => byId.get(report)?.epochMs ?? 0),
		);
		item.reopened =
			item.checkedAt !== undefined && evidenceEpoch > (Date.parse(item.checkedAt) || 0);
		item.missingReports = item.reports.filter((report) => !byId.has(report));
		live.push(item);
	}

	const referenced = new Set<string>();
	// Dropped items still consume their evidence: otherwise abandoning work
	// would resurrect the same records as fresh acceptance debt on the next run.
	for (const item of items.values()) for (const report of item.reports) referenced.add(report);

	const candidates = candidateByReport(events);
	const pending: PendingCandidate[] = records
		.filter((record) => !referenced.has(record.id))
		.map((record) => {
			const candidate = candidates.get(record.id);
			return {
				...record,
				...(candidate
					? {
							behavior: candidate.behavior,
							hint: candidate.hint,
							area: candidate.area,
							spec: candidate.spec,
							files: candidate.files,
						}
					: {}),
			};
		})
		// Newest first, independent of the caller's input order: the page and the
		// clustering work order both read this queue top-down.
		.sort((a, b) => b.epochMs - a.epochMs || a.id.localeCompare(b.id));

	const open = live
		.filter((item) => item.checkedAt === undefined || item.reopened)
		.sort((a, b) => evidenceEpochOf(b, byId) - evidenceEpochOf(a, byId) || b.createdAt.localeCompare(a.createdAt));
	const checked = live
		.filter((item) => item.checkedAt !== undefined && !item.reopened)
		.sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""));

	const ordered = [...open, ...checked];
	batches.sort((a, b) => b.at.localeCompare(a.at));

	return {
		items: ordered,
		open,
		checked,
		pending,
		batches,
		lastEventTs: events.length > 0 ? events[events.length - 1]?.ts : undefined,
		counts: {
			items: ordered.length,
			open: open.length,
			checked: checked.length,
			pending: pending.length,
			totalRecords: records.length,
		},
	};
}

function evidenceEpochOf(item: UatItemView, byId: Map<string, RecordEntry>): number {
	let max = Date.parse(item.createdAt) || 0;
	for (const report of item.reports) {
		const record = byId.get(report);
		if (record && record.epochMs > max) max = record.epochMs;
	}
	return max;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))];
}
