/**
 * `/ask-talk` wiring, with a real HTTP server.
 *
 * The pure reply/message tests cannot catch the dangerous part of this feature:
 * which snapshot the still-open page is actually talking to after a new reply.
 * These tests go through the registered command and its routes for that reason.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTalk, TALK_COMMAND } from "./index.js";

/**
 * Distinct port per server, never reused inside this file.
 *
 * The HTTP clients keep connections alive, and those pools are keyed by port:
 * handing a new test a port whose previous server has just closed gives its
 * first request a dead socket ("socket hang up"). A counter is also immune to
 * the birthday collisions a narrow random range produces once the whole suite
 * runs under the 4-way compatibility matrix.
 */
let nextPort = 48_001;
function takePort(): number {
	nextPort += 3;
	return nextPort;
}

type Handler = (event: unknown, ctx: ExtensionContext) => void;

interface Harness {
	command: (args?: string) => Promise<void>;
	ctx: ExtensionContext;
	entries: unknown[];
	setReply: (text: string) => void;
	opened: ReturnType<typeof vi.fn>;
	messages: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	shutdown: () => void;
	start: (sessionId?: string) => void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function assistant(text: string): object {
	return {
		id: `a-${Math.random().toString(36).slice(2)}`,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "test/model",
			timestamp: 1_700_000_000_000,
		},
	};
}

function harness(): Harness {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const handlers = new Map<string, Handler[]>();
	const opened = vi.fn();
	const messages = vi.fn();
	const notify = vi.fn();
	let entries: unknown[] = [];
	const idle = true;

	const pi = {
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, definition);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendUserMessage: messages,
	} as unknown as ExtensionAPI;

	const ctx = {
		isIdle: () => idle,
		ui: { notify },
		sessionManager: {
			getSessionId: () => "session-one",
			getSessionName: () => "Session Alpha",
			getBranch: () => entries,
			buildContextEntries: () => entries,
		},
	} as unknown as ExtensionContext;

	const portStart = takePort();
	registerTalk(pi, { openBrowser: opened, portStart, portAttempts: 20, closeDelayMs: 30 });
	const definition = commands.get(TALK_COMMAND);
	if (!definition) throw new Error("ask-talk was not registered");

	const result: Harness = {
		command: (args = "") => definition.handler(args, ctx),
		ctx,
		get entries() {
			return entries;
		},
		setReply: (text) => {
			entries = [
				{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "q" }] } },
				assistant(text),
			];
		},
		opened,
		messages,
		notify,
		shutdown: () => {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
		},
		start: (sessionId = "session-one") => {
			(ctx.sessionManager as unknown as { getSessionId: () => string }).getSessionId = () => sessionId;
			for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		},
	};
	result.setReply("## Alpha\n\nfirst reply");
	cleanups.push(result.shutdown);
	return result;
}

/** Use loopback even on WSL, where the opener URL advertises the LAN address. */
function localUrl(url: string, path: string): string {
	const parsed = new URL(url);
	parsed.hostname = "127.0.0.1";
	parsed.pathname = path;
	return parsed.toString();
}

async function state(url: string): Promise<{
	title?: string;
	items: Array<{ id: string; label: string }>;
	notes: Record<string, string>;
	draft: string;
	sent: boolean;
}> {
	const response = await fetch(localUrl(url, "/api/state"));
	expect(response.status).toBe(200);
	return (await response.json()) as Awaited<ReturnType<typeof state>>;
}

async function post(url: string, path: string, body: unknown): Promise<Response> {
	return fetch(localUrl(url, path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("ask-talk command", () => {
	it("refuses a running agent and a session with no reply", async () => {
		const h = harness();
		(h.ctx as unknown as { isIdle: () => boolean }).isIdle = () => false;
		await h.command();
		expect(h.opened).not.toHaveBeenCalled();
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("still running");

		(h.ctx as unknown as { isIdle: () => boolean }).isIdle = () => true;
		h.entries.length = 0;
		await h.command();
		expect(h.opened).not.toHaveBeenCalled();
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("no reply");
	});

	it("opens a snapshot, retains notes for the same reply, and closes with off", async () => {
		const h = harness();
		await h.command();
		const url = h.opened.mock.calls[0]?.[0] as string;
		const initial = await state(url);
		expect(initial.items.map((item) => item.label)).toEqual(["## Alpha", "first reply"]);

		await post(url, "/api/notes", { notes: { [initial.items[1].id]: "rename" }, draft: "draft" });
		await h.command();
		// The second run is an explicit "show me": it re-opens the same page (the
		// operator may have closed the tab) without rebuilding the snapshot.
		expect(h.opened).toHaveBeenCalledTimes(2);
		expect(h.opened.mock.calls[1]?.[0]).toBe(url);
		expect(await state(url)).toMatchObject({ notes: { [initial.items[1].id]: "rename" }, draft: "draft" });

		await h.command("off");
		expect((await fetch(localUrl(url, "/api/state")).catch(() => undefined))?.ok ?? false).toBe(false);
	});

	it("serves the NEW reply on the existing page and clears the old notes", async () => {
		const h = harness();
		await h.command();
		const url = h.opened.mock.calls[0]?.[0] as string;
		const before = await state(url);
		await post(url, "/api/notes", { notes: { [before.items[1].id]: "old note" }, draft: "old draft" });

		h.setReply("## Beta\n\nsecond reply");
		await h.command();

		const after = await state(url);
		expect(after.items.map((item) => item.label)).toEqual(["## Beta", "second reply"]);
		expect(after.notes).toEqual({});
		expect(after.draft).toBe("");
		// Same server, new content: the refresh is broadcast to the open tab AND the
		// window is opened again, so a closed tab comes back with the new reply.
		expect(h.opened).toHaveBeenCalledTimes(2);
		expect(h.opened.mock.calls[1]?.[0]).toBe(url);
	});

	it("titles the page with the session name, falling back to the first prompt", async () => {
		const h = harness();
		await h.command();
		const url = h.opened.mock.calls[0]?.[0] as string;
		expect((await state(url)).title).toBe("Session Alpha");

		// A session the host has not named yet: the first user message is what the
		// operator recognizes in a row of parallel windows.
		(h.ctx.sessionManager as unknown as { getSessionName: () => string | undefined }).getSessionName =
			() => undefined;
		h.setReply("## Gamma\n\nthird reply");
		await h.command();
		expect((await state(url)).title).toBe("q");
	});

	it("manual close sends nothing and the same snapshot can be reopened", async () => {
		const h = harness();
		await h.command();
		const url = h.opened.mock.calls[0]?.[0] as string;
		const response = await post(url, "/api/close", {});
		expect(response.status).toBe(200);
		expect(h.messages).not.toHaveBeenCalled();
		await vi.waitFor(async () => {
			expect((await fetch(localUrl(url, "/api/state")).catch(() => undefined))?.ok ?? false).toBe(false);
		});

		await h.command();
		expect(h.opened).toHaveBeenCalledTimes(2);
		expect(h.messages).not.toHaveBeenCalled();
		const reopened = h.opened.mock.calls[1]?.[0] as string;
		expect((await state(reopened)).items.map((item) => item.label)).toEqual(["## Alpha", "first reply"]);
	});

	it("sends notes for the CURRENT snapshot when Continue arrives", async () => {
		const h = harness();
		await h.command();
		const url = h.opened.mock.calls[0]?.[0] as string;
		h.setReply("## Beta\n\nsecond reply");
		await h.command();
		const current = await state(url);

		const response = await post(url, "/api/continue", {
			notes: { [current.items[1].id]: "change this" },
			message: "carry on",
		});
		expect(response.status).toBe(200);
		expect(h.messages).toHaveBeenCalledTimes(1);
		const message = h.messages.mock.calls[0]?.[0] as string;
		expect(message).toContain("### Beta");
		expect(message).toContain("> second reply");
		expect(message).toContain("- change this");
		expect(message).toContain("## Operator's message\n\ncarry on");
		expect(message).not.toContain("first reply");
	});

	it("rechecks context survival when Continue arrives, not only when the page opens", async () => {
		const h = harness();
		await h.command();
		const url = h.opened.mock.calls[0]?.[0] as string;
		const current = await state(url);
		(h.ctx.sessionManager as unknown as { buildContextEntries: () => unknown[] }).buildContextEntries = () => [];
		const response = await post(url, "/api/continue", {
			notes: { [current.items[1].id]: "still applies" },
			message: "",
		});
		expect(response.status).toBe(200);
		const message = h.messages.mock.calls[0]?.[0] as string;
		expect(message).toContain("## Your last reply (full text)");
		expect(message).toContain("## Alpha\n\nfirst reply");
	});

	it("drops the page when the session changes, but not on a duplicate start event", async () => {
		const h = harness();
		h.start();
		await h.command();
		const url = h.opened.mock.calls[0]?.[0] as string;
		h.start();
		expect((await state(url)).sent).toBe(false);
		h.start("session-two");
		expect((await fetch(localUrl(url, "/api/state")).catch(() => undefined))?.ok ?? false).toBe(false);
	});
});
