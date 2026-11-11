/**
 * ask-plan wiring: command, tool, gate, prompt, decision round-trip.
 *
 * The server is real here (it is the only way to prove the non-blocking submit
 * actually resolves into a message), the browser opener and the permission
 * control are fakes.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GateHub, GateVerdict } from "../../lib/gates.js";
import { setPermissionControl, type PermissionControl } from "../../lib/permission-control.js";
import { setAskControl } from "../../lib/ask-control.js";
import { registerPlan, PLAN_COMMAND, PLAN_SUBMIT_TOOL } from "./index.js";

let agentDir: string;
let workDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "plan-agent-"));
	workDir = mkdtempSync(join(tmpdir(), "plan-work-"));
});

afterEach(() => {
	setPermissionControl(undefined);
	setAskControl(undefined);
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
	handlers: Record<string, Array<(event: { systemPrompt: string }, ctx?: ExtensionContext) => { systemPrompt?: string } | undefined>>;
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
		on: (type: string, handler: (event: { systemPrompt: string }, ctx?: ExtensionContext) => { systemPrompt?: string } | undefined) => {
			handlers[type] = [...(handlers[type] ?? []), handler];
		},
		getActiveTools: () => activeTools,
		getAllTools: () => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "write" },
			{ name: "edit" },
			{ name: "ask_user_question" },
			// Registered does not mean callable: this tool is deliberately absent
			// from the active set, and approval must not recommend it.
			{ name: "record_change" },
		],
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
		closeDelayMs: 25,
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

describe("phase integration", () => {
	it("exits ask mode before enabling the broader planning tool surface", async () => {
		const h = harness();
		const exit = vi.fn();
		setAskControl({ isActive: () => true, exit });
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		expect(exit).toHaveBeenCalledWith(h.ctx);
		expect(h.activeTools()).toContain(PLAN_SUBMIT_TOOL);
	});

	it("does not overwrite a permission policy the operator changed mid-plan", async () => {
		const h = harness();
		const off = { enabled: false, modes: { inRead: "allow", inWrite: "allow", outRead: "allow", outWrite: "ask" } };
		const defaults = { enabled: true, modes: { inRead: "allow", inWrite: "allow", outRead: "allow", outWrite: "ask" } };
		const manual = { enabled: true, modes: { inRead: "ask", inWrite: "ask", outRead: "deny", outWrite: "deny" } };
		h.control.snapshot
			.mockReturnValueOnce(off as never)
			.mockReturnValueOnce(defaults as never)
			.mockReturnValueOnce(manual as never);
		const handler = h.commands.get(PLAN_COMMAND)!.handler;
		await handler("topic", h.ctx);
		await handler("off", h.ctx);
		expect(h.control.restore).not.toHaveBeenCalled();
		expect(h.control.disable).not.toHaveBeenCalled();
	});

	it("starts a fresh review session for the next plan after leaving", async () => {
		const h = harness();
		const handler = h.commands.get(PLAN_COMMAND)!.handler;
		await handler("first", h.ctx);
		writeSpec("specs/first.md", "# SPEC: first");
		const first = await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/first.md" });
		expect(first.content[0].text).toContain("Submitted v1 of 1");
		await handler("off", h.ctx);
		await handler("second", h.ctx);
		writeSpec("specs/second.md", "# SPEC: second");
		const second = await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/second.md" });
		expect(second.content[0].text).toContain("Submitted v1 of 1");
		expect(h.openBrowser).toHaveBeenCalledTimes(2);
	});

	it("drops plan state and closes the review when the pi session changes", async () => {
		const h = harness();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		writeSpec("specs/topic.md", "# SPEC: topic");
		await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/topic.md" });
		const nextCtx = {
			...h.ctx,
			sessionManager: { getSessionId: () => "next-session" },
		} as unknown as ExtensionContext;
		h.handlers.session_start![0]!({ systemPrompt: "" }, nextCtx);
		expect(h.activeTools()).not.toContain(PLAN_SUBMIT_TOOL);
		expect(h.control.restore).not.toHaveBeenCalled();
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
		expect(evaluate(write("/tmp/outside.md"))).toMatchObject({ kind: "block" });
		expect(evaluate(write("../outside.md"))).toMatchObject({ kind: "block" });
		symlinkSync(agentDir, join(workDir, "linked"), "dir");
		expect(evaluate(write("linked/escape.md"))).toMatchObject({ kind: "block" });
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

	it("refuses to submit non-markdown or out-of-workspace files", async () => {
		const h = harness();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		const tool = h.tools.get(PLAN_SUBMIT_TOOL)!;
		expect((await tool.execute("id", { path: "src/a.ts" })).content[0].text).toContain("inside the workspace");
		expect((await tool.execute("id", { path: "/tmp/outside.md" })).content[0].text).toContain("inside the workspace");
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
		// The approved revision is quoted back (the file may have changed since
		// the submit), and the model is told to track the work in the todo list.
		expect(message).toContain("### Approved plan (specs/topic.md)");
		expect(message).toContain("# SPEC: topic\n\nfirst step");
		expect(message).toContain("Record the implementation work in the todo list");
		expect(message).not.toContain("call `record_change`");
		expect(h.control.restore).toHaveBeenCalled();
		expect(h.activeTools()).not.toContain(PLAN_SUBMIT_TOOL);
	});

	it("drops a browser decision that arrives after plan mode was closed", async () => {
		const h = harness();
		const handler = h.commands.get(PLAN_COMMAND)!.handler;
		await handler("topic", h.ctx);
		writeSpec("specs/topic.md", "# SPEC: topic");
		await h.tools.get(PLAN_SUBMIT_TOOL)!.execute("id", { path: "specs/topic.md" });
		const url = h.openBrowser.mock.calls[0][0] as string;
		expect(await decide(url, "deny")).toBe(200);
		await handler("off", h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 100));
		// Only the kickoff was sent; the stale review cannot start another turn.
		expect(h.sendUserMessage).toHaveBeenCalledTimes(1);
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
		expect(injected?.systemPrompt).toContain("[ASK-PLAN — INTERVIEW]");
		expect(injected?.systemPrompt).toContain("ask in plain text");
	});

	it("names the question tool only when it is active", async () => {
		const h = harness();
		h.pi.setActiveTools([...h.activeTools(), "ask_user_question"]);
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		const injected = start(h, "base");
		expect(injected?.systemPrompt).toContain("`ask_user_question` is available");
	});
});

describe("plan write boundary", () => {
	it("blocks a bash write to a non-markdown project path", async () => {
		const h = harness();
		await h.commands.get(PLAN_COMMAND)!.handler("topic", h.ctx);
		const gate = h.gates.find((entry) => entry.name === "plan");
		expect(gate).toBeDefined();
		const evaluate = (command: string) =>
			gate!.evaluate({ toolName: "bash", input: { command } } as ToolCallEvent);

		expect(evaluate("echo x > src/a.ts")?.kind).toBe("block");
		expect(evaluate("cp a.ts b.ts")?.kind).toBe("block");
		expect(evaluate("echo x > specs/notes.md")).toBeUndefined();
		expect(evaluate("echo x > /tmp/scratch.txt")).toBeUndefined();
		expect(evaluate("ls src")).toBeUndefined();
	});
});

describe("model policy", () => {
	it("contains no model-switching call in production code", () => {
		const root = join(process.cwd(), "src", "features", "plan");
		for (const file of readdirSync(root)) {
			if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
			expect(readFileSync(join(root, file), "utf8"), file).not.toContain("setModel");
		}
	});
});
