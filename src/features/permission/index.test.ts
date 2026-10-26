/**
 * `/ask-perm` integration over a captured gate and a mocked pi surface.
 *
 * The UI components are not rendered here (that needs a terminal); the
 * dialog contract is exercised through `AskRequest.present` with a host
 * selector, and the rest through the gate's verdicts and the command handler.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalLog, ApprovalRecord } from "../../lib/approval-log.js";
import type { AskDecision, GateHub, ToolGate } from "../../lib/gates.js";
import {
	clearJailedTool,
	markJailedTool,
	resetJailedTools,
} from "../../lib/tools.js";
import { markStartupCommand } from "../../lib/startup.js";
import { canonicalize } from "./paths.js";
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
	readonly entries: Array<{ type: string; data: unknown }>;
	readonly branch: Array<Record<string, unknown>>;
	setSessionId(id: string): void;
	evaluate(event: ToolCallEvent): Promise<unknown>;
	command(args: string): Promise<void>;
	sessionStart(): Promise<void>;
	banner(): { systemPrompt: string } | undefined;
}

function makeHarness(audit?: ApprovalLog): Harness {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-test-")));
	const statuses: Harness["statuses"] = [];
	const notes: Harness["notes"] = [];
	const entries: Harness["entries"] = [];
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
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI;

	registerPermission(pi, hub, { audit });
	const gate = captured[0];
	if (!gate || !commandHandler) throw new Error("permission did not register");

	return {
		cwd,
		ctx,
		gate,
		statuses,
		notes,
		entries,
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
		audit?: ApprovalRecord;
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
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).toBeUndefined();
	});

	it("enables from arguments, reports status, and asks for an outside write", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(h.statuses.at(-1)?.[0]).toBe("perm-mode");
		expect(h.statuses.at(-1)?.[1]).toContain("perm");
		const verdict = asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside")));
		expect(verdict.request.details.join("\n")).toContain("/var/pi-perm-outside");
		expect(verdict.request.root).toBe(canonicalize("/var"));
	});

	it("does not ask for a write under the OS temp root", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(
			await h.evaluate(bashEvent("echo hi > /tmp/pi-perm-temp.txt")),
		).toBeUndefined();
		// The same rule must cover the path-bearing write tool, not just bash.
		expect(
			await h.evaluate(pathEvent("write", "/tmp/pi-perm-temp.txt")),
		).toBeUndefined();
	});

	it("does not ask for a /dev/null sink operand", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(
			await h.evaluate(
				bashEvent("curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:5173/"),
			),
		).toBeUndefined();
	});

	it("does not ask for echo arguments that merely look like paths", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(
			await h.evaluate(
				bashEvent('echo "  $f  改动 $tot 行 / 忽略空白后 $w 行"'),
			),
		).toBeUndefined();
	});

	it("still asks before deleting a temp root itself", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /tmp"))).kind).toBe("ask");
	});

	it("blocks immediately when outside writes are denied", async () => {
		const h = makeHarness();
		await h.command("allow allow allow deny");
		const verdict = (await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))) as {
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
		const first = asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/x")));
		first.request.apply("allow-session");
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/y"))).toBeUndefined();
	});

	it("records a session deny and blocks later calls", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const first = asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/x")));
		first.request.apply("deny-session");
		const later = (await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/y"))) as {
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
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).toBeUndefined();
	});

	it("writes a startup notice as an entry instead of a status line", async () => {
		const h = makeHarness();
		markStartupCommand("ask-perm");
		await h.command("allow allow allow ask");
		expect(h.notes).toHaveLength(0);
		expect(h.entries).toHaveLength(1);
		expect((h.entries[0]?.data as { text: string }).text).toContain(
			"Permission ON",
		);
		expect(h.statuses.at(-1)?.[1]).toContain("perm");
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).kind).toBe(
			"ask",
		);
	});

	it("still reports an invalid argument from autostart", async () => {
		const h = makeHarness();
		markStartupCommand("ask-perm");
		await h.command("deny");
		expect(h.notes.at(-1)?.kind).toBe("error");
		expect(h.entries).toHaveLength(0);
	});

	it("keeps the mode off when the panel is cancelled", async () => {
		const h = makeHarness();
		await h.command("");
		expect(h.notes.at(-1)?.message).toContain("cancelled");
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).toBeUndefined();
	});

	it("rejects invalid arguments without enabling", async () => {
		const h = makeHarness();
		await h.command("deny");
		expect(h.notes.at(-1)?.kind).toBe("error");
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).toBeUndefined();
	});

	it("keeps the state when the same session emits session_start again", async () => {
		const h = makeHarness();
		await h.sessionStart(); // the real first emission
		await h.command("allow allow allow ask");
		// A startup rebind reports the same session again; state must survive.
		await h.sessionStart();
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).kind).toBe(
			"ask",
		);
	});

	it("resets on session_start for a different session", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		h.setSessionId("session-2");
		await h.sessionStart();
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).toBeUndefined();
	});

	it("resets on session_start", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		await h.sessionStart();
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside"))).toBeUndefined();
		expect(h.statuses.at(-1)?.[1]).toBeUndefined();
	});

	it("treats add-dir directories as inside the project", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-added/x"))).kind).toBe("ask");

		h.branch.push({
			type: "custom",
			customType: "add-dir:state",
			data: { dirs: [{ absolutePath: "/var/pi-perm-added" }] },
		});
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-added/x"))).toBeUndefined();
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
		expect(
			await h.evaluate(bashEvent("git -C /var/pi-perm-outside log")),
		).toBeUndefined();
		expect(
			asAsk(await h.evaluate(bashEvent("git -C /var/pi-perm-outside push"))).kind,
		).toBe("ask");
	});

	it("answers path-bearing tools by their own path", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		expect(await h.evaluate(pathEvent("write", "notes.txt"))).toBeUndefined();
		expect(asAsk(await h.evaluate(pathEvent("write", "/var/pi-perm-outside.txt"))).kind).toBe("ask");
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

		asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/x"))).request.apply(
			"allow-session",
		);
		await h.command("allow allow allow ask");
		expect(h.notes).toHaveLength(1);
		// The grant collected before the repeat is still in force.
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/y"))).toBeUndefined();
	});

	it("notifies and clears session grants when the modes actually change", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/x"))).request.apply(
			"allow-session",
		);
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/y"))).toBeUndefined();

		await h.command("ask allow allow ask");
		expect(h.notes).toHaveLength(2);
		expect(asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/y"))).kind).toBe("ask");
	});
});

describe("dialog contract", () => {
	it("fails closed without a UI", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const verdict = asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside")));
		const noUi = { ...h.ctx, hasUI: false } as ExtensionContext;
		await expect(verdict.request.present(noUi)).resolves.toBeUndefined();
	});

	it("falls back to the host selector in non-TUI modes", async () => {
		const h = makeHarness();
		await h.command("allow allow allow ask");
		const verdict = asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside")));
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

describe("session grants cover repeat asks", () => {	it("stops asking for a destructive in-project command once allowed", async () => {
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

describe("self-jailed tools", () => {
	beforeEach(() => {
		resetJailedTools();
	});

	it("skips the boundary check only while the owning feature marks the tool", async () => {
		const h = makeHarness();
		// Make the judgement observable: with in-project writes set to ask, an
		// unmarked pathless tool would raise a dialog.
		await h.command("ask ask ask ask");
		expect(asAsk(await h.evaluate(customEvent("scratchpad"))).kind).toBe("ask");

		markJailedTool("scratchpad");
		expect(await h.evaluate(customEvent("scratchpad"))).toBeUndefined();

		clearJailedTool("scratchpad");
		expect(asAsk(await h.evaluate(customEvent("scratchpad"))).kind).toBe("ask");
	});
});

describe("audit log", () => {
	function makeAudit(): { audit: ApprovalLog; records: ApprovalRecord[] } {
		const records: ApprovalRecord[] = [];
		return {
			records,
			audit: {
				dir: "/tmp/pi-perm-audit",
				mode: "interesting",
				active: true,
				append: (record) => records.push(record),
			},
		};
	}

	it("attaches the decomposition to an ask verdict", async () => {
		const { audit } = makeAudit();
		const h = makeHarness(audit);
		await h.command("allow allow allow ask");
		const verdict = asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/x")));
		expect(verdict.request.audit).toMatchObject({
			modes: { outWrite: "ask" },
			verdict: {
				action: "ask",
				layer: "mode",
				target: "/var/pi-perm-outside/x",
				scope: "out",
			},
		});
		expect(
			(verdict.request.audit?.units as Array<Record<string, unknown>>)[0],
		).toMatchObject({
			command: "rm",
			opaque: false,
			action: "ask",
			layer: "mode",
		});
	});

	it("attaches the deciding layer to a deny verdict", async () => {
		const { audit } = makeAudit();
		const h = makeHarness(audit);
		await h.command("allow allow allow ask");
		const verdict = (await h.evaluate(
			bashEvent(`cat ${homedir()}/.ssh/id_rsa`),
		)) as {
			kind: "block";
			reason: string;
			audit?: ApprovalRecord;
		};
		expect(verdict.kind).toBe("block");
		expect(verdict.audit?.verdict).toMatchObject({
			action: "deny",
			layer: "secret",
		});
	});

	it("records mode changes with their source", async () => {
		const { audit, records } = makeAudit();
		const h = makeHarness(audit);
		await h.command("allow allow allow ask");
		expect(records.at(-1)).toMatchObject({
			event: "mode",
			enabled: true,
			source: "args",
			via: "manual",
			modes: { inRead: "allow", outWrite: "ask" },
		});
		await h.command("");
		expect(records.at(-1)).toMatchObject({
			event: "mode",
			enabled: false,
			source: "toggle",
		});
	});

	it("marks an autostart-dispatched mode change", async () => {
		const { audit, records } = makeAudit();
		const h = makeHarness(audit);
		markStartupCommand("ask-perm");
		await h.command("allow allow allow ask");
		expect(records.at(-1)).toMatchObject({
			event: "mode",
			via: "autostart",
		});
	});
});

describe("audit log — session-grant allows", () => {
	function makeAudit(): { audit: ApprovalLog; records: ApprovalRecord[] } {
		const records: ApprovalRecord[] = [];
		return {
			records,
			audit: {
				dir: "/tmp/pi-perm-audit",
				mode: "interesting",
				active: true,
				append: (record) => records.push(record),
			},
		};
	}

	it("records the repeat call a directory grant made free", async () => {
		const { audit, records } = makeAudit();
		const h = makeHarness(audit);
		await h.command("allow allow allow ask");
		const first = asAsk(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/x")));
		first.request.apply("allow-session");
		expect(await h.evaluate(bashEvent("rm -rf /var/pi-perm-outside/y"))).toBeUndefined();

		const allow = records.find((record) => record.event === "allow");
		expect(allow).toMatchObject({
			event: "allow",
			verdict: { action: "allow", layer: "session-allow", scope: "out" },
		});
	});

	it("records a program-level grant on an opaque command too", async () => {
		const { audit, records } = makeAudit();
		const h = makeHarness(audit);
		await h.command("allow allow allow ask");
		const command = 'cd "$DIR" && rm x';
		const first = asAsk(await h.evaluate(bashEvent(command)));
		first.request.apply("allow-session");
		expect(await h.evaluate(bashEvent(command))).toBeUndefined();

		const allow = records.find((record) => record.event === "allow");
		expect(allow).toMatchObject({
			event: "allow",
			verdict: { action: "allow", layer: "session-command", grantScope: "command" },
		});
	});
});
