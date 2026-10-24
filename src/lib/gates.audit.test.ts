/**
 * Gate-bus audit wiring: every ask settles into exactly one record, a block is
 * recorded with the feature's structured payload, a pending dialog that never
 * runs is still recorded, and session counters flush as one summary line.
 */
import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalLog, ApprovalRecord } from "./approval-log.js";
import {
	createGateHub,
	type AskDecision,
	type AskRequest,
	type ToolGate,
} from "./gates.js";

function fakeAudit(mode: ApprovalLog["mode"] = "interesting"): {
	records: ApprovalRecord[];
	log: ApprovalLog;
} {
	const records: ApprovalRecord[] = [];
	return {
		records,
		log: {
			dir: "/tmp/approval-log-test",
			mode,
			active: true,
			append: (record) => records.push(record),
		},
	};
}

function ctxFor(session: string): ExtensionContext {
	return {
		cwd: "/proj",
		model: { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => session },
	} as unknown as ExtensionContext;
}

function bashEvent(command = "rm -rf /tmp/x"): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "bash",
		input: { command },
	} as unknown as ToolCallEvent;
}

function askRequest(
	decide: AskDecision | undefined,
	settle?: AskRequest["settle"],
): AskRequest {
	return {
		title: "Permission required",
		details: ["Command: rm -rf /tmp/x"],
		root: "/tmp",
		audit: {
			prompt: ["Permission required", "Command: rm -rf /tmp/x"],
			verdict: { action: "ask", layer: "mode", target: "/tmp/x" },
		},
		present: async () => decide,
		apply: () => {},
		denyReason: (choice) => `denied:${choice}`,
		settle,
	};
}

function gate(
	name: string,
	order: number,
	verdict: ReturnType<ToolGate["evaluate"]>,
): ToolGate {
	return { name, order, evaluate: () => verdict };
}

describe("gate audit", () => {
	it("records an allowed ask with prompt, answer and grant", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register(
			gate("permission", 10, {
				kind: "ask",
				request: askRequest("allow-session", (choice, meta) => ({
					grant: {
						kind: choice === "allow-session" ? "allow" : "deny",
						scope: "root",
						root: "/tmp",
						msSeen: meta.ms,
					},
				})),
			}),
		);

		await expect(hub.handle(bashEvent(), ctxFor("s1"))).resolves.toBeUndefined();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			event: "ask",
			gate: "permission",
			session: "s1",
			tool: "bash",
			toolCall: "call-1",
			input: { command: "rm -rf /tmp/x" },
			verdict: { action: "ask", layer: "mode", target: "/tmp/x" },
			answer: { choice: "allow-session" },
			outcome: "allowed",
			grant: { kind: "allow", scope: "root", root: "/tmp" },
		});
	});

	it("records a denial answer", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register(
			gate("permission", 10, {
				kind: "ask",
				request: askRequest("deny-session"),
			}),
		);

		await expect(hub.handle(bashEvent(), ctxFor("s1"))).resolves.toEqual({
			reason: "denied:deny-session",
		});
		expect(records[0]).toMatchObject({
			event: "ask",
			answer: { choice: "deny-session" },
			outcome: "blocked",
		});
	});

	it("records a cancelled dialog as a denial with a null answer", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register(
			gate("permission", 10, {
				kind: "ask",
				request: askRequest(undefined),
			}),
		);

		const result = await hub.handle(bashEvent(), ctxFor("s1"));
		expect(result?.reason).toContain("was not answered");
		expect(records[0]).toMatchObject({
			event: "ask",
			answer: null,
			outcome: "cancelled",
		});
	});

	it("records a pending ask that a later block prevented from being shown", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register(
			gate("permission", 10, {
				kind: "ask",
				request: askRequest("allow"),
			}),
		);
		hub.register(gate("ask", 20, { kind: "block", reason: "ask mode" }));

		await expect(hub.handle(bashEvent(), ctxFor("s1"))).resolves.toEqual({
			reason: "ask mode",
		});
		const ask = records.find((record) => record.event === "ask");
		const block = records.find((record) => record.event === "block");
		expect(ask).toMatchObject({ outcome: "not-presented", answer: null });
		expect(block).toMatchObject({
			event: "block",
			gate: "ask",
			reason: "ask mode",
		});
	});

	it("records a gate failure as a block", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register({
			name: "broken",
			order: 10,
			evaluate: () => {
				throw new Error("boom");
			},
		});

		const result = await hub.handle(bashEvent(), ctxFor("s1"));
		expect(result?.reason).toContain("boom");
		expect(records[0]).toMatchObject({
			event: "block",
			gate: "broken",
			verdict: { action: "block", layer: "gate-error" },
		});
	});

	it("merges a block payload attached by the feature", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register(
			gate("permission", 10, {
				kind: "block",
				reason: "credentials — denied by the fixed safety table",
				audit: {
					units: [{ raw: "cat ~/.ssh/id_rsa", opaque: false }],
					verdict: { action: "deny", layer: "secret" },
					modes: { inRead: "allow" },
				},
			}),
		);

		await hub.handle(bashEvent("cat ~/.ssh/id_rsa"), ctxFor("s1"));
		expect(records[0]).toMatchObject({
			event: "block",
			gate: "permission",
			units: [{ raw: "cat ~/.ssh/id_rsa", opaque: false }],
			verdict: { action: "deny", layer: "secret" },
			modes: { inRead: "allow" },
		});
	});

	it("keeps per-session counters apart and flushes them on shutdown", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register(gate("noop", 10, undefined));
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		hub.install({
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI);

		// Two sessions interleaved in one process (parent + child) must not flush
		// each other's partial counters; each summary carries only its own numbers.
		await hub.handle(bashEvent(), ctxFor("s1"));
		await hub.handle(bashEvent(), ctxFor("s2"));
		await hub.handle(bashEvent(), ctxFor("s1"));
		await hub.handle(bashEvent(), ctxFor("s2"));
		expect(
			records.filter((record) => record.event === "session"),
		).toHaveLength(0);

		handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			ctxFor("s2"),
		);
		// Only the session being torn down is flushed; the other one keeps its
		// counters for its own shutdown instead of being cut in half.
		const summaries = records.filter((record) => record.event === "session");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			event: "session",
			session: "s2",
			reason: "quit",
			counts: { calls: 2 },
		});

		handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			ctxFor("s1"),
		);
		const bySession = new Map(
			records
				.filter((record) => record.event === "session")
				.map((record) => [record.session, record]),
		);
		expect(bySession.get("s1")).toMatchObject({
			event: "session",
			session: "s1",
			counts: { calls: 2 },
		});
	});

	it("records the queue wait separately from the answer time", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		const base = askRequest("allow");
		hub.register(
			gate("permission", 10, {
				kind: "ask",
				request: {
					...base,
					present: async () => {
						await new Promise((resolve) => setTimeout(resolve, 30));
						return "allow";
					},
				},
			}),
		);

		// Two calls from one assistant message: the second waits for the first.
		await Promise.all([
			hub.handle(bashEvent("a"), ctxFor("s1")),
			hub.handle(bashEvent("b"), ctxFor("s1")),
		]);
		const asks = records.filter((record) => record.event === "ask");
		expect(asks).toHaveLength(2);
		const second = asks[1]?.answer as { ms: number; queueMs: number };
		expect(second.queueMs).toBeGreaterThanOrEqual(25);
		expect(second.ms).toBeGreaterThanOrEqual(second.queueMs);
	});

	it("flushes the current session on shutdown", async () => {
		const { records, log } = fakeAudit();
		const hub = createGateHub({ audit: log });
		hub.register(gate("noop", 10, undefined));
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		hub.install({
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI);

		await hub.handle(bashEvent(), ctxFor("s1"));
		handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			ctxFor("s1"),
		);

		expect(
			records.find((record) => record.event === "session"),
		).toMatchObject({
			event: "session",
			session: "s1",
			reason: "quit",
			counts: { calls: 1 },
		});
	});

	it("writes nothing when the audit mode is off", async () => {
		const { records, log } = fakeAudit("off");
		const hub = createGateHub({ audit: log });
		hub.register(
			gate("permission", 10, {
				kind: "ask",
				request: askRequest("allow"),
			}),
		);

		await hub.handle(bashEvent(), ctxFor("s1"));
		expect(records).toHaveLength(0);
	});
});
