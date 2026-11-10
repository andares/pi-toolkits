/**
 * ask-plan wiring: command, tool, gate, prompt, decision round-trip.
 *
 * The server is real here (it is the only way to prove the non-blocking submit
 * actually resolves into a message), the browser opener and the permission
 * control are fakes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GateHub, GateVerdict } from "../../lib/gates.js";
import { setPermissionControl, type PermissionControl } from "../../lib/permission-control.js";
import { registerPlan, PLAN_COMMAND, PLAN_SUBMIT_TOOL } from "./index.js";

let agentDir: string;
let workDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "plan-agent-"));
	workDir = mkdtempSync(join(tmpdir(), "plan-work-"));
});

afterEach(() => {
	setPermissionControl(undefined);
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

/** Write a file inside the temp work dir, creating its parents. */
function writeSpec(relativePath: string, text: string): void {
	const path = join(workDir, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

interface Harness {
	pi: ExtensionAPI;
	commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	tools: Map<string, { name: string; execute: (id: string, params: { path?: string }) => Promise<{ content: Array<{ text: string }>; details: unknown }> }>;
	handlers: Record<string, Array<(event: { systemPrompt: string }) => { systemPrompt?: string } | undefined>>;
	gates: Array<{ name: string; order?: number; evaluate: (event: ToolCallEvent) => GateVerdict | undefined }>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	activeTools: () => string[];
	openBrowser: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	ctx: ExtensionContext;
	control: { enableDefaults: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn> };
}

function harness(): Harness {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const tools = new Map<string, { name: string; execute: (id: string, params: { path?: string }) => Promise<{ content: Array<{ text: string }>; details: unknown }> }>();
	const gates: Harness["gates"] = [];
	const handlers: Harness["handlers"] = {};
	let activeTools = ["read", "grep", "bash", "write", "edit"];
	const sendUserMessage = vi.fn();
	const pi = {
		registerCommand: (name: string, def: never) => commands.set(name, def),
		registerTool: (def: { name: string } & { execute: unknown }) => {
			tools.set(def.name, def as never);
		},
		on: (type: string, handler: (event: { systemPrompt: string }) => { systemPrompt?: string } | undefined) => {
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
		cwd: workDir,
		hasUI: true,
		isIdle: () => true,
		ui: { notify },
	} as unknown as ExtensionContext;
	const openBrowser = vi.fn();
	const control = {
		snapshot: vi.fn(() => ({ enabled: false, modes: { inRead: "allow", inWrite: "allow", outRead: "allow", outWrite: "ask" } })),
		enableDefaults: vi.fn(),
		restore: vi.fn(),
		disable: vi.fn(),
	};
	setPermissionControl(control as unknown as PermissionControl);
	registerPlan(pi, { register: (def: never) => gates.push(def as never) } as unknown as GateHub, {
		agentDir,
		openBrowser,
		portStart: 46_000 + Math.floor(Math.random() * 1000),
	});
	return { pi, commands, tools, gates, handlers, sendUserMessage, activeTools: () => activeTools, openBrowser, notify, ctx, control };
}

/** Talk to the review server the way the page does. */
async function decide(url: string, action: "approve" | "deny"): Promise<number> {
	const parsed = new URL(url);
	const token = parsed.searchParams.get("t") ?? "";
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: Number(parsed.port),
				path: "/api/decide",
				method: "POST",
				headers: { "content-type": "application/json", "x-plan-token": token },
			},
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("error", reject);
		req.write(JSON.stringify({ action }));
		req.end();
	});
}

describe("ask-plan command", () => {
	it("enters plan mode: permission on, submit tool active, kickoff sent", async () => {
		const h = harness();
		const command = h.commands.get(PLAN_COMMAND);
		expect(command).toBeDefined();
		await command!.handler("ask-plan work", h.ctx);

		expect(h.control.enableDefaults).toHaveBeenCalledWith(h.ctx);
		expect(h.activeTools()).toContain(PLAN_SUBMIT_TOOL);
		expect(h.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Task: ask-plan work"));
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("specs/ask-plan-work.md"), "info");
	});

	it("refuses to start twice and can be turned off", async () => {
		const h = harness();
		const handler = h.commands.get(PLAN_COMMAND)!.handler;
		await handler("topic", h.ctx);
		await handler("topic", h.ctx);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("already planning"), "warning");

		await handler("off", h.ctx);
		expect(h.control.restore).toHaveBeenCalled();
		expect(h.activeTools()).not.toContain(PLAN_SUBMIT_TOOL);
	});
});

describe("plan gate", () => {
	const gate = (h: Harness) => h.gates.find((entry) => entry.name === "plan");

	it("blocks writing anything but markdown while planning", async () => {
		const h = harness();
		const evaluate = gate(h)!.evaluate;
		const write = (path: string): ToolCallEvent => ({ toolName: "write", input: { path } }) as unknown as ToolCallEvent;

		expect(evaluate(write("src/features/x.ts"))).toBeUndefined();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		expect(evaluate(write("src/features/x.ts"))).toMatchObject({ kind: "block" });
		expect(evaluate(write("specs/topic.md"))).toBeUndefined();
	});

	it("stays out of the way when plan mode is off", () => {
		const h = harness();
		const event = { toolName: "edit", input: { path: "src/a.ts" } } as unknown as ToolCallEvent;
		expect(gate(h)!.evaluate(event)).toBeUndefined();
	});
});

describe("plan_submit", () => {
	it("reads the file, snapshots a revision and opens the review once", async () => {
		const h = harness();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		writeSpec("specs/topic.md", "# SPEC: topic\n\nfirst step");
		const tool = h.tools.get(PLAN_SUBMIT_TOOL)!;

		const first = await tool.execute("id", { path: "specs/topic.md" });
		expect(first.content[0].text).toContain("Submitted v1 of 1");
		expect(h.openBrowser).toHaveBeenCalledTimes(1);

		writeSpec("specs/topic.md", "# SPEC: topic\n\nsecond step");
		const second = await tool.execute("id", { path: "specs/topic.md" });
		expect(second.content[0].text).toContain("Submitted v2 of 2");
		expect(h.openBrowser).toHaveBeenCalledTimes(1);
	});

	it("tells the model to write the file when it does not exist", async () => {
		const h = harness();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		const result = await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/missing.md" });
		expect(result.content[0].text).toContain("Write the spec file first");
	});

	it("refuses to submit outside plan mode", async () => {
		const h = harness();
		const result = await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/x.md" });
		expect(result.content[0].text).toContain("Plan mode is off");
	});

	it("turns an approval into a message and leaves the phase", async () => {
		const h = harness();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		writeSpec("specs/topic.md", "# SPEC: topic\n\nfirst step");
		await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/topic.md" });
		const url = h.openBrowser.mock.calls[0][0] as string;

		expect(await decide(url, "approve")).toBe(200);
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(2), { timeout: 5000 });
		const message = h.sendUserMessage.mock.calls[1][0] as string;
		expect(message).toContain("## Plan approved");
		expect(message).toContain("start implementing");
		expect(h.control.restore).toHaveBeenCalled();
		expect(h.activeTools()).not.toContain(PLAN_SUBMIT_TOOL);
	});

	it("turns a denial into feedback but keeps planning", async () => {
		const h = harness();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		writeSpec("specs/topic.md", "# SPEC: topic\n\nfirst step");
		await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/topic.md" });
		const url = h.openBrowser.mock.calls[0][0] as string;

		expect(await decide(url, "deny")).toBe(200);
		await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(2), { timeout: 5000 });
		const message = h.sendUserMessage.mock.calls[1][0] as string;
		expect(message).toContain("## Plan feedback");
		expect(message).toContain("No specific annotations were left");
		expect(h.activeTools()).toContain(PLAN_SUBMIT_TOOL);
		expect(h.control.restore).not.toHaveBeenCalled();
	});
});

describe("prompt injection", () => {
	const start = (h: Harness, prompt: string) => {
		const handler = h.handlers.before_agent_start?.[0];
		expect(handler).toBeDefined();
		return handler!({ systemPrompt: prompt });
	};

	it("appends the plan framework only while planning", async () => {
		const h = harness();
		expect(start(h, "base")).toBeUndefined();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		const injected = start(h, "base");
		expect(injected?.systemPrompt).toContain("base");
		expect(injected?.systemPrompt).toContain("[ASK-PLAN — PLANNING]");
		expect(injected?.systemPrompt).toContain("plan_submit");
	});
});
