/**
 * `/ask-perm` integration over a captured gate and a mocked pi surface.
 *
 * The UI components are not rendered here (that needs a terminal); the
 * dialog contract is exercised through `AskRequest.present` with a host
 * selector, and the rest through the gate's verdicts and the command handler.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { AskDecision, GateHub, ToolGate } from "../../lib/gates.js";
import { registerPermission } from "./index.js";

function bashEvent(command: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "bash",
		input: { command },
	} as unknown as ToolCallEvent;
}

function pathEvent(toolName: string, path: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName,
		input: { path },
	} as unknown as ToolCallEvent;
}

function customEvent(toolName: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName,
		input: {},
	} as unknown as ToolCallEvent;
}

interface Harness {
	readonly cwd: string;
	readonly ctx: ExtensionContext;
	readonly gate: ToolGate;
	readonly statuses: Array<[string, string | undefined]>;
	readonly notes: Array<{ message: string; kind?: string }>;
	readonly branch: Array<Record<string, unknown>>;
	setSessionId(id: string): void;
	evaluate(event: ToolCallEvent): Promise<unknown>;
	command(args: string): Promise<void>;
	sessionStart(): Promise<void>;
	banner(): { systemPrompt: string } | undefined;
}

function makeHarness(): Harness {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-test-")));
	const statuses: Harness["statuses"] = [];
	const notes: Harness["notes"] = [];
	const branch: Harness["branch"] = [];
	let sessionId = "session-1";
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string, kind?: string) => notes.push({ message, kind }),
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
			theme: { fg: (_color: string, text: string) => text },
			custom: async () => undefined,
			select: async () => undefined,
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;

	const captured: ToolGate[] = [];
	const hub = {
		register(gate: ToolGate) {
			captured.push(gate);
		},
		handle: async () => undefined,
		install: () => {},
	} as unknown as GateHub;

	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let commandHandler: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: ExtensionContext) => unknown },
		) {
			if (name === "ask-perm") commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerPermission(pi, hub);
	const gate = captured[0];
	if (!gate || !commandHandler) throw new Error("permission did not register");

	return {
		cwd,
		ctx,
		gate,
		statuses,
		notes,
		branch,
		setSessionId(id: string) {
			sessionId = id;
		},
		async evaluate(event) {
			return gate.evaluate(event, ctx);
		},
		async command(args) {
			await commandHandler?.(args, ctx);
		},
		async sessionStart() {
			await handlers.get("session_start")?.( { reason: "new" }, ctx);
		},
		banner() {
			return handlers.get("before_agent_start")?.(
				{ systemPrompt: "base", type: "before_agent_start" },
				ctx,
			) as { systemPrompt: string } | undefined;
		},
	};
}

interface AskVerdict {
	kind: "ask";
	request: {
		details: readonly string[];
		root: string;
		present(ctx: ExtensionContext): Promise<AskDecision | undefined>;
		apply(decision: AskDecision): void;
	};
}

function asAsk(verdict: unknown): AskVerdict {
	expect(verdict).toMatchObject({ kind: "ask" });
	return verdict as AskVerdict;
}

describe("/ask-perm", () => {
	it("is off by default", async () => {
		const h = makeHarness();
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside"))).toBeUndefined();
	});

	it("enables from arguments, reports status, and asks for an outside write", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(h.statuses.at(-1)?.[0]).toBe("perm-mode");
		expect(h.statuses.at(-1)?.[1]).toContain("perm");
		const verdict = asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside")));
		expect(verdict.request.details.join("\n")).toContain("/tmp/outside");
		expect(verdict.request.root).toBe("/tmp");
	});

	it("blocks immediately when outside writes are denied", async () => {
		const h = makeHarness();
		await h.command("allow allow allow deny");
		const verdict = (await h.evaluate(bashEvent("rm -rf /tmp/outside"))) as {
			kind: "block";
			reason: string;
		};
		expect(verdict.kind).toBe("block");
		expect(verdict.reason).toContain("Permission denied");
		expect(verdict.reason).toContain("outside-project write");
	});

	it("records a session grant and applies it to later calls", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const first = asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside/x")));
		first.request.apply("allow-session");
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside/y"))).toBeUndefined();
	});

	it("records a session deny and blocks later calls", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const first = asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside/x")));
		first.request.apply("deny-session");
		const later = (await h.evaluate(bashEvent("rm -rf /tmp/outside/y"))) as {
			kind: "block";
			reason: string;
		};
		expect(later.kind).toBe("block");
		expect(later.reason).toContain("denied for this session");
	});

	it("toggles off with no arguments and clears the status", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		await h.command("");
		expect(h.statuses.at(-1)?.[1]).toBeUndefined();
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside"))).toBeUndefined();
	});

	it("keeps the mode off when the panel is cancelled", async () => {
		const h = makeHarness();
		await h.command("");
		expect(h.notes.at(-1)?.message).toContain("cancelled");
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside"))).toBeUndefined();
	});

	it("rejects invalid arguments without enabling", async () => {
		const h = makeHarness();
		await h.command("deny");
		expect(h.notes.at(-1)?.kind).toBe("error");
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside"))).toBeUndefined();
	});

	it("keeps the state when the same session emits session_start again", async () => {
		const h = makeHarness();
		await h.sessionStart(); // the real first emission
		await h.command("allow allow allow ask");
		// A startup rebind reports the same session again; state must survive.
		await h.sessionStart();
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside"))).kind).toBe(
			"ask",
		);
	});

	it("resets on session_start for a different session", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		h.setSessionId("session-2");
		await h.sessionStart();
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside"))).toBeUndefined();
	});

	it("resets on session_start", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		await h.sessionStart();
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside"))).toBeUndefined();
		expect(h.statuses.at(-1)?.[1]).toBeUndefined();
	});

	it("treats add-dir directories as inside the project", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /tmp/added/x"))).kind).toBe("ask");

		h.branch.push({
			type: "custom",
			customType: "add-dir:state",
			data: { dirs: [{ absolutePath: "/tmp/added" }] },
		});
		expect(await h.evaluate(bashEvent("rm -rf /tmp/added/x"))).toBeUndefined();
	});

	it("treats a redirect write to a credential path as a fixed deny, not a write ask", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const verdict = (await h.evaluate(
			bashEvent("echo a > ~/.ssh/authorized_keys"),
		)) as { kind: "block"; reason: string };
		expect(verdict.kind).toBe("block");
		expect(verdict.reason).toContain("fixed safety table");
	});

	it("judges git -C by the -C directory, not the working directory", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(await h.evaluate(bashEvent("git -C ../outside log"))).toBeUndefined();
		expect(asAsk(await h.evaluate(bashEvent("git -C ../outside push"))).kind).toBe("ask");
	});

	it("answers path-bearing tools by their own path", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(await h.evaluate(pathEvent("write", "notes.txt"))).toBeUndefined();
		expect(asAsk(await h.evaluate(pathEvent("write", "/tmp/outside.txt"))).kind).toBe("ask");
		const denied = (await h.evaluate(pathEvent("read", "~/.ssh/id_rsa"))) as {
			kind: "block";
		};
		expect(denied.kind).toBe("block");
	});

	it("judges a pathless tool by the working directory", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(await h.evaluate(customEvent("mcp"))).toBeUndefined();
	});

	it("is idempotent: repeating the same command notifies once and keeps grants", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(h.notes).toHaveLength(1);

		asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside/x"))).request.apply(
			"allow-session",
		);
		await h.command("allow allow allow ask");
		expect(h.notes).toHaveLength(1);
		// The grant collected before the repeat is still in force.
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside/y"))).toBeUndefined();
	});

	it("notifies and clears session grants when the modes actually change", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside/x"))).request.apply(
			"allow-session",
		);
		expect(await h.evaluate(bashEvent("rm -rf /tmp/outside/y"))).toBeUndefined();

		await h.command("ask allow allow ask");
		expect(h.notes).toHaveLength(2);
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside/y"))).kind).toBe("ask");
	});
});

describe("dialog contract", () => {
	it("fails closed without a UI", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const verdict = asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside")));
		const noUi = { ...h.ctx, hasUI: false } as ExtensionContext;
		await expect(verdict.request.present(noUi)).resolves.toBeUndefined();
	});

	it("falls back to the host selector in non-TUI modes", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const verdict = asAsk(await h.evaluate(bashEvent("rm -rf /tmp/outside")));
		const rpc = {
			cwd: h.cwd,
			hasUI: true,
			mode: "rpc",
			ui: {
				select: async () => "Allow once (a)",
				theme: { fg: (_color: string, text: string) => text },
			},
		} as unknown as ExtensionContext;
		await expect(verdict.request.present(rpc)).resolves.toBe("allow");
	});
});

describe("model-facing banner", () => {
	it("appends the policy only while enabled", async () => {
		const h = makeHarness();
		expect(h.banner()).toBeUndefined();
		await h.command("allow allow allow ask");
		expect(h.banner()?.systemPrompt).toContain("Permission mode");
		expect(h.banner()?.systemPrompt).toContain("in allow/allow, out allow/ask");
	});
});

describe("session grants cover repeat asks", () => {
	it("stops asking for a destructive in-project command once allowed", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const first = asAsk(await h.evaluate(bashEvent("rm -rf .")));
		expect(first.request.details.join("\n")).toContain("recursive delete");
		first.request.apply("allow-session");
		expect(await h.evaluate(bashEvent("rm -rf ."))).toBeUndefined();
	});

	it("stops asking for the same opaque command once allowed", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const command = 'cd "$DIR" && rm x';
		const first = asAsk(await h.evaluate(bashEvent(command)));
		expect(first.request.details.join("\n")).toContain("this exact command");
		first.request.apply("allow-session");
		expect(await h.evaluate(bashEvent(command))).toBeUndefined();
	});
});
