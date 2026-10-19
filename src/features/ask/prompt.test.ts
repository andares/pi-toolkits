/**
 * Tests for the ask-mode banner.
 *
 * The banner is part of every request while the mode is on, so the contract has
 * two halves: it must state the mode, the scratch allowance and the exit path,
 * and it must stay small and byte-stable (the details live in the tool
 * declaration and in rejection reasons).
 */
import { describe, expect, it } from "vitest";
import { appendAskBanner, buildAskBanner } from "./prompt.js";

describe("buildAskBanner", () => {
	it("states the mode, the scratch channel and the exit path", () => {
		const banner = buildAskBanner({ scratch: true });
		expect(banner).toContain("[ASK MODE]");
		expect(banner).toContain("do not implement");
		expect(banner).toContain("scratchpad");
		expect(banner).toContain("is a deliverable");
		expect(banner).toContain("/ask");
	});

	it("drops the scratch line when the session has no scratch space", () => {
		const banner = buildAskBanner({ scratch: false });
		expect(banner).not.toContain("scratchpad");
		expect(banner).toContain("[ASK MODE]");
		expect(banner).toContain("/ask");
	});

	it("does not restate the bash allowlist", () => {
		// The sandbox and reasons.ts own that list; per-request prose was the
		// bulk of the old banner's ~300 tokens.
		const banner = buildAskBanner({ scratch: true });
		expect(banner).not.toContain("rev-parse");
		expect(banner).not.toContain("sed -n");
		expect(banner).not.toContain("allowlist");
	});

	it("stays within the token budget", () => {
		expect(buildAskBanner({ scratch: true }).length).toBeLessThan(500);
	});

	it("is byte-stable for the same state", () => {
		// Anything per-turn here would break provider prompt caching.
		expect(buildAskBanner({ scratch: true })).toBe(
			buildAskBanner({ scratch: true }),
		);
	});
});

describe("appendAskBanner", () => {
	it("appends instead of replacing the existing system prompt", () => {
		const original = "You are a helpful coding agent.";
		const combined = appendAskBanner(original, { scratch: true });
		expect(combined.startsWith(original)).toBe(true);
		expect(combined).toContain("[ASK MODE]");
	});
});
