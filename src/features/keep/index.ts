/**
 * keep feature — `/keep-quit`, `/keep-load`, `/keep-drop`.
 *
 * The problem: a project with several parallel tasks is a pile of sessions,
 * and after a day away nobody remembers which one was finished. `/resume`
 * lists every session by time, so it cannot answer that (and it happily opens
 * one that another pi already has open).
 *
 * The shape here is a backlog with two independent axes:
 *
 *   kept   — "this task is unfinished"; only `/keep-quit` sets it and only
 *            `/keep-drop` (or `ctrl+r` in the list) clears it;
 *   loaded — "some pi process has it open right now"; written on load, cleared
 *            on clean exit. A hard kill leaves it stale, so an owner whose pid
 *            is gone is treated as gone on read, and a loaded row is still
 *            selectable (that is the manual override).
 *
 * Loading never removes anything. That is deliberate: an automatic removal has
 * nowhere to put "loaded" and nothing to recover when the deciding process is
 * wrong.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	KEEP_ENTRY,
	KEEP_NOTICE_ENTRY,
	KEEP_RESUME_ENTRY,
} from "./constants.js";
import { noticeText, resumeText } from "./format.js";
import {
	appendDrop,
	appendKeep,
	appendLoad,
	appendUnload,
	type KeepEntryView,
	type KeepOwner,
	type KeepState,
	keepLedgerPath,
	currentHost,
	readKeepState,
	reapStaleOwners,
	processIsAlive,
} from "./ledger.js";
import { askSwitchChoice, pickKeepEntry, type KeepPick, type SwitchChoice } from "./picker.js";
import {
	currentSessionInfo,
	defaultNote,
	rebuildKeepLedger,
	type KeepSessionInfo,
} from "./store.js";

export interface KeepOptions {
	/** Ledger file; defaults to `<agent-dir>/pi-toolkits-keep/keep.jsonl`. */
	readonly ledgerFile?: string;
	readonly now?: () => Date;
	readonly host?: string;
	readonly pid?: number;
	readonly isAlive?: (pid: number) => boolean;
	readonly fileExists?: (file: string) => boolean;
	/** Test seam for the list UI. */
	readonly pick?: (
		ctx: ExtensionContext,
		entries: readonly KeepEntryView[],
		options: Parameters<typeof pickKeepEntry>[2],
	) => Promise<KeepPick | undefined> | KeepPick | undefined;
	/** Test seam for the "keep the current session first?" dialog. */
	readonly ask?: (
		ctx: ExtensionContext,
		entry: KeepEntryView,
	) => Promise<SwitchChoice | undefined> | SwitchChoice | undefined;
}

interface LoadArgs {
	readonly all: boolean;
	readonly rebuild: boolean;
	readonly target?: string;
}

/** `"" | "--all" | "rebuild" | "2" | "<id-prefix>"` (flags in any order). */
export function parseLoadArgs(raw: string): LoadArgs {
	const tokens = raw
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	let all = false;
	let rebuild = false;
	let target: string | undefined;
	for (const token of tokens) {
		if (token === "--all" || token === "-a") {
			all = true;
			continue;
		}
		if (token === "rebuild") {
			rebuild = true;
			continue;
		}
		if (target === undefined) target = token;
	}
	return { all, rebuild, target };
}

/** Same directory, tolerant of trailing separators and `..`. */
export function samePath(left: string, right: string): boolean {
	if (left.length === 0 || right.length === 0) return false;
	return resolve(left) === resolve(right);
}

/** Index (1-based) or session id / unique id prefix. */
export function findTarget(
	entries: readonly KeepEntryView[],
	target: string,
): KeepEntryView | undefined {
	if (/^\d+$/.test(target)) {
		const index = Number(target) - 1;
		return index >= 0 && index < entries.length ? entries[index] : undefined;
	}
	const exact = entries.find((entry) => entry.session === target);
	if (exact) return exact;
	const matches = entries.filter((entry) => entry.session.startsWith(target));
	return matches.length === 1 ? matches[0] : undefined;
}

export function registerKeep(pi: ExtensionAPI, options: KeepOptions = {}): void {
	const ledger = options.ledgerFile ?? keepLedgerPath();
	const now = options.now ?? (() => new Date());
	const host = options.host ?? currentHost();
	const pid = options.pid ?? process.pid;
	const isAlive = options.isAlive ?? processIsAlive;
	const fileExists = options.fileExists ?? ((file: string): boolean => {
		try {
			return existsSync(file);
		} catch {
			return false;
		}
	});
	const pick = options.pick ?? pickKeepEntry;
	const ask = options.ask ?? askSwitchChoice;

	/** The session this process loaded through `/keep-load`, if any. */
	let loadedHere: string | undefined;
	/** Dedupe repeated `session_start` emissions for the same session. */
	let noticeSession: string | undefined;

	function readState(): KeepState {
		const { state } = readKeepState(ledger, { host, isAlive, fileExists });
		// Repair stale owners once, on read: a hard-killed process must not keep
		// showing as "loaded" forever, and the repair is idempotent.
		if (state.staleOwners.length > 0) reapStaleOwners(ledger, state.staleOwners, now());
		return state;
	}

	function owner(): KeepOwner {
		const at = now();
		return { pid, host, since: at.toISOString() };
	}

	/** Write the keep for a session that is here right now. */
	function keepCurrent(
		session: KeepSessionInfo,
		explicit: string | undefined,
		previous: string | undefined,
	): string {
		const at = now();
		const note = defaultNote({ explicit, info: session, previous });
		pi.appendEntry(KEEP_ENTRY, { note, at: at.getTime() });
		appendKeep(
			ledger,
			{ session: session.session, file: session.file, cwd: session.cwd, note, name: session.name },
			at,
		);
		if (!session.name) pi.setSessionName(note);
		return note;
	}

	async function runKeepQuit(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("keep-quit needs the interactive TUI", "warning");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Still working — run /keep-quit after this turn finishes", "warning");
			return;
		}
		const info = currentSessionInfo(ctx);
		if (!info) {
			ctx.ui.notify("This session is not persisted — there is nothing to keep", "warning");
			return;
		}
		if (!info.hasConversation) {
			ctx.ui.notify("Nothing to keep yet — this session has no messages", "warning");
			return;
		}
		if (!fileExists(info.file)) {
			ctx.ui.notify("This session is not saved on disk — there is nothing to keep", "warning");
			return;
		}

		const state = readState();
		const previous = state.entries.find((entry) => entry.session === info.session)?.note;
		const note = keepCurrent(info, args.trim() || undefined, previous);
		ctx.ui.notify(`Kept for later: ${note}`, "info");
		ctx.shutdown();
	}

	async function runKeepDrop(_args: string, ctx: ExtensionCommandContext): Promise<void> {
		const info = currentSessionInfo(ctx);
		if (!info) {
			ctx.ui.notify("This session is not persisted — there is nothing to drop", "warning");
			return;
		}
		const entry = readState().entries.find((item) => item.session === info.session);
		if (!entry) {
			ctx.ui.notify("This session is not in the keep list", "info");
			return;
		}
		appendDrop(ledger, info.session, now());
		ctx.ui.notify(`Dropped from keep: ${entry.note}`, "info");
	}

	async function runKeepLoad(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseLoadArgs(args);

		if (parsed.rebuild) {
			const result = rebuildKeepLedger({
				dir: ctx.sessionManager.getSessionDir(),
				ledger,
				state: readState(),
				now: now(),
			});
			ctx.ui.notify(
				result.restored > 0
					? `Rebuilt ${result.restored} kept session${result.restored === 1 ? "" : "s"} from ${result.scanned} files`
					: `No missing keeps found in ${result.scanned} session file${result.scanned === 1 ? "" : "s"}`,
				"info",
			);
			return;
		}

		const info = currentSessionInfo(ctx);
		const state = readState();
		// The current session is managed by /keep-quit and /keep-drop, not by the
		// backlog: listing it would offer to load the session you are already in.
		const visible = state.entries.filter(
			(entry) =>
				entry.session !== info?.session && (parsed.all || samePath(entry.cwd, ctx.cwd)),
		);

		if (visible.length === 0) {
			ctx.ui.notify(
				parsed.all
					? "No kept sessions"
					: "No kept sessions in this project — try /keep-load --all",
				"info",
			);
			return;
		}

		let entry: KeepEntryView | undefined;
		if (parsed.target) {
			entry = findTarget(visible, parsed.target);
			if (!entry) {
				ctx.ui.notify(`No kept session matches "${parsed.target}"`, "warning");
				return;
			}
		} else {
			const picked = await pick(ctx, visible, {
				now: now(),
				showProject: parsed.all,
				drop: (dropped) => appendDrop(ledger, dropped.session, now()),
			});
			if (!picked || picked.action === "cancel") return;
			entry = picked.entry;
		}

		if (entry.missing) {
			ctx.ui.notify(
				`Session file is gone: ${entry.file} — press ctrl+r in the list to drop it`,
				"warning",
			);
			return;
		}

		// Switching away from unkept work loses it from the backlog.
		let keepBefore = false;
		if (info && info.hasConversation && fileExists(info.file)) {
			const current = state.entries.find((item) => item.session === info.session);
			if (!current) {
				const choice = await ask(ctx, entry);
				if (choice === undefined || choice === "cancel") return;
				keepBefore = choice === "keep";
			}
		}
		if (keepBefore && info) keepCurrent(info, undefined, undefined);

		appendLoad(ledger, entry.session, owner(), now());
		try {
			const result = await ctx.switchSession(entry.file, {
				withSession: async (newCtx) => {
					// Claim ownership only after the switch landed: the old session's
					// `session_shutdown` fires during the switch and must release the
					// session we are leaving, not the one we just loaded.
					loadedHere = entry.session;
					try {
						await newCtx.sendMessage(
							{
								customType: KEEP_RESUME_ENTRY,
								content: resumeText(entry),
								display: true,
							},
							{},
						);
					} catch (error) {
						// The switch already succeeded. A note-write failure must not
						// unload the session that is open now, and it must not fall
						// back to the old (stale) command context.
						newCtx.ui.notify(
							`Loaded ${entry.note}, but the resume note could not be saved: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
						return;
					}
					newCtx.ui.notify(`Loaded: ${entry.note}`, "info");
				},
			});
			if (!result.cancelled) return;
			writeUnload(entry.session);
			ctx.ui.notify("Load cancelled", "warning");
		} catch (error) {
			writeUnload(entry.session);
			ctx.ui.notify(
				`Failed to load: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	/** Append the `unload` for `session` and forget the claim if it was ours. */
	function writeUnload(session: string): void {
		if (loadedHere === session) loadedHere = undefined;
		appendUnload(ledger, session, pid, now());
	}

	pi.registerCommand("keep-quit", {
		description: "Keep this session as unfinished and quit",
		handler: async (args, ctx) => runKeepQuit(args, ctx),
	});

	pi.registerCommand("keep-load", {
		description: "Load a kept session: no argument opens the list; <n|id>, --all, rebuild",
		handler: async (args, ctx) => runKeepLoad(args, ctx),
	});

	pi.registerCommand("keep-drop", {
		description: "Remove this session from the keep list",
		handler: async (args, ctx) => runKeepDrop(args, ctx),
	});

	const supportsEntryRenderer = typeof pi.registerEntryRenderer === "function";
	if (supportsEntryRenderer) {
		pi.registerEntryRenderer<{ count?: unknown }>(KEEP_NOTICE_ENTRY, (entry, _options, theme) => {
			const count = entry.data?.count;
			if (typeof count !== "number") return undefined;
			return new Text(theme.fg("dim", noticeText(count)), 1, 0);
		});
	}

	// The resume note is a real message (the model needs it), but the default
	// custom-message chrome (`[keep:resume]`) is noise in the transcript.
	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(KEEP_RESUME_ENTRY, (message, _options, theme) => {
			const content = message.content;
			if (typeof content !== "string" || content.length === 0) return undefined;
			return new Text(theme.fg("muted", content), 1, 0);
		});
	}

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;
		if (ctx.mode !== "tui") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId === noticeSession) return;
		noticeSession = sessionId;

		const state = readState();
		const count = state.notLoaded.filter(
			(entry) => entry.session !== sessionId && samePath(entry.cwd, ctx.cwd),
		).length;
		if (count === 0) return;
		if (supportsEntryRenderer) {
			pi.appendEntry(KEEP_NOTICE_ENTRY, { count });
			return;
		}
		ctx.ui.notify(noticeText(count), "info");
	});

	pi.on("session_shutdown", (event) => {
		// `reload` keeps the same session alive: it is not a release.
		if (event.reason === "reload") return;
		const session = loadedHere;
		if (!session) return;
		writeUnload(session);
	});
}
