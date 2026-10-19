/**
 * ask mode over the gate bus.
 *
 * Covers the state machine (tool snapshot, scratch tool activation, jailed-tool
 * registration), the gate's verdicts, and the degradation path when the session
 * has no writable temp directory.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { GateHub, ToolGate } from "../../lib/gates.js";
import { isJailedTool, resetJailedTools } from "../../lib/tools.js";
import { ASK_SCRATCH_TOOL } from "./constants.js";
import { registerAsk } from "./index.js";

function event(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName,
		input,
	} as unknown as ToolCallEvent;
}

function tempBase(): string {
	return mkdtempSync(join(tmpdir(), "pi-ask-mode-"));
}

function makeHarness(options: { scratchBaseDir?: string } = {}) {
	const captured: ToolGate[] = [];
	const hub = {
		register(gate: ToolGate) {
			captured.push(gate);
		},
		handle: async () => undefined,
		install: () => {},
	} as unknown as GateHub;

	let activeTools = ["read", "write", "edit", "bash"];
	let commandHandler: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
	let registeredTool: { defaultActive?: boolean; name: string } | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: ExtensionContext) => unknown },
		) {
			if (name === "ask") commandHandler = options.handler;
		},
		registerTool(tool: { defaultActive?: boolean; name: string }) {
			registeredTool = tool;
		},
		getActiveTools: () => [...activeTools],
		getAllTools: () => [
			{ name: "grep" },
			{ name: "find" },
			{ name: "ls" },
			{ name: ASK_SCRATCH_TOOL },
		],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI;

	const statuses: Array<[string, string | undefined]> = [];
	const notes: Array<{ message: string; kind?: string }> = [];
	let sessionId = "session-1";
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string, kind?: string) => notes.push({ message, kind }),
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
			theme: { fg: (_color: string, text: string) => text },
		},
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;

	registerAsk(pi, hub, options);
	const gate = captured[0];
	if (!gate || !commandHandler) throw new Error("ask did not register");

	return {
		gate,
		ctx,
		notes,
		activeTools: () => activeTools,
		registeredTool: () => registeredTool,
		setSessionId: (id: string) => {
			sessionId = id;
		},
		sessionStart: async () => {
			await handlers.get("session_start")?.({ reason: "new" }, ctx);
		},
		toggle: async () => {
			await commandHandler?.("", ctx);
		},
		evaluate: async (toolName: string, input: Record<string, unknown> = {}) =>
			gate.evaluate(event(toolName, input), ctx),
		banner: () =>
			handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", systemPrompt: "base" },
				ctx,
			) as { systemPrompt: string } | undefined,
	};
}

beforeEach(() => {
	// The jail registry is module state; one test's mark must not leak into the next.
	resetJailedTools();
});

describe("ask gate", () => {
	it("has no opinion while ask mode is off", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		expect(await h.evaluate("write", { path: "x" })).toBeUndefined();
	});

	it("blocks confiscated tools and non-read-only bash while on", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.toggle();
		expect(await h.evaluate("write", { path: "x" })).toMatchObject({
			kind: "block",
		});
		expect(await h.evaluate("bash", { command: "rm -rf x" })).toMatchObject({
			kind: "block",
		});
		expect(await h.evaluate("bash", { command: "ls -la" })).toBeUndefined();
	});

	it("stops blocking after exiting", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.toggle();
		await h.toggle();
		expect(await h.evaluate("write", { path: "x" })).toBeUndefined();
	});
});

describe("ask tool set", () => {
	it("registers the scratch tool inactive", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		expect(h.registeredTool()?.name).toBe(ASK_SCRATCH_TOOL);
		expect(h.registeredTool()?.defaultActive).toBe(false);
	});

	it("activates scratchpad and marks it jailed only while on", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.toggle();
		expect(h.activeTools()).toContain(ASK_SCRATCH_TOOL);
		expect(isJailedTool(ASK_SCRATCH_TOOL)).toBe(true);

		await h.toggle();
		expect(h.activeTools()).not.toContain(ASK_SCRATCH_TOOL);
		expect(isJailedTool(ASK_SCRATCH_TOOL)).toBe(false);
	});

	it("restores the entry snapshot on exit", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.toggle();
		expect(h.activeTools()).not.toContain("write");
		await h.toggle();
		expect(h.activeTools()).toEqual(["read", "write", "edit", "bash"]);
	});

	it("adds the read-only helpers that were inactive", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.toggle();
		expect(h.activeTools()).toEqual(
			expect.arrayContaining(["grep", "find", "ls"]),
		);
	});
});

describe("ask scratch availability", () => {
	it("creates the scratch directory under the configured base", async () => {
		const base = tempBase();
		const h = makeHarness({ scratchBaseDir: base });
		await h.toggle();
		expect(h.notes.at(-1)?.message).toContain(resolve(base));
	});

	it("degrades to fully read-only when the temp dir is unusable", async () => {
		const base = tempBase();
		const file = join(base, "not-a-dir");
		writeFileSync(file, "x");
		const h = makeHarness({ scratchBaseDir: file });
		await h.toggle();

		expect(h.activeTools()).not.toContain(ASK_SCRATCH_TOOL);
		expect(isJailedTool(ASK_SCRATCH_TOOL)).toBe(false);
		expect(h.notes.at(-1)?.message).toContain("read-only");
		const warning = h.notes.find((note) => note.kind === "warning");
		expect(warning?.message).toContain("no scratch space");
		// Still a consult mode: the hard block is unchanged.
		expect(await h.evaluate("write", { path: "x" })).toMatchObject({
			kind: "block",
		});
		expect(h.banner()?.systemPrompt).not.toContain(ASK_SCRATCH_TOOL);
	});
});

describe("ask banner", () => {
	it("names the scratch channel while it exists", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.toggle();
		const banner = h.banner()?.systemPrompt ?? "";
		expect(banner).toContain("[ASK MODE]");
		expect(banner).toContain(ASK_SCRATCH_TOOL);
		expect(banner).toContain("/ask");
	});

	it("stays silent when the mode is off", () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		expect(h.banner()).toBeUndefined();
	});
});

describe("ask session rebinding", () => {
	it("rebinds the scratch directory when the session changes while on", async () => {
		const base = tempBase();
		const h = makeHarness({ scratchBaseDir: base });
		await h.toggle();
		const firstNotice = h.notes.at(-1)?.message ?? "";
		expect(firstNotice).toContain("notes go to");

		h.setSessionId("session-2");
		await h.sessionStart();

		const rebind = h.notes.at(-1)?.message ?? "";
		expect(rebind).toContain("notes now go to");
		// The two notices name different per-session directories.
		const firstRoot = firstNotice.match(/notes go to (.+)\. \//)?.[1];
		const reboundRoot = rebind.match(/notes now go to (.+)\./)?.[1];
		expect(firstRoot).toBeDefined();
		expect(reboundRoot).toBeDefined();
		expect(reboundRoot).not.toBe(firstRoot);
	});

	it("keeps the scratch directory on a repeated emission for the same session", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.toggle();
		const noteCount = h.notes.length;
		await h.sessionStart();
		expect(h.notes.length).toBe(noteCount);
	});

	it("does nothing while the mode is off", async () => {
		const h = makeHarness({ scratchBaseDir: tempBase() });
		await h.sessionStart();
		expect(h.notes).toHaveLength(0);
	});
});
