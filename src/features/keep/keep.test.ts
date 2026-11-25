/**
 * keep feature — ledger folding, notes, rebuild, commands and picker.
 *
 * Everything is deterministic: a temp ledger, an injected clock/host/pid, and
 * liveness/file probes supplied per test. The command cases encode the product
 * rules that are easy to break: loading never removes a keep, a dead owner is
 * still listed (dimmed) and still loadable, and a cancelled switch must not
 * leave a `load` behind.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { KEEP_ENTRY, KEEP_NOTICE_ENTRY } from "./constants.js";
import {
	formatAge,
	formatStamp,
	noticeText,
	pickerTitle,
	resumeText,
	rowText,
} from "./format.js";
import {
	appendDrop,
	appendKeep,
	appendLoad,
	deriveKeepState,
	type KeepEntryView,
	type KeepLedgerEvent,
	processIsAlive,
	readKeepState,
	reapStaleOwners,
} from "./ledger.js";
import { findTarget, parseLoadArgs, registerKeep, samePath, type KeepOptions } from "./index.js";
import { KeepPicker } from "./picker.js";
import {
	canonicalSessionFile,
	currentSessionInfo,
	defaultNote,
	rebuildKeepLedger,
	truncateNote,
} from "./store.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-25T10:00:00.000Z");

function event(partial: Partial<KeepLedgerEvent> & Pick<KeepLedgerEvent, "type" | "session">): KeepLedgerEvent {
	return {
		v: 1,
		id: `e-${Math.random().toString(36).slice(2, 10)}`,
		ts: "2026-11-25T09:00:00.000Z",
		...(partial as object),
	} as KeepLedgerEvent;
}

function keepEvent(session: string, overrides: Partial<{ ts: string; note: string; cwd: string; file: string }> = {}): KeepLedgerEvent {
	return {
		v: 1,
		id: `keep-${session}-${Math.random().toString(36).slice(2, 8)}`,
		ts: overrides.ts ?? "2026-11-25T09:00:00.000Z",
		type: "keep",
		session,
		file: overrides.file ?? `/sessions/${session}.jsonl`,
		cwd: overrides.cwd ?? "/tmp/proj",
		note: overrides.note ?? `note ${session}`,
	};
}

function entry(overrides: Partial<KeepEntryView> = {}): KeepEntryView {
	return {
		session: "s1",
		file: "/sessions/s1.jsonl",
		cwd: "/tmp/proj",
		note: "order migration",
		keptAt: "2026-11-25T09:00:00.000Z",
		loaded: false,
		missing: false,
		...overrides,
	};
}

const probes = {
	host: "host-a",
	isAlive: () => true,
	fileExists: () => true,
};

describe("deriveKeepState", () => {
	it("keeps the last keep/drop decision, not the first", () => {
		const dropped = deriveKeepState(
			[keepEvent("s1"), event({ type: "drop", session: "s1" })],
			probes,
		);
		expect(dropped.entries).toHaveLength(0);

		const rekept = deriveKeepState(
			[
				keepEvent("s1"),
				event({ type: "drop", session: "s1" }),
				keepEvent("s1", { ts: "2026-11-25T09:30:00.000Z" }),
			],
			probes,
		);
		expect(rekept.entries.map((item) => item.session)).toEqual(["s1"]);
	});

	it("stays loaded while any owner is alive", () => {
		const owners = (
			[
				{ type: "load", session: "s1", owner: { pid: 1, host: "host-a", since: "t" } },
				{ type: "load", session: "s1", owner: { pid: 2, host: "host-a", since: "t" } },
			] as KeepLedgerEvent[]
		).map((partial) => event(partial as never));
		const state = deriveKeepState([keepEvent("s1"), ...owners], probes);
		expect(state.entries[0].loaded).toBe(true);
		expect(state.loaded).toHaveLength(1);

		const afterOne = deriveKeepState(
			[keepEvent("s1"), ...owners, event({ type: "unload", session: "s1", pid: 1 } as never)],
			probes,
		);
		expect(afterOne.entries[0].loaded).toBe(true);

		const afterBoth = deriveKeepState(
			[
				keepEvent("s1"),
				...owners,
				event({ type: "unload", session: "s1", pid: 1 } as never),
				event({ type: "unload", session: "s1", pid: 2 } as never),
			],
			probes,
		);
		expect(afterBoth.entries[0].loaded).toBe(false);
	});

	it("treats a dead owner on this host as gone and reports it for reaping", () => {
		const state = deriveKeepState(
			[keepEvent("s1"), event({ type: "load", session: "s1", owner: { pid: 4242, host: "host-a", since: "t" } } as never)],
			{ ...probes, isAlive: () => false },
		);
		expect(state.entries[0].loaded).toBe(false);
		expect(state.staleOwners).toEqual([{ session: "s1", pid: 4242 }]);
	});

	it("assumes an owner on another host is alive (nothing to probe)", () => {
		const state = deriveKeepState(
			[keepEvent("s1"), event({ type: "load", session: "s1", owner: { pid: 4242, host: "host-b", since: "t" } } as never)],
			{ ...probes, isAlive: () => false },
		);
		expect(state.entries[0].loaded).toBe(true);
		expect(state.staleOwners).toHaveLength(0);
	});

	it("sorts not-loaded first and newest keep first inside each group", () => {
		const state = deriveKeepState(
			[
				keepEvent("old", { ts: "2026-11-20T09:00:00.000Z" }),
				keepEvent("new", { ts: "2026-11-24T09:00:00.000Z" }),
				keepEvent("open", { ts: "2026-11-23T09:00:00.000Z" }),
				event({ type: "load", session: "open", owner: { pid: 1, host: "host-a", since: "t" } } as never),
			],
			probes,
		);
		expect(state.entries.map((item) => item.session)).toEqual(["new", "old", "open"]);
	});

	it("flags a missing session file", () => {
		const state = deriveKeepState([keepEvent("s1")], { ...probes, fileExists: () => false });
		expect(state.entries[0].missing).toBe(true);
	});

	it("reaping a dead owner converges: the second read has nothing to repair", () => {
		const ledger = join(tempDir(), "keep.jsonl");
		appendKeep(ledger, { session: "s1", file: "/sessions/s1.jsonl", cwd: "/tmp/proj", note: "n" });
		appendLoad(ledger, "s1", { pid: 4242, host: "host-a", since: NOW.toISOString() });
		const dead = { ...probes, isAlive: () => false };

		const first = readKeepState(ledger, dead);
		expect(first.state.staleOwners).toEqual([{ session: "s1", pid: 4242 }]);
		reapStaleOwners(ledger, first.state.staleOwners);

		const second = readKeepState(ledger, dead);
		expect(second.state.staleOwners).toHaveLength(0);
		expect(second.state.entries[0].loaded).toBe(false);
	});
});

describe("ledger file", () => {
	it("skips malformed lines and duplicate ids", () => {
		const dir = tempDir();
		const file = join(dir, "keep.jsonl");
		const once = keepEvent("s1");
		writeFileSync(
			file,
			[
				JSON.stringify(once),
				JSON.stringify(once),
				"{not json",
				JSON.stringify({ v: 1, id: "x", ts: "t", type: "keep" }),
				"",
			].join("\n"),
			"utf8",
		);
		const { skipped } = readKeepState(file, probes);
		expect(skipped).toBe(2);
		expect(readKeepState(file, probes).state.entries).toHaveLength(1);
	});

	it("repairs a half-written last line instead of gluing two records", () => {
		const dir = tempDir();
		const file = join(dir, "keep.jsonl");
		writeFileSync(file, JSON.stringify(keepEvent("s1")).slice(0, 20), "utf8");
		appendDrop(file, "s1", NOW);
		const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain('"type":"drop"');
	});
});

describe("format", () => {
	it("rounds ages coarsely", () => {
		expect(formatAge("2026-11-25T09:59:40.000Z", NOW)).toBe("now");
		expect(formatAge("2026-11-25T09:48:00.000Z", NOW)).toBe("12m");
		expect(formatAge("2026-11-25T07:00:00.000Z", NOW)).toBe("3h");
		expect(formatAge("2026-11-23T10:00:00.000Z", NOW)).toBe("2d");
		expect(formatAge("2026-11-10T10:00:00.000Z", NOW)).toBe("2w");
	});

	it("renders a row: glyph, age, note, optional project and missing", () => {
		expect(rowText(entry(), { now: NOW, showProject: false })).toBe("○ 1h  order migration");
		expect(rowText(entry({ loaded: true }), { now: NOW, showProject: false })).toBe(
			"● 1h  order migration",
		);
		expect(rowText(entry({ loaded: true, cwd: "/tmp/other-project" }), { now: NOW, showProject: true })).toBe(
			"● 1h  order migration  ·  other-project",
		);
		expect(rowText(entry({ missing: true }), { now: NOW, showProject: false })).toBe(
			"○ 1h  order migration  ·  missing",
		);
	});

	it("titles and notices stay one line", () => {
		expect(pickerTitle(2, 1)).toBe("Keep backlog — 2 not loaded, 1 loaded");
		expect(pickerTitle(2, 0)).toBe("Keep backlog — 2 not loaded");
		expect(noticeText(2)).toBe("2 not loaded · /keep-load");
	});

	it("resume text carries the local stamp and the note", () => {
		expect(formatStamp("2026-11-25T09:00:00.000Z")).toBe("2026-11-25 09:00");
		expect(resumeText(entry())).toBe(
			'[keep] Resumed from the backlog — note left 2026-11-25 09:00: "order migration"',
		);
	});
});

describe("args", () => {
	it("parses flags in any order", () => {
		expect(parseLoadArgs("")).toEqual({ all: false, rebuild: false, target: undefined });
		expect(parseLoadArgs("--all")).toEqual({ all: true, rebuild: false, target: undefined });
		expect(parseLoadArgs("rebuild")).toEqual({ all: false, rebuild: true, target: undefined });
		expect(parseLoadArgs("2 --all")).toEqual({ all: true, rebuild: false, target: "2" });
	});

	it("resolves a 1-based index or a unique id prefix", () => {
		const list = [entry({ session: "aaa-1" }), entry({ session: "bbb-2" })];
		expect(findTarget(list, "1")?.session).toBe("aaa-1");
		expect(findTarget(list, "2")?.session).toBe("bbb-2");
		expect(findTarget(list, "3")).toBeUndefined();
		expect(findTarget(list, "bbb")?.session).toBe("bbb-2");
		expect(findTarget([entry({ session: "aaa-1" }), entry({ session: "aaa-2" })], "aaa")).toBeUndefined();
	});

	it("compares directories tolerantly", () => {
		expect(samePath("/a/b/", "/a/b")).toBe(true);
		expect(samePath("/a/b", "/a/c")).toBe(false);
		expect(samePath("", "/a/b")).toBe(false);
	});
});

describe("notes", () => {
	const info = {
		session: "s1",
		file: "/s.jsonl",
		cwd: "/tmp/proj",
		hasConversation: true,
		firstUserText: "please migrate the order table",
	};

	it("falls back explicit → previous → session name → first message", () => {
		expect(defaultNote({ explicit: "  short note ", info, previous: "older" })).toBe("short note");
		expect(defaultNote({ info, previous: "older" })).toBe("older");
		expect(defaultNote({ info: { ...info, name: "Named" } })).toBe("Named");
		expect(defaultNote({ info })).toBe("please migrate the order table");
		expect(defaultNote({ info: { ...info, firstUserText: undefined } })).toBe("(no note)");
	});

	it("collapses whitespace and caps long notes", () => {
		expect(truncateNote("  a\n\n b  ")).toBe("a b");
		expect(truncateNote("x".repeat(80), 10)).toHaveLength(10);
	});

	it("removes terminal control characters from notes", () => {
		expect(truncateNote("before\u001b[31mafter")).toBe("before[31mafter");
	});
});

describe("currentSessionInfo", () => {
	it("canonicalizes a symlinked session file", () => {
		const dir = tempDir();
		const real = join(dir, "real.jsonl");
		const link = join(dir, "link.jsonl");
		writeFileSync(real, "", "utf8");
		symlinkSync(real, link);
		expect(canonicalSessionFile(link)).toBe(real);
	});

	function ctxWith(manager: Record<string, unknown>): ExtensionContext {
		return { sessionManager: manager } as unknown as ExtensionContext;
	}

	it("returns undefined for an in-memory session", () => {
		expect(
			currentSessionInfo(
				ctxWith({ getSessionFile: () => undefined, getSessionId: () => "s1" }),
			),
		).toBeUndefined();
	});

	it("reads the first user text out of content blocks", () => {
		const info = currentSessionInfo(
			ctxWith({
				getSessionFile: () => "/s.jsonl",
				getSessionId: () => "s1",
				getCwd: () => "/tmp/proj",
				getSessionName: () => "named",
				buildContextEntries: () => [
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello there" }] } },
					{ type: "message", message: { role: "assistant", content: "hi" } },
				],
			}),
		);
		expect(info).toMatchObject({
			session: "s1",
			file: "/s.jsonl",
			cwd: "/tmp/proj",
			name: "named",
			hasConversation: true,
			firstUserText: "hello there",
		});
	});

	it("reports an empty session as no conversation", () => {
		const info = currentSessionInfo(
			ctxWith({
				getSessionFile: () => "/s.jsonl",
				getSessionId: () => "s1",
				getCwd: () => "/tmp/proj",
				getSessionName: () => undefined,
				buildContextEntries: () => [],
			}),
		);
		expect(info?.hasConversation).toBe(false);
	});
});

describe("rebuildKeepLedger", () => {
	it("re-adds a keep from the session breadcrumb and leaves the rest alone", () => {
		const dir = tempDir();
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const ledger = join(dir, "keep.jsonl");

		const withBreadcrumb = join(sessions, "with.jsonl");
		writeFileSync(
			withBreadcrumb,
			[
				JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "/tmp/proj" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "x" } }),
				JSON.stringify({ type: "custom", id: "c1", parentId: null, timestamp: "2026-11-24T08:00:00.000Z", customType: KEEP_ENTRY, data: { note: "half done", at: 1790000000000 } }),
			].join("\n") + "\n",
			"utf8",
		);
		const plain = join(sessions, "plain.jsonl");
		writeFileSync(plain, JSON.stringify({ type: "session", id: "def", cwd: "/tmp/proj" }) + "\n", "utf8");

		appendKeep(ledger, { session: "known", file: "/sessions/known.jsonl", cwd: "/tmp/proj", note: "already" });
		const state = readKeepState(ledger, probes).state;

		const result = rebuildKeepLedger({ dir: sessions, ledger, state, now: NOW });
		expect(result).toEqual({ scanned: 2, restored: 1 });

		const after = readKeepState(ledger, probes).state;
		expect(after.entries.map((item) => item.session).sort()).toEqual(["abc", "known"]);
		expect(after.entries.find((item) => item.session === "abc")?.note).toBe("half done");
	});

	it("never resurrects a session that was explicitly dropped", () => {
		const dir = tempDir();
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const ledger = join(dir, "keep.jsonl");
		const file = join(sessions, "dropped.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", id: "dropped", cwd: "/tmp/proj" }),
				JSON.stringify({ type: "custom", customType: KEEP_ENTRY, data: { note: "finished", at: 1790000000000 } }),
			].join("\n") + "\n",
			"utf8",
		);
		appendKeep(ledger, { session: "dropped", file, cwd: "/tmp/proj", note: "finished" });
		appendDrop(ledger, "dropped", NOW);

		const state = readKeepState(ledger, probes).state;
		expect(state.entries).toHaveLength(0);
		expect(rebuildKeepLedger({ dir: sessions, ledger, state, now: NOW })).toEqual({
			scanned: 1,
			restored: 0,
		});
		expect(readKeepState(ledger, probes).state.entries).toHaveLength(0);
	});

	it("never removes anything", () => {
		const dir = tempDir();
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const ledger = join(dir, "keep.jsonl");
		appendKeep(ledger, { session: "gone", file: "/x.jsonl", cwd: "/tmp/proj", note: "n" });

		const state = readKeepState(ledger, { ...probes, fileExists: () => false }).state;
		expect(state.entries).toHaveLength(1);
		rebuildKeepLedger({ dir: sessions, ledger, state, now: NOW });
		expect(readKeepState(ledger, probes).state.entries).toHaveLength(1);
	});
});

interface Harness {
	readonly notes: Array<{ message: string; kind?: string }>;
	readonly entries: Array<{ type: string; data: unknown }>;
	readonly switched: string[];
	readonly ready: boolean;
	shutdowns: number;
	sessionName?: string;
	run(command: string, args: string, ctx: ExtensionCommandContext): Promise<void>;
	start(reason: string, ctx: ExtensionContext): void;
	shutdown(reason: string): void;
	ctx(overrides?: Record<string, unknown>): ExtensionCommandContext;
}

function harness(options: KeepOptions & { ledgerFile: string }): Harness {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {};
	const notes: Harness["notes"] = [];
	const entries: Harness["entries"] = [];
	const switched: string[] = [];
	const state = { shutdowns: 0, sessionName: undefined as string | undefined, ready: true };

	const pi = {
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			commands.set(name, definition.handler);
		},
		registerEntryRenderer() {},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		setSessionName(name: string) {
			state.sessionName = name;
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers[event] = handler;
		},
	} as unknown as ExtensionAPI;

	registerKeep(pi, { fileExists: () => true, ...options });

	function makeCtx(overrides: Record<string, unknown> = {}): ExtensionCommandContext {
		const base = {
			mode: "tui",
			hasUI: true,
			cwd: "/tmp/proj",
			isIdle: () => true,
			ui: {
				notify: (message: string, kind?: string) => notes.push({ message, kind }),
			},
			sessionManager: {
				getSessionFile: () => "/sessions/current.jsonl",
				getSessionId: () => "current",
				getCwd: () => "/tmp/proj",
				getSessionName: () => state.sessionName,
				getSessionDir: () => "/sessions",
				buildContextEntries: () => [
					{ type: "message", message: { role: "user", content: "work in progress" } },
				],
			},
			shutdown: () => {
				state.shutdowns += 1;
			},
			switchSession: async (path: string, opts: { withSession?: (ctx: ExtensionContext) => Promise<void> }) => {
				switched.push(path);
				await opts.withSession?.({
					ui: { notify: () => {} },
					sendMessage: () => Promise.resolve(),
				} as unknown as ExtensionContext);
				return { cancelled: false };
			},
		};
		return { ...base, ...overrides } as unknown as ExtensionCommandContext;
	}

	return {
		notes,
		entries,
		switched,
		get ready() {
			return state.ready;
		},
		get shutdowns() {
			return state.shutdowns;
		},
		get sessionName() {
			return state.sessionName;
		},
		run: (command, args, ctx) => commands.get(command)?.(args, ctx) ?? Promise.resolve(),
		start: (reason, ctx) => {
			handlers.session_start?.({ type: "session_start", reason }, ctx);
		},
		shutdown: (reason) => {
			handlers.session_shutdown?.({ type: "session_shutdown", reason }, {} as ExtensionContext);
		},
		ctx: makeCtx,
	};
}

describe("/keep-quit", () => {
	function setup(overrides: Partial<KeepOptions> = {}) {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		return {
			ledgerFile,
			harness: harness({
				ledgerFile,
				now: () => NOW,
				host: "host-a",
				pid: 100,
				isAlive: () => true,
				fileExists: () => true,
				...overrides,
			}),
		};
	}

	it("refuses outside the TUI, while busy, when unpersisted, and when empty", async () => {
		const { harness: h } = setup();
		await h.run("keep-quit", "", h.ctx({ mode: "print" }));
		await h.run("keep-quit", "", h.ctx({ isIdle: () => false }));
		await h.run(
			"keep-quit",
			"",
			h.ctx({ sessionManager: { getSessionFile: () => undefined } }),
		);
		await h.run(
			"keep-quit",
			"",
			h.ctx({
				sessionManager: {
					getSessionFile: () => "/sessions/current.jsonl",
					getSessionId: () => "current",
					getCwd: () => "/tmp/proj",
					getSessionName: () => undefined,
					buildContextEntries: () => [],
				},
			}),
		);
		expect(h.notes).toHaveLength(4);
		expect(h.entries).toHaveLength(0);
		expect(h.shutdowns).toBe(0);
	});

	it("refuses when the session file was deleted", async () => {
		const { harness: h } = setup({ fileExists: () => false });
		await h.run("keep-quit", "must not record", h.ctx());
		expect(h.notes.at(-1)?.message).toBe("This session is not saved on disk — there is nothing to keep");
		expect(h.entries).toHaveLength(0);
		expect(h.shutdowns).toBe(0);
	});

	it("writes the breadcrumb, the keep event, the session name, then quits", async () => {
		const { harness: h, ledgerFile } = setup();
		await h.run("keep-quit", "  order migration  ", h.ctx());

		expect(h.entries).toEqual([
			{ type: KEEP_ENTRY, data: { note: "order migration", at: NOW.getTime() } },
		]);
		expect(h.sessionName).toBe("order migration");
		expect(h.shutdowns).toBe(1);

		const state = readKeepState(ledgerFile, probes).state;
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({
			session: "current",
			file: "/sessions/current.jsonl",
			cwd: "/tmp/proj",
			note: "order migration",
			loaded: false,
		});
	});
});

describe("/keep-drop", () => {
	it("drops a kept session and refuses one that is not kept", async () => {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		appendKeep(ledgerFile, {
			session: "current",
			file: "/sessions/current.jsonl",
			cwd: "/tmp/proj",
			note: "n",
		});
		const h = harness({ ledgerFile, now: () => NOW, host: "host-a", pid: 100, isAlive: () => true });

		await h.run("keep-drop", "", h.ctx());
		expect(readKeepState(ledgerFile, probes).state.entries).toHaveLength(0);
		expect(h.notes.at(-1)?.message).toContain("Dropped");

		await h.run("keep-drop", "", h.ctx());
		expect(h.notes.at(-1)?.message).toBe("This session is not in the keep list");
	});
});

describe("/keep-load", () => {
	function setup(options: { veto?: boolean; missing?: boolean } = {}) {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		appendKeep(ledgerFile, {
			session: "target",
			file: "/sessions/target.jsonl",
			cwd: "/tmp/proj",
			note: "older task",
		});
		const h = harness({
			ledgerFile,
			now: () => NOW,
			host: "host-a",
			pid: 100,
			isAlive: () => true,
			fileExists: () => !options.missing,
			ask: () => "load",
		});
		const ctx = h.ctx({
			switchSession: async (
				path: string,
				opts: { withSession?: (ctx: ExtensionContext) => Promise<void> },
			) => {
				if (options.veto) return { cancelled: true };
				h.switched.push(path);
				await opts.withSession?.({
					ui: { notify: () => {} },
					sendMessage: (message: { customType: string }) => {
						h.entries.push({ type: message.customType, data: null });
					},
				} as unknown as ExtensionContext);
				return { cancelled: false };
			},
		});
		return { h, ctx, ledgerFile };
	}

	it("loads a target by index and injects the resume note", async () => {
		const { h, ctx, ledgerFile } = setup();
		await h.run("keep-load", "1", ctx);

		expect(h.switched).toEqual(["/sessions/target.jsonl"]);
		expect(h.entries.map((item) => item.type)).toEqual(["keep:resume"]);

		const state = readKeepState(ledgerFile, probes).state;
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0].loaded).toBe(true);
	});

	it("releases the load when the switch is cancelled", async () => {
		const { h, ctx, ledgerFile } = setup({ veto: true });
		await h.run("keep-load", "1", ctx);

		expect(h.switched).toHaveLength(0);
		expect(h.notes.at(-1)?.message).toBe("Load cancelled");
		const state = readKeepState(ledgerFile, probes).state;
		expect(state.entries[0].loaded).toBe(false);
	});

	it("keeps the switched session loaded when saving the resume note fails", async () => {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		appendKeep(ledgerFile, {
			session: "target",
			file: "/sessions/target.jsonl",
			cwd: "/tmp/proj",
			note: "older",
		});
		const h = harness({
			ledgerFile,
			now: () => NOW,
			host: "host-a",
			pid: 100,
			isAlive: () => true,
			fileExists: () => true,
			ask: () => "load",
		});
		const ctx = h.ctx({
			switchSession: async (
				path: string,
				opts: { withSession?: (ctx: ExtensionContext) => Promise<void> },
			) => {
				h.switched.push(path);
				await opts.withSession?.({
					ui: { notify: (message: string, kind?: string) => h.notes.push({ message, kind }) },
					sendMessage: () => Promise.reject(new Error("disk full")),
				} as unknown as ExtensionContext);
				return { cancelled: false };
			},
		});

		await h.run("keep-load", "1", ctx);
		expect(h.switched).toEqual(["/sessions/target.jsonl"]);
		expect(h.notes.at(-1)?.message).toContain("resume note could not be saved: disk full");
		expect(readKeepState(ledgerFile, probes).state.entries[0].loaded).toBe(true);
	});

	it("refuses a missing session file without switching", async () => {
		const { h, ctx } = setup({ missing: true });
		await h.run("keep-load", "1", ctx);
		expect(h.switched).toHaveLength(0);
		expect(h.notes.at(-1)?.message).toContain("Session file is gone");
	});

	it("hides the current session and only lists this project without --all", async () => {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		appendKeep(ledgerFile, { session: "target", file: "/t.jsonl", cwd: "/tmp/proj", note: "mine" });
		appendKeep(ledgerFile, { session: "current", file: "/sessions/current.jsonl", cwd: "/tmp/proj", note: "me" });
		appendKeep(ledgerFile, { session: "elsewhere", file: "/e.jsonl", cwd: "/tmp/other", note: "theirs" });

		const seen: string[][] = [];
		const h = harness({
			ledgerFile,
			now: () => NOW,
			host: "host-a",
			pid: 100,
			isAlive: () => true,
			ask: () => "load",
			pick: (_ctx, entries) => {
				seen.push(entries.map((item) => item.session));
				return { action: "cancel" };
			},
		});

		await h.run("keep-load", "", h.ctx());
		await h.run("keep-load", "--all", h.ctx());
		expect(seen[0]).toEqual(["target"]);
		// Both keeps can share a millisecond; only membership matters here.
		expect([...seen[1]].sort()).toEqual(["elsewhere", "target"]);
	});

	it("keeps the current session first when the dialog says so", async () => {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		appendKeep(ledgerFile, {
			session: "target",
			file: "/sessions/target.jsonl",
			cwd: "/tmp/proj",
			note: "older",
		});
		const h = harness({
			ledgerFile,
			now: () => NOW,
			host: "host-a",
			pid: 100,
			isAlive: () => true,
			fileExists: () => true,
			ask: () => "keep",
		});
		await h.run("keep-load", "1", h.ctx());
		expect(h.switched).toEqual(["/sessions/target.jsonl"]);
		const state = readKeepState(ledgerFile, probes).state;
		expect(state.entries.map((item) => item.session).sort()).toEqual(["current", "target"]);
	});
});

describe("startup notice", () => {
	function setup() {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		appendKeep(ledgerFile, { session: "a", file: "/a.jsonl", cwd: "/tmp/proj", note: "one" });
		appendKeep(ledgerFile, { session: "b", file: "/b.jsonl", cwd: "/tmp/proj", note: "two" });
		appendKeep(ledgerFile, { session: "c", file: "/c.jsonl", cwd: "/tmp/other", note: "elsewhere" });
		const h = harness({
			ledgerFile,
			now: () => NOW,
			host: "host-a",
			pid: 100,
			isAlive: () => true,
			fileExists: () => true,
		});
		const ctx = (sessionId: string) =>
			({
				mode: "tui",
				cwd: "/tmp/proj",
				ui: { notify: () => {} },
				sessionManager: { getSessionId: () => sessionId },
			}) as unknown as ExtensionContext;
		return { h, ctx };
	}

	it("counts this project only, excluding the current session, once per session", () => {
		const { h, ctx } = setup();
		h.start("startup", ctx("current"));
		expect(h.entries).toEqual([{ type: KEEP_NOTICE_ENTRY, data: { count: 2 } }]);

		h.start("startup", ctx("current"));
		h.start("startup", ctx("a"));
		expect(h.entries).toEqual([
			{ type: KEEP_NOTICE_ENTRY, data: { count: 2 } },
			{ type: KEEP_NOTICE_ENTRY, data: { count: 1 } },
		]);
	});

	it("ignores non-startup reasons and non-TUI modes", () => {
		const { h, ctx } = setup();
		h.start("resume", ctx("current"));
		h.start("startup", { ...(ctx("current") as object), mode: "print" } as ExtensionContext);
		expect(h.entries).toHaveLength(0);
	});
});

describe("session_shutdown", () => {
	it("releases the loaded session once, except on reload", async () => {
		const ledgerFile = join(tempDir(), "keep.jsonl");
		appendKeep(ledgerFile, { session: "target", file: "/t.jsonl", cwd: "/tmp/proj", note: "n" });
		const h = harness({
			ledgerFile,
			now: () => NOW,
			host: "host-a",
			pid: 100,
			isAlive: () => true,
			fileExists: () => true,
			ask: () => "load",
		});
		await h.run("keep-load", "1", h.ctx());
		expect(readKeepState(ledgerFile, probes).state.entries[0].loaded).toBe(true);

		h.shutdown("reload");
		expect(readKeepState(ledgerFile, probes).state.entries[0].loaded).toBe(true);

		h.shutdown("quit");
		expect(readKeepState(ledgerFile, probes).state.entries[0].loaded).toBe(false);

		h.shutdown("quit");
		const unloads = readFileSync(ledgerFile, "utf8")
			.split("\n")
			.filter((line) => line.includes('"type":"unload"'));
		expect(unloads).toHaveLength(1);
	});
});

describe("KeepPicker", () => {
	const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme;

	function mount(entries: KeepEntryView[]) {
		const drops: string[] = [];
		let result: unknown;
		const picker = new KeepPicker(
			entries,
			{ now: NOW, showProject: false, drop: (item) => drops.push(item.session) },
			theme,
			(value) => {
				result = value;
			},
			() => {},
		);
		return { picker, drops, result: () => result };
	}

	it("renders one row per entry with the state glyph", () => {
		const { picker } = mount([entry(), entry({ session: "s2", loaded: true, note: "second" })]);
		const lines = picker.render(80);
		expect(lines[0]).toBe("Keep backlog — 1 not loaded, 1 loaded");
		expect(lines[3]).toBe("→ ○ 1h  order migration");
		expect(lines[4]).toBe("  ● 1h  second");
	});

	it("drops the highlighted row with ctrl+r without loading", () => {
		const { picker, drops, result } = mount([entry(), entry({ session: "s2", note: "second" })]);
		picker.handleInput("\x12");
		expect(drops).toEqual(["s1"]);
		expect(result()).toBeUndefined();
		expect(picker.render(80)[3]).toBe("→ ○ 1h  second");
	});

	it("moves with the arrow keys and loads with enter", () => {
		const { picker, result } = mount([entry(), entry({ session: "s2", note: "second" })]);
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(result()).toEqual({ action: "load", entry: expect.objectContaining({ session: "s2" }) });
	});

	it("cancels on escape", () => {
		const { picker, result } = mount([entry()]);
		picker.handleInput("\x1b");
		expect(result()).toEqual({ action: "cancel" });
	});

	it("cancels when the last row is dropped", () => {
		const { picker, result } = mount([entry()]);
		picker.handleInput("\x12");
		expect(result()).toEqual({ action: "cancel" });
	});

	it("scrolls instead of overflowing", () => {
		const many = Array.from({ length: 20 }, (_unused, index) =>
			entry({ session: `s${index}`, note: `task ${index}` }),
		);
		const picker = new KeepPicker(
			many,
			{ now: NOW, showProject: false, maxRows: 3, drop: () => {} },
			theme,
			() => {},
			() => {},
		);
		const lines = picker.render(80);
		expect(lines).toHaveLength(3 + 3 + 1);
		expect(lines.at(-1)).toBe("  1/20");
	});
});

describe("probes", () => {
	it("treats the current process as alive", () => {
		expect(processIsAlive(process.pid)).toBe(true);
	});
});
