/**
 * Tests for ask-mode rejection messages: each one must point at a next step.
 */
import { describe, expect, it } from "vitest";
import { blockedBashReason, blockedToolReason } from "./reasons.js";

describe("blockedToolReason", () => {
	it.each(["write", "edit", "powershell"])(
		"names the exit path for %s",
		(tool) => {
			const reason = blockedToolReason(tool);
			expect(reason).toContain(tool);
			expect(reason).toContain("/ask");
		},
	);
});

describe("blockedBashReason", () => {
	it.each([
		["rm -rf /", "writes to disk"],
		["cat a > b", "redirection"],
		["echo $(id)", "command substitution"],
		["wget https://example.com", "curl -s"],
		["git commit -m x", "read-only git"],
		["git grep -O x", "run another program"],
		["pnpm install", "install/build"],
		["vim README.md", "allowlist"],
	] as const)("for %s mentions: %s", (command, needle) => {
		expect(blockedBashReason(command)).toContain(needle);
	});

	it("always echoes the blocked command", () => {
		expect(blockedBashReason("git push")).toContain("Command: git push");
	});
});
