/**
 * Tests for the ask-mode banner: current state + blocked -> alternative hints.
 */
import { describe, expect, it } from "vitest";
import { appendAskBanner, buildAskBanner } from "./prompt.js";

describe("buildAskBanner", () => {
	it("states the hard-blocked tools and the exit path", () => {
		const banner = buildAskBanner();
		expect(banner).toContain("[ASK MODE — read-only]");
		expect(banner).toContain("write, edit, powershell");
		expect(banner).toContain("/ask");
	});

	it("names the alternatives for blocked commands", () => {
		const banner = buildAskBanner();
		expect(banner).toContain("`read` tool");
		expect(banner).toContain("`curl -s <url>`");
		expect(banner).toContain("cat/sed tricks");
	});

	it("lists the read-only git families", () => {
		const banner = buildAskBanner();
		expect(banner).toContain("blame");
		expect(banner).toContain("reflog show");
		expect(banner).toContain("stash list");
	});

	it("adds the helper-tool hint only when helpers are active", () => {
		const withHelpers = buildAskBanner({ helperTools: ["grep", "find", "ls"] });
		expect(withHelpers).toContain("`grep`/`find`/`ls` tools");

		const withoutHelpers = buildAskBanner();
		expect(withoutHelpers).not.toContain("active during ask mode");
	});
});

describe("appendAskBanner", () => {
	it("appends instead of replacing the existing system prompt", () => {
		const original = "You are a helpful coding agent.";
		const combined = appendAskBanner(original, { helperTools: ["grep"] });
		expect(combined.startsWith(original)).toBe(true);
		expect(combined).toContain("[ASK MODE — read-only]");
	});
});
