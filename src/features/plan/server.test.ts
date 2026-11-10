import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseBlocks } from "./blocks.js";
import { renderBlockHtml } from "./render.js";
import { buildPlanState, normalizeAnnotations, startPlanServer, type PlanServerHandle } from "./server.js";
import { appendPlanVersion, createPlanSession, type PlanSession } from "./store.js";

let agentDir: string;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-plan-server-"));
});

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function makeSession(text = "## Plan\n\nfirst step"): PlanSession {
	return createPlanSession({
		agentDir,
		slug: `srv-${Math.random().toString(36).slice(2, 8)}`,
		text,
		source: "specs/x.md",
	});
}

async function serve(
	session: PlanSession,
	overrides: Partial<Parameters<typeof startPlanServer>[0]> = {},
): Promise<PlanServerHandle> {
	return startPlanServer({
		session,
		assetsDir: join(agentDir, "no-assets"),
		render: renderBlockHtml,
		portStart: 42_000 + Math.floor(Math.random() * 2000),
		portAttempts: 20,
		bindHost: "127.0.0.1",
		urlHost: "127.0.0.1",
		closeDelayMs: 0,
		...overrides,
	});
}

interface CallOptions {
	port: number;
	path: string;
	method?: string;
	token?: string;
	headers?: Record<string, string>;
	body?: unknown;
}

interface CallResult {
	status: number;
	text: string;
	json: () => unknown;
}

/** Talk to the review server the way the page does (plain node:http, no client lib). */
async function call(options: CallOptions): Promise<CallResult> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: options.port,
				method: options.method ?? "GET",
				path: options.path,
				headers: {
					...(options.token ? { "x-plan-token": options.token } : {}),
					...(options.body !== undefined ? { "content-type": "application/json" } : {}),
					...options.headers,
				},
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

/** Collect SSE chunks until a marker shows up (or the test times out). */
function openStream(port: number, path: string): {
	until: (marker: string) => Promise<string>;
	close: () => void;
} {
	const chunks: Buffer[] = [];
	let notify: (() => void) | undefined;
	const req = request({ host: "127.0.0.1", port, path }, (res) => {
		res.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			notify?.();
		});
	});
	req.end();
	return {
		async until(marker: string): Promise<string> {
			for (;;) {
				const text = Buffer.concat(chunks).toString("utf8");
				if (text.includes(marker)) return text;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
				notify = undefined;
			}
		},
		close: () => req.destroy(),
	};
}

describe("buildPlanState", () => {
	it("shows no badges for the first revision", () => {
		const session = makeSession("## Plan\n\none\n\ntwo");
		const state = buildPlanState(session);
		expect(state.items.map((item) => item.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
		expect(state.totalVersions).toBe(1);
	});

	it("carries the diff statuses and the previous-block ids for a later revision", () => {
		const session = makeSession("## Plan\n\nwrite the block parser before the server\n\nsecond step");
		const first = session.versions[0];
		appendPlanVersion(session, {
			text: "## Plan\n\nwrite the block parser before the HTTP server\n\nsecond step\n\nthird step",
		});
		const state = buildPlanState(session);
		expect(state.version).toBe(2);
		expect(state.items.map((item) => item.status)).toEqual([
			"unchanged",
			"modified",
			"unchanged",
			"added",
		]);
		expect(state.items[1].prevId).toBe(first.blocks[1].id);
		expect(state.history.map((entry) => entry.n)).toEqual([2, 1]);
	});

	it("refuses an unknown revision", () => {
		const session = makeSession();
		expect(() => buildPlanState(session, 9)).toThrow(/no plan revision 9/);
	});
});

describe("normalizeAnnotations", () => {
	it("keeps well-formed annotations and drops the rest", () => {
		const normalized = normalizeAnnotations({
			global: [
				{ verdict: "change", comment: "fix scope" },
				{ verdict: "unknown", comment: "nope" },
				{ verdict: "suggest", comment: "   " },
			],
			blocks: [
				{ blockId: "abc#0", annotations: [{ verdict: "question", comment: "why?" }] },
				{ blockId: "", annotations: [{ verdict: "change", comment: "orphan" }] },
				{ blockId: "def#0", annotations: [] },
			],
		});
		expect(normalized.global).toEqual([{ verdict: "change", comment: "fix scope" }]);
		expect(normalized.blocks).toEqual([
			{ blockId: "abc#0", annotations: [{ verdict: "question", comment: "why?" }] },
		]);
	});

	it("treats a missing body as no annotations", () => {
		expect(normalizeAnnotations(undefined)).toEqual({ global: [], blocks: [] });
	});
});

describe("startPlanServer", () => {
	it("serves the fallback page and refuses a missing token", async () => {
		const session = makeSession();
		const server = await serve(session);
		try {
			expect((await call({ port: server.port, path: "/" })).status).toBe(401);

			const page = await call({ port: server.port, path: `/?t=${server.token}` });
			expect(page.status).toBe(200);
			expect(page.text).toContain("The review UI is not built");

			expect((await call({ port: server.port, path: "/api/state" })).status).toBe(401);
		} finally {
			await server.close();
		}
	});

	it("serves state with rendered block html", async () => {
		const session = makeSession("## Plan\n\nuse **bold** here");
		const server = await serve(session);
		try {
			const response = await call({ port: server.port, path: `/api/state?t=${server.token}` });
			expect(response.status).toBe(200);
			const state = response.json() as { items: Array<{ html: string }> };
			expect(state.items[0].html).toBe("<h2>Plan</h2>");
			expect(state.items[1].html).toContain("<strong>bold</strong>");
		} finally {
			await server.close();
		}
	});

	it("persists annotations posted by the page", async () => {
		const session = makeSession();
		const server = await serve(session);
		try {
			const response = await call({
				port: server.port,
				path: "/api/annotate",
				method: "POST",
				token: server.token,
				body: {
					version: 1,
					annotations: { global: [{ verdict: "change", comment: "tighten it" }], blocks: [] },
				},
			});
			expect(response.status).toBe(200);
			expect(session.versions[0].annotations.global[0].comment).toBe("tighten it");
		} finally {
			await server.close();
		}
	});

	it("records the decision, notifies the caller and closes the port", async () => {
		const session = makeSession();
		const onDecision = vi.fn();
		const server = await serve(session, { onDecision });
		const response = await call({
			port: server.port,
			path: "/api/decide",
			method: "POST",
			token: server.token,
			body: { action: "approve" },
		});
		expect(response.status).toBe(200);
		expect(response.json()).toEqual({ ok: true, action: "approve", version: 1 });
		await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith({ action: "approve", version: 1 }));
		expect(session.versions[0].decision?.action).toBe("approve");
		await vi.waitFor(async () => {
			await expect(call({ port: server.port, path: "/api/state" })).rejects.toThrow();
		});
	});

	it("rejects a decision that is neither approve nor deny", async () => {
		const session = makeSession();
		const server = await serve(session);
		try {
			const response = await call({
				port: server.port,
				path: "/api/decide",
				method: "POST",
				token: server.token,
				body: { action: "maybe" },
			});
			expect(response.status).toBe(400);
		} finally {
			await server.close();
		}
	});

	it("refuses a foreign Host header and a cross-origin write", async () => {
		const session = makeSession();
		const server = await serve(session);
		try {
			const badHost = await call({
				port: server.port,
				path: `/api/state?t=${server.token}`,
				headers: { Host: "evil.example:80" },
			});
			expect(badHost.status).toBe(400);

			const crossOrigin = await call({
				port: server.port,
				path: "/api/annotate",
				method: "POST",
				token: server.token,
				headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" },
				body: { annotations: { global: [], blocks: [] } },
			});
			expect(crossOrigin.status).toBe(403);
		} finally {
			await server.close();
		}
	});

	it("streams revisions over SSE", async () => {
		const session = makeSession("one");
		const server = await serve(session);
		const stream = openStream(server.port, `/api/events?t=${server.token}`);
		try {
			expect(await stream.until(": connected")).toContain(": connected");
			appendPlanVersion(session, { text: "two" });
			expect(parseBlocks("two")).toHaveLength(1);
			server.broadcast("revision", { version: 2 });
			expect(await stream.until("event: revision")).toContain('"version":2');
		} finally {
			stream.close();
			await server.close();
		}
	});
});
