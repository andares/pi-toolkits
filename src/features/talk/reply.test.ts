import { describe, expect, it } from "vitest";
import { extractLastReply } from "./reply.js";

function user(text: string): object {
	return { id: `u-${text}`, type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}): object {
	return {
		id: `a-${Math.random().toString(36).slice(2)}`,
		type: "message",
		message: { role: "assistant", content, model: "provider/model", timestamp: 1_700_000_000_000, ...extra },
	};
}

describe("extractLastReply", () => {
	it("returns the text of the last assistant message", () => {
		const reply = extractLastReply([user("hi"), assistant([{ type: "text", text: "  hello there  " }])]);
		expect(reply?.text).toBe("hello there");
		expect(reply?.model).toBe("provider/model");
		expect(reply?.at).toBe(new Date(1_700_000_000_000).toISOString());
	});

	it("excludes thinking and tool calls", () => {
		const reply = extractLastReply([
			user("hi"),
			assistant([
				{ type: "thinking", thinking: "internal reasoning" },
				{ type: "toolCall", name: "bash", arguments: {} },
				{ type: "text", text: "the answer" },
			]),
		]);
		expect(reply?.text).toBe("the answer");
	});

	it("drops commentary before a tool call inside the SAME assistant message", () => {
		const reply = extractLastReply([
			user("hi"),
			assistant([
				{ type: "text", text: "I will check that first" },
				{ type: "toolCall", name: "read", arguments: {} },
				{ type: "text", text: "the actual answer" },
			]),
		]);
		expect(reply?.text).toBe("the actual answer");
	});

	it("drops commentary before late thinking inside the SAME assistant message", () => {
		const reply = extractLastReply([
			user("hi"),
			assistant([
				{ type: "text", text: "draft" },
				{ type: "thinking", thinking: "more reasoning" },
				{ type: "text", text: "final" },
			]),
		]);
		expect(reply?.text).toBe("final");
	});

	it("takes only the final assistant message of a multi-step turn", () => {
		const reply = extractLastReply([
			user("do the thing"),
			assistant([{ type: "text", text: "let me check" }]),
			{ id: "t1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
			assistant([{ type: "text", text: "done, here is what changed" }]),
		]);
		expect(reply?.text).toBe("done, here is what changed");
	});

	it("skips a tool-only assistant message instead of reporting no reply", () => {
		const reply = extractLastReply([
			user("go"),
			assistant([{ type: "text", text: "the real answer" }]),
			assistant([{ type: "toolCall", name: "read", arguments: {} }]),
		]);
		expect(reply?.text).toBe("the real answer");
	});

	it("stops at the user message — an earlier turn is never the reply", () => {
		const reply = extractLastReply([
			user("first question"),
			assistant([{ type: "text", text: "first answer" }]),
			user("second question"),
		]);
		expect(reply).toBeUndefined();
	});

	it("stops at a custom message", () => {
		expect(
			extractLastReply([
				user("q"),
				assistant([{ type: "text", text: "a" }]),
				{ id: "c1", type: "custom_message", customType: "keep:resumed", content: "note" },
			]),
		).toBeUndefined();
	});

	it("reports no reply for an empty turn", () => {
		expect(extractLastReply([user("hi")])).toBeUndefined();
		expect(extractLastReply([])).toBeUndefined();
	});

	it("fingerprints the text, so a refresh can tell same from different", () => {
		const a = extractLastReply([user("q"), assistant([{ type: "text", text: "same" }])]);
		const b = extractLastReply([user("q"), assistant([{ type: "text", text: "same" }])]);
		const c = extractLastReply([user("q"), assistant([{ type: "text", text: "different" }])]);
		expect(a?.fingerprint).toBe(b?.fingerprint);
		expect(a?.fingerprint).not.toBe(c?.fingerprint);
	});

	it("carries the entry id so callers can test compaction survival", () => {
		const entry = assistant([{ type: "text", text: "x" }]) as { id: string };
		const reply = extractLastReply([user("q"), entry]);
		expect(reply?.entryId).toBe(entry.id);
	});
});
