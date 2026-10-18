/**
 * Gate bus tests.
 *
 * The bus is the composition contract between features: a block short-circuits,
 * an allow never overrides, dialogs are serialized, and a failing gate fails
 * closed.
 */
import { describe, expect, it } from "vitest";
import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createGateHub,
	type AskDecision,
	type AskRequest,
	type ToolGate,
} from "./gates.js";

function bashEvent(command = "ls"): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "bash",
		input: { command },
	} as unknown as ToolCallEvent;
}

const ctx = {} as ExtensionContext;

function askRequest(
	decide: AskDecision | undefined,
	applied: AskDecision[] = [],
): AskRequest {
	return {
		title: "Permission required",
		details: ["Command: rm x"],
		root: "/proj",
		present: async () => decide,
		apply: (choice) => applied.push(choice),
		denyReason: (choice) => `denied:${choice}`,
	};
}

function gate(
	name: string,
	order: number,
	verdict: ReturnType<ToolGate["evaluate"]>,
): ToolGate {
	return { name, order, evaluate: () => verdict };
}

describe("gate hub", () => {
	it("allows when no gate has an opinion", async () => {
		const hub = createGateHub();
		hub.register(gate("noop", 10, undefined));
		await expect(hub.handle(bashEvent(), ctx)).resolves.toBeUndefined();
	});

	it("an explicit allow does not override another gate's block", async () => {
		const hub = createGateHub();
		hub.register(gate("allow", 10, { kind: "allow" }));
		hub.register(gate("block", 20, { kind: "block", reason: "no" }));
		await expect(hub.handle(bashEvent(), ctx)).resolves.toEqual({ reason: "no" });
	});

	it("blocks immediately and skips later gates", async () => {
		const hub = createGateHub();
		let laterRan = false;
		hub.register(gate("first", 10, { kind: "block", reason: "stop" }));
		hub.register({
			name: "later",
			order: 20,
			evaluate: () => {
				laterRan = true;
				return undefined;
			},
		});
		await expect(hub.handle(bashEvent(), ctx)).resolves.toEqual({ reason: "stop" });
		expect(laterRan).toBe(false);
	});

	it("runs gates in ascending order", async () => {
		const hub = createGateHub();
		const seen: string[] = [];
		hub.register({
			name: "second",
			order: 20,
			evaluate: () => {
				seen.push("second");
				return undefined;
			},
		});
		hub.register({
			name: "first",
			order: 10,
			evaluate: () => {
				seen.push("first");
				return undefined;
			},
		});
		await hub.handle(bashEvent(), ctx);
		expect(seen).toEqual(["first", "second"]);
	});

	it("applies an allow answer and resolves", async () => {
		const hub = createGateHub();
		const applied: AskDecision[] = [];
		hub.register(gate("ask", 10, { kind: "ask", request: askRequest("allow", applied) }));
		await expect(hub.handle(bashEvent(), ctx)).resolves.toBeUndefined();
		expect(applied).toEqual(["allow"]);
	});

	it("blocks with the request's deny reason", async () => {
		const hub = createGateHub();
		const applied: AskDecision[] = [];
		hub.register(
			gate("ask", 10, { kind: "ask", request: askRequest("deny-session", applied) }),
		);
		await expect(hub.handle(bashEvent(), ctx)).resolves.toEqual({
			reason: "denied:deny-session",
		});
		expect(applied).toEqual(["deny-session"]);
	});

	it("treats a cancelled or unanswerable dialog as a denial", async () => {
		const hub = createGateHub();
		hub.register(gate("ask", 10, { kind: "ask", request: askRequest(undefined) }));
		const result = await hub.handle(bashEvent(), ctx);
		expect(result?.reason).toContain("was not answered");
	});

	it("fails closed when a gate throws", async () => {
		const hub = createGateHub();
		hub.register({
			name: "broken",
			order: 10,
			evaluate: () => {
				throw new Error("boom");
			},
		});
		const result = await hub.handle(bashEvent(), ctx);
		expect(result?.reason).toContain("broken");
		expect(result?.reason).toContain("blocked");
	});

	it("serializes dialogs across concurrent tool calls", async () => {
		const hub = createGateHub();
		let active = 0;
		let maxActive = 0;
		const present = async (): Promise<AskDecision> => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return "allow";
		};
		const request: AskRequest = {
			title: "Permission required",
			details: [],
			root: "/proj",
			present,
			apply: () => {},
			denyReason: () => "denied",
		};
		hub.register(gate("ask", 10, { kind: "ask", request }));

		await Promise.all([hub.handle(bashEvent("a"), ctx), hub.handle(bashEvent("b"), ctx)]);
		expect(maxActive).toBe(1);
	});
});
