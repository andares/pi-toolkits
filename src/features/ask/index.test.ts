/**
 * ask mode over the gate bus.
 *
 * The feature's command/state behaviour predates the bus; what this covers is
 * the migration itself: while ask mode is on, its gate blocks the tools it
 * confiscates and non-read-only bash, and it stops speaking once the mode is
 * off.
 */
import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { GateHub, ToolGate } from "../../lib/gates.js";
import { registerAsk } from "./index.js";

function event(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName,
		input,
	} as unknown as ToolCallEvent;
}

function makeHarness() {
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
	const pi = {
		on: () => {},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: ExtensionContext) => unknown },
		) {
			if (name === "ask") commandHandler = options.handler;
		},
		getActiveTools: () => [...activeTools],
		getAllTools: () => [
			{ name: "grep" },
			{ name: "find" },
			{ name: "ls" },
		],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI;

	const statuses: Array<[string, string | undefined]> = [];
	const notes: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string) => notes.push(message),
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	registerAsk(pi, hub);
	const gate = captured[0];
	if (!gate || !commandHandler) throw new Error("ask did not register");

	return {
		gate,
		ctx,
		activeTools: () => activeTools,
		toggle: async () => {
			await commandHandler?.("", ctx);
		},
		evaluate: async (toolName: string, input: Record<string, unknown> = {}) =>
			gate.evaluate(event(toolName, input), ctx),
	};
}

describe("ask gate", () => {
	it("has no opinion while ask mode is off", async () => {
		const h = makeHarness();
		expect(await h.evaluate("write", { path: "x" })).toBeUndefined();
	});

	it("blocks confiscated tools and non-read-only bash while on", async () => {
		const h = makeHarness();
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
		const h = makeHarness();
		await h.toggle();
		await h.toggle();
		expect(await h.evaluate("write", { path: "x" })).toBeUndefined();
	});

	it("restores the tool snapshot on exit", async () => {
		const h = makeHarness();
		await h.toggle();
		expect(h.activeTools()).not.toContain("write");
		await h.toggle();
		expect(h.activeTools()).toEqual(["read", "write", "edit", "bash"]);
	});
});
