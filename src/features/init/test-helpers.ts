/**
 * Test helpers for the init feature. Kept in `src/` (like the tests themselves)
 * so the published package and the test run see the same files; nothing here is
 * imported by the extension at runtime.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Create a throw-away project from a path → content map. */
export function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-init-"));
	for (const [rel, content] of Object.entries(files)) {
		const absolute = join(root, rel);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content, "utf8");
	}
	return root;
}

export function remove(root: string): void {
	rmSync(root, { recursive: true, force: true });
}

/** `git init` + add + commit, for tests that need tracked files. */
export function gitProject(files: Record<string, string>, message = "init"): string {
	const root = project(files);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
	execFileSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=test",
			"commit",
			"-q",
			"-m",
			message,
		],
		{ stdio: "ignore" },
	);
	return root;
}

/** An installed-looking framework (state + contract + canonical dirs). */
export function installedProject(extra: Record<string, string> = {}): string {
	return project({
		"AGENTS.md": [
			"# demo — project guide",
			"",
			"> Memory contract (agent-framework v1): one fact, one home.",
			"",
			"## 1. What this is",
			"",
			"A demo project.",
			"",
			"## 5. Plan and memory index",
			"",
			"| File | Owns | Read when |",
			"| --- | --- | --- |",
			"| `specs/PLAN.md` | route | before work |",
			"| `.agents/memory/FINISHED.md` | closed work | closing |",
			"",
		].join("\n"),
		"specs/PLAN.md": "# Plan (open work)\n\n## Route\n\n_None._\n",
		".agents/memory/README.md": "# Agent memory framework v1\n\nRules.\n",
		".agents/memory/FINISHED.md": "# Finished work\n\n## Summary\n\n_None._\n",
		".agents/memory/FUTURE.md": "# Future and deferred\n\n_None._\n",
		".agents/memory/ARCHITECTURE.md": "# Architecture\n\n## Layering\n\n_None._\n",
		".agents/implementations/2026-01-01_init.md":
			"# init\n\n完成时间：2026-01-01 00:00:00\n\n## 范围\n\nInitial.\n",
		".agents/framework/state.toml": [
			"version = 1",
			'tool = "0.0.0-test"',
			'created = "2026-01-01T00:00:00+08:00"',
			'updated = "2026-01-01T00:00:00+08:00"',
			'profile = "core"',
			"modules = []",
			'lang = "en"',
			"",
		].join("\n"),
		...extra,
	});
}
