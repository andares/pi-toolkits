import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetProjectRootCache, resolveProjectRoot } from "./state.js";

const roots: string[] = [];

afterEach(() => {
	resetProjectRootCache();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

describe("resolveProjectRoot", () => {
	it("uses the cwd itself outside git", () => {
		const root = mkdtempSync(join(tmpdir(), "uat-nongit-"));
		roots.push(root);
		expect(resolveProjectRoot(root)).toBe(root);
	});

	it("resolves a linked worktree to the main checkout", () => {
		const main = mkdtempSync(join(tmpdir(), "uat-main-"));
		const parent = mkdtempSync(join(tmpdir(), "uat-worktrees-"));
		const linked = join(parent, "linked");
		roots.push(main, parent);
		git(main, ["init", "-q"]);
		writeFileSync(join(main, "file.txt"), "one\n", "utf8");
		git(main, ["add", "file.txt"]);
		git(main, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init"]);
		git(main, ["worktree", "add", "-qb", "uat-review", linked]);

		resetProjectRootCache();
		expect(resolveProjectRoot(linked)).toBe(main);
		expect(resolveProjectRoot(main)).toBe(main);
	});
});
