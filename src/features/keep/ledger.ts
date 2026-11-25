/**
 * keep feature — the keep ledger.
 *
 * `keep.jsonl` is an append-only event stream, folded into state by a pure
 * function:
 *
 *   keep    this session is unfinished and should come back
 *   drop    it is not (the operator finished it, or never wants it back)
 *   load    a pi process opened it through `/keep-load`
 *   unload  that process is gone (clean exit) or no longer holds it
 *
 * The distinction matters because loading does **not** remove anything: a
 * kept session stays in the backlog until it is dropped. "Loaded" is a
 * separate axis, and it is a record, not a lock — a hard kill leaves a stale
 * `load` behind, which is why an owner whose pid no longer exists is treated
 * as gone on read (and reaped with one `unload` line, idempotently).
 *
 * Reasons for a ledger rather than a JSON document: appending one line needs
 * no lock and no read-modify-write, so two pi processes cannot clobber each
 * other's state, and every decision keeps its timestamp for free.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	appendLedgerLine,
	type LedgerEventBase,
	newLedgerEventId,
	readLedgerLines,
} from "../../lib/event-ledger.js";
import { KEEP_DIR, KEEP_LEDGER_FILE } from "./constants.js";

export const KEEP_LEDGER_VERSION = 1;

/** The pi process that holds a loaded session. */
export interface KeepOwner {
	readonly pid: number;
	readonly host: string;
	readonly since: string;
}

export interface KeepEvent extends LedgerEventBase {
	readonly type: "keep";
	readonly session: string;
	readonly file: string;
	readonly cwd: string;
	readonly note: string;
	readonly name?: string;
}

export interface DropEvent extends LedgerEventBase {
	readonly type: "drop";
	readonly session: string;
}

export interface LoadEvent extends LedgerEventBase {
	readonly type: "load";
	readonly session: string;
	readonly owner: KeepOwner;
}

export interface UnloadEvent extends LedgerEventBase {
	readonly type: "unload";
	readonly session: string;
	readonly pid: number;
}

export type KeepLedgerEvent = KeepEvent | DropEvent | LoadEvent | UnloadEvent;

/** `<agent-dir>/pi-toolkits-keep/keep.jsonl`. */
export function keepLedgerPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, KEEP_DIR, KEEP_LEDGER_FILE);
}

export function isKeepLedgerEvent(value: unknown): value is KeepLedgerEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	if (typeof event.id !== "string" || typeof event.ts !== "string") return false;
	if (typeof event.v !== "number") return false;
	if (typeof event.session !== "string") return false;
	const isString = (input: unknown): boolean => typeof input === "string";
	const optionalString = (input: unknown): boolean =>
		input === undefined || isString(input);

	switch (event.type) {
		case "keep":
			return (
				isString(event.file) && isString(event.cwd) && isString(event.note) && optionalString(event.name)
			);
		case "drop":
			return true;
		case "load": {
			const owner = event.owner as Record<string, unknown> | undefined;
			return (
				!!owner &&
				typeof owner === "object" &&
				typeof owner.pid === "number" &&
				isString(owner.host) &&
				isString(owner.since)
			);
		}
		case "unload":
			return typeof event.pid === "number";
		default:
			return false;
	}
}

/** One kept session, folded from the stream. */
export interface KeepEntryView {
	readonly session: string;
	readonly file: string;
	readonly cwd: string;
	readonly note: string;
	readonly name?: string;
	/** Timestamp of the last `keep`. */
	readonly keptAt: string;
	/** At least one live owner process holds it. */
	readonly loaded: boolean;
	/** The session file is gone; only `ctrl+r` can clear it. */
	readonly missing: boolean;
}

export interface KeepState {
	/** Not loaded first, then loaded; newest `keep` first inside each group. */
	readonly entries: readonly KeepEntryView[];
	readonly notLoaded: readonly KeepEntryView[];
	readonly loaded: readonly KeepEntryView[];
	/** Owners whose pid is gone; the caller appends one `unload` each. */
	readonly staleOwners: readonly { readonly session: string; readonly pid: number }[];
}

export interface DeriveOptions {
	/** Host of this process; owners on other hosts are assumed live. */
	readonly host: string;
	/** Liveness probe for an owner pid on this host. */
	readonly isAlive: (pid: number) => boolean;
	/** Session file probe (injected so the fold stays testable). */
	readonly fileExists: (file: string) => boolean;
}

/** Default liveness probe: signal 0, `EPERM` still means the process exists. */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function defaultFileExists(file: string): boolean {
	return existsSync(file);
}

/**
 * Fold the stream into state. Pure: same events and probes, same result.
 *
 * Order inside a group is newest `keep` first; loaded entries always sort
 * after unloaded ones (that is the picker's two-block layout).
 */
export function deriveKeepState(
	events: readonly KeepLedgerEvent[],
	options: DeriveOptions,
): KeepState {
	const kept = new Map<string, KeepEvent>();
	const owners = new Map<string, Map<number, KeepOwner>>();

	for (const event of events) {
		switch (event.type) {
			case "keep":
				kept.set(event.session, event);
				break;
			case "drop":
				kept.delete(event.session);
				owners.delete(event.session);
				break;
			case "load": {
				const held = owners.get(event.session) ?? new Map<number, KeepOwner>();
				held.set(event.owner.pid, event.owner);
				owners.set(event.session, held);
				break;
			}
			case "unload":
				owners.get(event.session)?.delete(event.pid);
				break;
		}
	}

	const staleOwners: Array<{ session: string; pid: number }> = [];
	const entries: KeepEntryView[] = [];

	for (const [session, event] of kept) {
		const held = owners.get(session);
		let loaded = false;
		if (held) {
			for (const [pid, owner] of held) {
				if (owner.host !== options.host) {
					// Another machine: no way to probe, so the record stands.
					loaded = true;
					continue;
				}
				if (options.isAlive(pid)) {
					loaded = true;
				} else {
					held.delete(pid);
					staleOwners.push({ session, pid });
				}
			}
		}
		entries.push({
			session,
			file: event.file,
			cwd: event.cwd,
			note: event.note,
			name: event.name,
			keptAt: event.ts,
			loaded,
			missing: !options.fileExists(event.file),
		});
	}

	entries.sort((a, b) => {
		if (a.loaded !== b.loaded) return a.loaded ? 1 : -1;
		return b.keptAt.localeCompare(a.keptAt);
	});

	return {
		entries,
		notLoaded: entries.filter((entry) => !entry.loaded),
		loaded: entries.filter((entry) => entry.loaded),
		staleOwners,
	};
}

/** Read the ledger and fold it with this process's probes. */
export function readKeepState(
	file: string,
	probes: Partial<DeriveOptions> = {},
): { state: KeepState; skipped: number } {
	const { events, skipped } = readLedgerLines(file, isKeepLedgerEvent);
	const state = deriveKeepState(events, {
		host: probes.host ?? currentHost(),
		isAlive: probes.isAlive ?? processIsAlive,
		fileExists: probes.fileExists ?? defaultFileExists,
	});
	return { state, skipped };
}

/** Hostname used to decide whether a pid probe is meaningful. */
export function currentHost(): string {
	try {
		return hostname();
	} catch {
		// No hostname is better than a wrong one: owners then fall into the
		// "cannot probe" branch and stay loaded.
		return "";
	}
}

export interface KeepEventInput {
	readonly session: string;
	readonly file: string;
	readonly cwd: string;
	readonly note: string;
	readonly name?: string;
}

export function appendKeep(file: string, input: KeepEventInput, now: Date = new Date()): void {
	appendLedgerLine(file, {
		v: KEEP_LEDGER_VERSION,
		id: newLedgerEventId(now),
		ts: now.toISOString(),
		type: "keep",
		session: input.session,
		file: input.file,
		cwd: input.cwd,
		note: input.note,
		// Undefined is dropped by JSON.stringify, so the line stays compact.
		name: input.name,
	} satisfies KeepEvent);
}

export function appendDrop(file: string, session: string, now: Date = new Date()): void {
	appendLedgerLine(file, {
		v: KEEP_LEDGER_VERSION,
		id: newLedgerEventId(now),
		ts: now.toISOString(),
		type: "drop",
		session,
	} satisfies DropEvent);
}

export function appendLoad(
	file: string,
	session: string,
	owner: KeepOwner,
	now: Date = new Date(),
): void {
	appendLedgerLine(file, {
		v: KEEP_LEDGER_VERSION,
		id: newLedgerEventId(now),
		ts: now.toISOString(),
		type: "load",
		session,
		owner,
	} satisfies LoadEvent);
}

export function appendUnload(
	file: string,
	session: string,
	pid: number,
	now: Date = new Date(),
): void {
	appendLedgerLine(file, {
		v: KEEP_LEDGER_VERSION,
		id: newLedgerEventId(now),
		ts: now.toISOString(),
		type: "unload",
		session,
		pid,
	} satisfies UnloadEvent);
}

/**
 * Reap owners whose process is gone. One `unload` per stale owner; a second
 * reader that folds the same stream sees the owner already gone and appends
 * nothing, so the repair converges instead of growing.
 */
export function reapStaleOwners(
	file: string,
	stale: readonly { readonly session: string; readonly pid: number }[],
	now: Date = new Date(),
): void {
	for (const owner of stale) {
		appendUnload(file, owner.session, owner.pid, now);
	}
}
