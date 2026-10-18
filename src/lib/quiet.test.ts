import { describe, expect, it } from "vitest";
import { clearQuiet, consumeQuiet, markQuiet } from "./quiet.js";

describe("quiet handoff", () => {
	it("consumes a mark exactly once", () => {
		markQuiet("ask-perm");
		expect(consumeQuiet("ask-perm")).toBe(true);
		expect(consumeQuiet("ask-perm")).toBe(false);
	});

	it("ignores other commands", () => {
		markQuiet("ask-perm");
		expect(consumeQuiet("third-review")).toBe(false);
		expect(consumeQuiet("ask-perm")).toBe(true);
	});

	it("can be cleared without a consumer", () => {
		markQuiet("ask-perm");
		clearQuiet("ask-perm");
		expect(consumeQuiet("ask-perm")).toBe(false);
	});
});
