import { describe, expect, it } from "vitest";
import {
	clearStartupCommand,
	consumeStartupCommand,
	markStartupCommand,
} from "./startup.js";

describe("startup handoff", () => {
	it("consumes a mark exactly once", () => {
		markStartupCommand("ask-perm");
		expect(consumeStartupCommand("ask-perm")).toBe(true);
		expect(consumeStartupCommand("ask-perm")).toBe(false);
	});

	it("ignores other commands", () => {
		markStartupCommand("ask-perm");
		expect(consumeStartupCommand("third-review")).toBe(false);
		expect(consumeStartupCommand("ask-perm")).toBe(true);
	});

	it("can be cleared without a consumer", () => {
		markStartupCommand("ask-perm");
		clearStartupCommand("ask-perm");
		expect(consumeStartupCommand("ask-perm")).toBe(false);
	});
});
