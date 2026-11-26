import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { parseBlocks } from "../review-page/blocks.js";
import { renderBlockHtml } from "../review-page/render.js";
import { buildTalkState, sanitizeNotes, startTalkServer, type TalkServerHandle, type TalkSession } from "./server.js";

/**
 * Distinct port per server, never reused inside this file.
 *
 * The HTTP clients keep connections alive, and those pools are keyed by port:
 * handing a new test a port whose previous server has just closed gives its
 * first request a dead socket ("socket hang up"). A counter is also immune to
 * the birthday collisions a narrow random range produces once the whole suite
 * runs under the 4-way compatibility matrix.
 */
let nextPort = 45_001;
function takePort(): number {
	nextPort += 3;
	return nextPort;
}

const REPLY = "## Approach\n\nfirst block\n\n## Milestones\n\nsecond block";

function makeSession(overrides: Partial<TalkSession> = {}): TalkSession {
	const blocks = parseBlocks(REPLY);
	return {
		text: REPLY,
		blocks,
		headings: [],
		model: "provider/model",
		at: "2026-11-25T00:00:00.000Z",
		entryId: "reply-entry",
		fingerprint: "abc",
		notes: {},
		draft: "",
		sent: false,
		inContext: true,
		...overrides,
	};
}

async function serve(
	session: TalkSession,
	overrides: Partial<Parameters<typeof startTalkServer>[0]> = {},
): Promise<TalkServerHandle> {
	return startTalkServer({
		session,
		assetsDir: "/nonexistent-assets",
		render: renderBlockHtml,
		portStart: takePort(),
		portAttempts: 20,
		bindHost: "127.0.0.1",
		urlHost: "127.0.0.1",
		closeDelayMs: 0,
		...overrides,
	});
}

interface CallResult {
	status: number;
	text: string;
	json: () => unknown;
}

function call(
	port: number,
	path: string,
	options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<CallResult> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { ...(options.headers ?? {}) };
		if (options.token) headers["x-plan-token"] = options.token;
		if (options.body !== undefined) headers["content-type"] = "application/json";
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path,
				headers,
				// Fresh socket per call: pooled sockets outlive the server that opened
				// them, and reusing one turns the next request into ECONNRESET.
				agent: false,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) as unknown });
				});
			},
		);
		req.on("error", reject);
		if (options.body !== undefined) req.write(JSON.stringify(options.body));
		req.end();
	});
}

describe("buildTalkState", () => {
	it("describes the snapshot without any version or diff fields", () => {
		const session = makeSession({ title: "Parallel session A" });
		const state = buildTalkState(session);
		expect(state.mode).toBe("talk");
		expect(state.title).toBe("Parallel session A");
		expect(state.reply).toEqual({ model: "provider/model", at: "2026-11-25T00:00:00.000Z", chars: REPLY.length });
		expect(state.items).toHaveLength(4);
		expect(state.items.every((item) => item.html === "")).toBe(true);
		expect(state).not.toHaveProperty("version");
		expect(state).not.toHaveProperty("history");
		expect(state.sent).toBe(false);
	});
});

describe("sanitizeNotes", () => {
	it("keeps only non-heading notes on blocks of this reply, with real text", () => {
		const blocks = parseBlocks(REPLY);
		const notes = sanitizeNotes(
			{ [blocks[0].id]: "heading notes are not allowed", [blocks[1].id]: "keep", "stale#0": "drop", [blocks[2].id]: "   ", [blocks[3].id]: 42 },
			blocks,
		);
		expect(notes).toEqual({ [blocks[1].id]: "keep" });
	});
});

describe("talk server", () => {
	it("serves state with rendered blocks and the headings index", async () => {
		const session = makeSession();
		const server = await serve(session);
		try {
			const response = await call(server.port, `/api/state?t=${server.token}`);
			expect(response.status).toBe(200);
			const state = response.json() as {
				mode: string;
				items: Array<{ html: string }>;
				headings: unknown[];
				sent: boolean;
			};
			expect(state.mode).toBe("talk");
			expect(state.items[0].html).toContain("<h2>");
			expect(Array.isArray(state.headings)).toBe(true);
			expect(state.sent).toBe(false);
		} finally {
			await server.close();
		}
	});

	it("stores notes and the draft so a page refresh does not lose them", async () => {
		const session = makeSession();
		const server = await serve(session);
		try {
			const blockId = session.blocks[1].id;
			const posted = await call(server.port, "/api/notes", {
				method: "POST",
				token: server.token,
				body: { notes: { [blockId]: "reword me" }, draft: "half-typed thought" },
			});
			expect(posted.status).toBe(200);
			expect(session.notes).toEqual({ [blockId]: "reword me" });
			const state = (await call(server.port, `/api/state?t=${server.token}`)).json() as {
				notes: Record<string, string>;
				draft: string;
			};
			expect(state.notes).toEqual({ [blockId]: "reword me" });
			expect(state.draft).toBe("half-typed thought");
		} finally {
			await server.close();
		}
	});

	it("accepts exactly one Continue and refuses every later write", async () => {
		const session = makeSession();
		const received: Array<{ notes: Record<string, string>; message: string }> = [];
		const server = await serve(session, {
			onContinue: (result) => received.push(result),
			// Keep the socket open long enough that the follow-up writes hit the
			// 409 guard instead of a closed port — that guard is what the test is about.
			closeDelayMs: 400,
		});
		try {
			const first = await call(server.port, "/api/continue", {
				method: "POST",
				token: server.token,
				body: { notes: { [session.blocks[3].id]: "fix it" }, message: "go on" },
			});
			expect(first.status).toBe(200);
			expect(received).toHaveLength(1);
			expect(received[0].message).toBe("go on");
			expect(server.active()).toBe(false);

			const second = await call(server.port, "/api/continue", {
				method: "POST",
				token: server.token,
				body: { message: "again" },
			});
			expect(second.status).toBe(409);
			const notes = await call(server.port, "/api/notes", {
				method: "POST",
				token: server.token,
				body: { notes: {} },
			});
			expect(notes.status).toBe(409);
			expect(received).toHaveLength(1);
			expect(session.sent).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("refuses unauthenticated and cross-origin writes like the spec server", async () => {
		const server = await serve(makeSession());
		try {
			expect((await call(server.port, "/api/state")).status).toBe(401);
			const crossOrigin = await call(server.port, "/api/notes", {
				method: "POST",
				token: server.token,
				body: { notes: {} },
				headers: { origin: "http://evil.example" },
			});
			expect(crossOrigin.status).toBe(403);
		} finally {
			await server.close();
		}
	});

	it("broadcasts sent once so an open page can switch to the sent state", async () => {
		const server = await serve(makeSession());
		const seen: string[] = [];
		try {
			const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
				const req = request(
					{ host: "127.0.0.1", port: server.port, path: `/api/events?t=${server.token}` },
					(res) => {
						const chunks: string[] = [];
						res.on("data", (chunk: Buffer) => {
							chunks.push(chunk.toString());
							const text = chunks.join("");
							if (!text.includes("event: sent")) {
								if (text.includes(": connected")) {
									void call(server.port, "/api/continue", {
										method: "POST",
										token: server.token,
										body: { message: "go" },
									});
								}
								return;
							}
							req.destroy();
							for (const line of text.split("\n")) if (line.startsWith("event: ")) seen.push(line.slice(7));
							resolve({ status: res.statusCode ?? 0, text });
						});
					},
				);
				req.on("error", (error) => {
					if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return;
					reject(error);
				});
				req.end();
			});
			expect(response.status).toBe(200);
			expect(seen).toContain("sent");
		} finally {
			await server.close();
		}
	});

	it("closes manually without sending Continue or changing the snapshot", async () => {
		const session = makeSession({ draft: "unsent draft" });
		const onContinue = vi.fn();
		const onNotes = vi.fn();
		const server = await serve(session, { onContinue, onNotes });
		const response = await call(server.port, "/api/close", { method: "POST", token: server.token });
		expect(response.status).toBe(200);
		expect(response.json()).toEqual({ ok: true });
		expect(server.active()).toBe(false);
		expect(session.sent).toBe(false);
		expect(session.draft).toBe("unsent draft");
		expect(onContinue).not.toHaveBeenCalled();
		expect(onNotes).not.toHaveBeenCalled();
		await vi.waitFor(async () => {
			await expect(call(server.port, "/api/state", { token: server.token })).rejects.toThrow();
		});
	});
});
