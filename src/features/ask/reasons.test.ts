/**
 * Tests for ask-mode rejection messages: each one must point at a next step,
 * and the write-shaped ones must point at `scratchpad` rather than at the exit
 * command alone.
 */
import { describe, expect, it } from "vitest";
import { blockedBashReason, blockedToolReason } from "./reasons.js";

describe("blockedToolReason", () => {
	it.each(["write", "edit"])(
		"points %s at the scratch tool and the exit path",
		(tool) => {
			const reason = blockedToolReason(tool);
			expect(reason).toContain(tool);
			expect(reason).toContain("scratchpad");
			expect(reason).toContain("/ask");
		},
	);

	it("names the alternatives for powershell", () => {
		const reason = blockedToolReason("powershell");
		expect(reason).toContain("powershell");
		expect(reason).toContain("scratchpad");
		expect(reason).toContain("read-only bash");
	});
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

	it("points write-shaped rejections at the scratch tool", () => {
		expect(blockedBashReason("cat a > b")).toContain("scratchpad");
		expect(blockedBashReason("tee out.txt")).toContain("scratchpad");
	});

	it("always echoes the blocked command", () => {
		expect(blockedBashReason("git push")).toContain("Command: git push");
	});
});

describe("degraded mode (no scratch space)", () => {
	it("does not point write/edit at the unavailable scratch tool", () => {
		for (const tool of ["write", "edit", "powershell"]) {
			const reason = blockedToolReason(tool, { scratch: false });
			expect(reason).not.toContain("scratchpad");
			expect(reason).toContain("no scratch space");
			expect(reason).toContain("/ask");
		}
	});

	it("does not point bash rejections at the unavailable scratch tool", () => {
		for (const command of ["cat a > b", "tee out.txt", "wget https://x", "vim f"]) {
			expect(blockedBashReason(command, { scratch: false })).not.toContain(
				"scratchpad",
			);
		}
	});

	it("keeps pointing at scratchpad by default (scratch available)", () => {
		expect(blockedToolReason("write")).toContain("scratchpad");
		expect(blockedBashReason("cat a > b")).toContain("scratchpad");
	});
});
