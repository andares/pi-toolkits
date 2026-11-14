/**
 * ask-uat wiring: command, clustering tool, page server, toggle round-trip.
 *
 * The server is real (a checkbox write is only proven by an HTTP round-trip),
 * the browser opener is a fake, and the project root is injected so the test
 * never shells out to git.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setAskControl } from "../../lib/ask-control.js";
import { registerUat, uatSummary } from "./index.js";
import { RECORD_CHANGE_TOOL, UAT_COMMAND, UAT_ITEM_TOOL } from "./constants.js";
import { createRecord, isoMinute } from "./records.js";

/**
 * Every timestamp in this file is derived from this one date. Headers carry the
 * machine's UTC offset, so writing the offset out by hand makes the assertion
 * pass only in the author's timezone (CI is UTC and caught exactly that).
 */
const fixedNow = new Date(2026, 10, 13, 21, 7);

let root: string;
let sessionId = "s-1";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "uat-index-"));
	sessionId = `s-${Math.random().toString(36).slice(2, 8)}`;
	mkdirSync(join(root, ".agents/framework"), { recursive: true });
	writeFileSync(join(root, ".agents/framework/state.toml"), 'version = 1\ntool = "test"\n', "utf8");
	writeFileSync(join(root, "AGENTS.md"), "# demo\n", "utf8");
	mkdirSync(join(root, ".agents/memory"), { recursive: true });
	writeFileSync(join(root, ".agents/memory/README.md"), "# contract\n", "utf8");
	mkdirSync(join(root, ".agents/implementations"), { recursive: true });
});

afterEach(() => {
	setAskControl(undefined);
	rmSync(root, { recursive: true, force: true });
});

interface Harness {
	pi: ExtensionAPI;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	tools: Map<
		string,
		{ execute: (id: string, params: Record<string, unknown>, a?: unknown, b?: unknown, ctx?: ExtensionContext) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }> }
	>;
	handlers: Record<string, Array<(event: { systemPrompt: string }, ctx?: ExtensionContext) => unknown>>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	openBrowser: ReturnType<typeof vi.fn>;
	activeTools: () => string[];
	ctx: ExtensionContext;
	shutdown: () => void;
}

function harness(): Harness {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const tools = new Map<string, never>();
	const handlers: Harness["handlers"] = {};
	let activeTools = ["read", "grep", "bash", "write", "edit"];
	const sendUserMessage = vi.fn();
	const pi = {
		registerCommand: (name: string, def: never) => commands.set(name, def),
		registerTool: (def: { name: string }) => tools.set(def.name, def as never),
		on: (type: string, handler: never) => {
			handlers[type] = [...(handlers[type] ?? []), handler];
		},
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	const notify = vi.fn();
	const ctx = {
		cwd: root,
		hasUI: true,
		isIdle: () => true,
		ui: { notify },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
	const openBrowser = vi.fn();
	registerUat(pi, {
		openBrowser,
		root: (cwd) => cwd,
		now: () => fixedNow,
		portStart: 47_000 + Math.floor(Math.random() * 800),
		idleCloseMs: 0,
	});
	return {
		pi,
		commands,
		tools: tools as unknown as Harness["tools"],
		handlers,
		sendUserMessage,
		notify,
		openBrowser,
		activeTools: () => activeTools,
		ctx,
		shutdown: () => {
			for (const handler of handlers.session_shutdown ?? []) handler({ systemPrompt: "" });
		},
	};
}

/** POST JSON the way the page does. */
async function post(url: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
	const parsed = new URL(url);
	const token = parsed.searchParams.get("t") ?? "";
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: Number(parsed.port),
				path,
				method: "POST",
				headers: { "content-type": "application/json", "x-plan-token": token },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.write(JSON.stringify(body));
		req.end();
	});
}

async function get(url: string, path: string): Promise<any> {
	const parsed = new URL(url);
	const token = parsed.searchParams.get("t") ?? "";
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: Number(parsed.port),
				path,
				method: "GET",
				headers: { "x-plan-token": token },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("ask-uat command", () => {
	it("refuses a project without the framework", async () => {
		rmSync(join(root, ".agents/framework"), { recursive: true, force: true });
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("run /ask-init first"), "error");
		expect(h.openBrowser).not.toHaveBeenCalled();
	});

	it("refuses a half-installed framework and names the missing piece", async () => {
		rmSync(join(root, ".agents/memory/README.md"));
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(h.notify).toHaveBeenCalledWith(
			expect.stringContaining(".agents/memory/README.md"),
			"error",
		);
		expect(h.openBrowser).not.toHaveBeenCalled();
	});

	it("opens the page and dispatches clustering only when records are pending", async () => {
		createRecord(root, { title: "alpha change", body: "body", now: new Date(2026, 10, 12, 9, 0) });
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);

		expect(h.openBrowser).toHaveBeenCalledTimes(1);
		expect(h.activeTools()).toContain(UAT_ITEM_TOOL);
		expect(h.activeTools()).toContain(RECORD_CHANGE_TOOL);
		expect(h.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(h.sendUserMessage.mock.calls[0][0]).toContain("alpha change");

		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		expect(h.activeTools()).not.toContain(UAT_ITEM_TOOL);
		h.shutdown();
	});

	it("does not dispatch a turn when nothing is pending", async () => {
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(h.openBrowser).toHaveBeenCalledTimes(1);
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("0 pending"), "info");
		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		h.shutdown();
	});

	it("reopens the existing page instead of starting twice", async () => {
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		await h.commands.get(UAT_COMMAND)!.handler("open", h.ctx);
		expect(h.openBrowser).toHaveBeenCalledTimes(2);
		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		h.shutdown();
	});

	it("clusters newly pending records when the page is already open", async () => {
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		createRecord(root, { title: "later change", body: "body", now: new Date(2026, 10, 13, 20, 0) });
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(h.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("later change"));
		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		h.shutdown();
	});

	it("removes phase tools on a session switch", async () => {
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(h.activeTools()).toContain(UAT_ITEM_TOOL);
		sessionId = "another-session";
		for (const handler of h.handlers.session_start ?? []) handler({ systemPrompt: "" }, h.ctx);
		expect(h.activeTools()).not.toContain(UAT_ITEM_TOOL);
		expect(h.activeTools()).toContain(RECORD_CHANGE_TOOL);
		h.shutdown();
	});

	it("exits consult mode deliberately and refuses to start during planning", async () => {
		let consulting = true;
		setAskControl({ isActive: () => consulting, exit: () => { consulting = false; } });
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(consulting).toBe(false);
		expect(h.openBrowser).toHaveBeenCalledTimes(1);
		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);

		h.pi.setActiveTools([...h.activeTools(), "plan_submit"]);
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("finish or approve the plan"), "warning");
		expect(h.openBrowser).toHaveBeenCalledTimes(1);
		h.shutdown();
	});

	it("keeps record_change out of read-only consult and planning phases", async () => {
		setAskControl({ isActive: () => true, exit: () => {} });
		const h = harness();
		for (const handler of h.handlers.before_agent_start ?? []) handler({ systemPrompt: "base" }, h.ctx);
		expect(h.activeTools()).not.toContain(RECORD_CHANGE_TOOL);
		const result = await h.tools.get(RECORD_CHANGE_TOOL)!.execute(
			"t",
			{ title: "forbidden", body: "body", behavior: "must not write" },
			undefined,
			undefined,
			h.ctx,
		);
		expect(result.isError).toBe(true);
		expect(existsSync(join(root, ".agents/implementations/2026-11-13_2107_forbidden.md"))).toBe(false);

		setAskControl(undefined);
		h.pi.setActiveTools([...h.activeTools(), "plan_submit"]);
		for (const handler of h.handlers.before_agent_start ?? []) handler({ systemPrompt: "base" }, h.ctx);
		expect(h.activeTools()).not.toContain(RECORD_CHANGE_TOOL);
		h.shutdown();
	});
});

describe("record_change", () => {
	it("writes the canonical record and the candidate event", async () => {
		const h = harness();
		const result = await h.tools.get(RECORD_CHANGE_TOOL)!.execute(
			"t",
			{
				title: "Ask UAT lands",
				body: "## What\n\nDone.",
				behavior: "The operator opens /ask-uat and sees pending items.",
				hint: "run /ask-uat, tick one item",
			},
			undefined,
			undefined,
			h.ctx,
		);
		const text = result.content[0].text;
		expect(text).toContain("registered it for acceptance");
		const file = join(root, ".agents/implementations/2026-11-13_2107_ask-uat-lands.md");
		expect(existsSync(file)).toBe(true);
		const content = readFileSync(file, "utf8");
		expect(content.split("\n")[0]).toBe(`# ${isoMinute(fixedNow)} — Ask UAT lands`);
		expect(readFileSync(join(root, ".agents/uat/ledger.jsonl"), "utf8")).toContain("candidate");
		h.shutdown();
	});

	it("refuses outside a framework project", async () => {
		rmSync(join(root, ".agents/framework"), { recursive: true, force: true });
		const h = harness();
		const result = await h.tools.get(RECORD_CHANGE_TOOL)!.execute(
			"t",
			{ title: "x", body: "y", behavior: "z" },
			undefined,
			undefined,
			h.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("/ask-init");
		h.shutdown();
	});
});

describe("page round-trip", () => {
	it("clusters an item, then accepts it through the API", async () => {
		const first = createRecord(root, {
			title: "alpha change",
			body: "body",
			now: new Date(2026, 10, 12, 9, 0),
		});
		const second = createRecord(root, {
			title: "beta change",
			body: "body",
			now: new Date(2026, 10, 12, 10, 0),
		});
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		const url = h.openBrowser.mock.calls[0][0] as string;

		const created = await h.tools.get(UAT_ITEM_TOOL)!.execute(
			"t",
			{
				op: "create",
				title: "One behaviour",
				summary: "The operator can do the thing.",
				steps: ["open it", "see it"],
				reports: [first.entry.id, second.entry.id],
			},
			undefined,
			undefined,
			h.ctx,
		);
		expect(created.content[0].text).toContain("Created U-");

		let state = await get(url, "/api/state");
		expect(state.items).toHaveLength(1);
		expect(state.pending).toHaveLength(0);
		expect(state.counts.open).toBe(1);

		const itemId = state.items[0].id;
		const toggled = await post(url, "/api/toggle", { item: itemId, checked: true });
		expect(toggled.status).toBe(200);
		expect(toggled.body.state.checked).toHaveLength(1);

		state = await get(url, "/api/state");
		expect(state.checked[0].id).toBe(itemId);
		expect(uatSummary(root).counts.checked).toBe(1);

		// Evidence is reachable from the page.
		const report = await get(url, `/api/report?id=${encodeURIComponent(first.entry.id)}`);
		expect(report.text).toContain("alpha change");

		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		h.shutdown();
	});

	it("rejects a toggle for an unknown item", async () => {
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		const url = h.openBrowser.mock.calls[0][0] as string;
		const response = await post(url, "/api/toggle", { item: "U-nope", checked: true });
		expect(response.status).toBe(404);
		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		h.shutdown();
	});

	it("rejects a malformed toggle instead of treating it as an uncheck", async () => {
		const first = createRecord(root, { title: "alpha", body: "body", now: new Date(2026, 10, 12, 9, 0) });
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		const url = h.openBrowser.mock.calls[0][0] as string;
		const created = await h.tools.get(UAT_ITEM_TOOL)!.execute(
			"t",
			{ op: "create", title: "One", summary: "Summary", reports: [first.entry.id] },
			undefined,
			undefined,
			h.ctx,
		);
		const itemId = (created.details as { item: string }).item;
		const response = await post(url, "/api/toggle", { item: itemId, checked: "yes" });
		expect(response.status).toBe(400);
		expect(uatSummary(root).items[0]?.checkedAt).toBeUndefined();
		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		h.shutdown();
	});

	it("gives same-minute same-title items distinct identities", async () => {
		const first = createRecord(root, { title: "alpha", body: "body", now: new Date(2026, 10, 12, 9, 0) });
		const second = createRecord(root, { title: "beta", body: "body", now: new Date(2026, 10, 12, 10, 0) });
		const h = harness();
		await h.commands.get(UAT_COMMAND)!.handler("", h.ctx);
		const params = (report: string) => ({ op: "create", title: "Same", summary: "Summary", reports: [report] });
		const one = await h.tools.get(UAT_ITEM_TOOL)!.execute("t", params(first.entry.id), undefined, undefined, h.ctx);
		const two = await h.tools.get(UAT_ITEM_TOOL)!.execute("t", params(second.entry.id), undefined, undefined, h.ctx);
		expect((one.details as { item: string }).item).not.toBe((two.details as { item: string }).item);
		expect(uatSummary(root).items).toHaveLength(2);
		await h.commands.get(UAT_COMMAND)!.handler("off", h.ctx);
		h.shutdown();
	});
});
