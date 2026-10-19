/**
 * Tests for the `scratchpad` tool: it must stay inactive until ask mode turns
 * it on, keep every operation inside the session store, and teach the
 * "notes, not deliverables" rule through its own declaration.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_SCRATCH_TOOL } from "./constants.js";
import { createScratchStore, type ScratchStore } from "./scratch.js";
import { registerScratchTool } from "./scratch-tool.js";

interface ToolDefinition {
	name: string;
	defaultActive?: boolean;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function harness() {
	let definition: ToolDefinition | undefined;
	let current: ScratchStore | undefined;
	const pi = {
		registerTool(candidate: ToolDefinition) {
			definition = candidate;
		},
	} as unknown as ExtensionAPI;
	registerScratchTool(pi, () => current);
	const registered = definition;
	if (!registered) throw new Error("scratch tool was not registered");

	const call = (params: Record<string, unknown>) =>
		registered.execute("call-1", params, undefined, undefined, {});

	return {
		definition: registered,
		use: (store: ScratchStore | undefined) => {
			current = store;
		},
		call,
	};
}

function store(): ScratchStore {
	return createScratchStore({
		baseDir: mkdtempSync(join(tmpdir(), "pi-ask-tool-")),
		sessionId: "session-1",
	});
}

describe("scratchpad tool declaration", () => {
	it("is inactive until ask mode activates it", () => {
		const h = harness();
		expect(h.definition.name).toBe(ASK_SCRATCH_TOOL);
		expect(h.definition.defaultActive).toBe(false);
	});

	it("carries the mode-scoped guidelines that keep notes out of the deliverable", () => {
		const h = harness();
		const guidelines = (h.definition.promptGuidelines ?? []).join("\n");
		expect(guidelines).toContain("ask mode");
		expect(guidelines).toContain("not deliverables");
		expect(h.definition.description).toContain("NOT deliverables");
		expect(h.definition.description).toContain("absolute paths");
	});
});

describe("scratchpad operations", () => {
	it("writes and reads a note back", async () => {
		const h = harness();
		const s = await store();
		h.use(s);

		const written = await h.call({
			op: "write",
			name: "plan.md",
			content: "1. read\n2. answer\n",
		});
		expect(written.isError).toBeUndefined();
		expect(written.content[0]?.text).toContain("Wrote plan.md");
		expect(written.content[0]?.text).toContain("2 lines");

		const read = await h.call({ op: "read", name: "plan.md" });
		expect(read.content[0]?.text).toBe("1. read\n2. answer\n");
	});

	it("appends and lists", async () => {
		const h = harness();
		h.use(await store());
		await h.call({ op: "write", name: "plan.md", content: "a" });
		const appended = await h.call({ op: "append", name: "plan.md", content: "b" });
		expect(appended.content[0]?.text).toContain("Appended to plan.md");
		const listed = await h.call({ op: "list" });
		expect(listed.content[0]?.text).toContain("plan.md");
	});

	it("deletes, and reading afterwards explains the miss", async () => {
		const h = harness();
		h.use(await store());
		await h.call({ op: "write", name: "plan.md", content: "x" });
		const deleted = await h.call({ op: "delete", name: "plan.md" });
		expect(deleted.content[0]?.text).toContain("Deleted plan.md");

		const read = await h.call({ op: "read", name: "plan.md" });
		expect(read.isError).toBe(true);
		expect(read.content[0]?.text).toContain("no scratch note");
	});
});

describe("scratchpad failures", () => {
	it("rejects an absolute name without touching the disk", async () => {
		const h = harness();
		h.use(await store());
		const result = await h.call({
			op: "write",
			name: "/etc/passwd",
			content: "x",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not a relative name");
	});

	it("reports the size cap", async () => {
		const h = harness();
		h.use(await store());
		const result = await h.call({
			op: "write",
			name: "big.md",
			content: "x".repeat(256 * 1024 + 1),
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("capped at");
	});

	it("asks for a name when the op needs one", async () => {
		const h = harness();
		h.use(await store());
		const result = await h.call({ op: "read" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("needs a note name");
	});

	it("refuses to write when the mode has no scratch space", async () => {
		const h = harness();
		h.use(undefined);
		const result = await h.call({ op: "list" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not available");
	});
});
