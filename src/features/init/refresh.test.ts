import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stateToToml } from "./apply.js";
import { loadState } from "./detect.js";
import { applyWorkflowBlock, describeRefresh, refreshFramework } from "./refresh.js";
import { CONTRACT_FILE, UAT_CONTRACT_FILE, UAT_DIR, WORKFLOW_BLOCK_BEGIN, WORKFLOW_BLOCK_END } from "./spec.js";
import { installedProject, remove } from "./test-helpers.js";

const roots: string[] = [];

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function installed(): string {
	const root = installedProject();
	roots.push(root);
	return root;
}

function writeState(
	root: string,
	managed: Array<{ path: string; sha256: string; template: string; templateSha256?: string }>,
): void {
	writeFileSync(
		join(root, ".agents/framework/state.toml"),
		stateToToml({
			version: 1,
			tool: "0.0.0-test",
			created: "2026-01-01T00:00:00+08:00",
			updated: "2026-01-01T00:00:00+08:00",
			profile: "core",
			modules: [],
			roots: [],
			managed,
			migrations: [],
		}),
		"utf8",
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) remove(root);
});

describe("workflow block", () => {
	it("replaces the block between its markers and leaves the rest alone", () => {
		const text = [
			"# demo",
			"",
			"intro",
			"",
			"<!-- ask-init:begin workflow v1 -->",
			"## old block",
			"<!-- ask-init:end workflow -->",
			"",
			"## After",
			"",
			"tail",
			"",
		].join("\n");
		const result = applyWorkflowBlock(text, `${WORKFLOW_BLOCK_BEGIN} v2 -->\n## new block\n${WORKFLOW_BLOCK_END}`);
		expect(result.status).toBe("updated");
		expect(result.text).toContain("## new block");
		expect(result.text).not.toContain("## old block");
		expect(result.text).toContain("intro");
		expect(result.text).toContain("## After");
		expect(result.text).toContain("tail");
	});

	it("inserts before the appendix, else at the end", () => {
		const block = `${WORKFLOW_BLOCK_BEGIN} v1 -->\n## Ask workflow\n${WORKFLOW_BLOCK_END}`;
		const withAppendix = applyWorkflowBlock("# demo\n\n## Body\n\ntext\n\n## 附录\n\nold\n", block);
		expect(withAppendix.status).toBe("inserted");
		expect(withAppendix.text.indexOf("## Ask workflow")).toBeLessThan(
			withAppendix.text.indexOf("## 附录"),
		);
		const appended = applyWorkflowBlock("# demo\n\n## Body\n\ntext\n", block);
		expect(appended.text.trimEnd().endsWith(WORKFLOW_BLOCK_END)).toBe(true);
	});

	it("never treats inline marker examples as the managed block", () => {
		const text = [
			"# demo",
			"",
			"- docs: `<!-- ask-init:begin workflow v1 -->`",
			"  `<!-- ask-init:end workflow -->`，块外文字保持原样",
			"",
			"## Body",
			"",
			"tail",
		].join("\n");
		const block = `${WORKFLOW_BLOCK_BEGIN} v1 -->\n## Ask workflow\n${WORKFLOW_BLOCK_END}`;
		const result = applyWorkflowBlock(text, block);
		expect(result.status).toBe("inserted");
		expect(result.text).toContain("`<!-- ask-init:begin workflow v1 -->`");
		expect(result.text).toContain("块外文字保持原样");
	});

	it("ignores markers inside fenced code blocks", () => {
		const text = [
			"# demo",
			"",
			"```md",
			"<!-- ask-init:begin workflow v1 -->",
			"## example",
			"<!-- ask-init:end workflow -->",
			"```",
			"",
		].join("\n");
		const block = `${WORKFLOW_BLOCK_BEGIN} v1 -->\n## Ask workflow\n${WORKFLOW_BLOCK_END}`;
		const result = applyWorkflowBlock(text, block);
		expect(result.status).toBe("inserted");
		expect(result.text).toContain("## example");
	});

	it("does not add a second block when a hand-written Ask workflow section exists", () => {
		const text = "# demo\n\n## Ask workflow\n\nDo it by hand.\n";
		const block = `${WORKFLOW_BLOCK_BEGIN} v1 -->\n## Ask workflow\n${WORKFLOW_BLOCK_END}`;
		const result = applyWorkflowBlock(text, block);
		expect(result.status).toBe("hand-written");
		expect(result.text).toBe(text);
	});

	it("reports malformed marker layouts without touching the file", () => {
		const block = `${WORKFLOW_BLOCK_BEGIN} v1 -->\n## Ask workflow\n${WORKFLOW_BLOCK_END}`;
		const beginOnly = `# demo\n\n${WORKFLOW_BLOCK_BEGIN} v1 -->\n## old\n`;
		const first = applyWorkflowBlock(beginOnly, block);
		expect(first.status).toBe("malformed");
		expect(first.text).toBe(beginOnly);

		const endFirst = `# demo\n\n${WORKFLOW_BLOCK_END}\n## old\n${WORKFLOW_BLOCK_BEGIN} v1 -->\n`;
		const second = applyWorkflowBlock(endFirst, block);
		expect(second.status).toBe("malformed");
		expect(second.text).toBe(endFirst);
	});
});

describe("refreshFramework", () => {
	it("creates the acceptance contract and inserts the workflow block", () => {
		const root = installed();
		const result = refreshFramework(root, { now: new Date("2026-11-13T21:07:00+08:00") });
		expect(result.created).toContain(UAT_CONTRACT_FILE);
		expect(existsSync(join(root, UAT_DIR))).toBe(true);
		expect(result.block).toBe("inserted");
		const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
		expect(agents).toContain(WORKFLOW_BLOCK_BEGIN);
		expect(agents).toContain(WORKFLOW_BLOCK_END);
		expect(agents).toContain("## Ask workflow");
		// The operator's own text is untouched.
		expect(agents).toContain("A demo project.");
	});

	it("is idempotent", () => {
		const root = installed();
		const first = refreshFramework(root);
		expect(first.created.length + first.updated.length).toBeGreaterThan(0);
		const second = refreshFramework(root);
		expect(second.created).toEqual([]);
		expect(second.updated).toEqual([]);
		expect(second.block).toBe("current");
	});

	it("rewrites a managed file whose disk still equals the anchor", () => {
		const root = installed();
		writeFileSync(join(root, CONTRACT_FILE), "stale contract\n", "utf8");
		writeState(root, [
			{
				path: CONTRACT_FILE,
				sha256: sha256("stale contract\n"),
				template: "memory-readme",
				templateSha256: sha256("stale contract\n"),
			},
		]);
		const result = refreshFramework(root);
		expect(result.updated).toContain(CONTRACT_FILE);
		const text = readFileSync(join(root, CONTRACT_FILE), "utf8");
		expect(text).toContain("Agent memory framework");
		expect(text).not.toBe("stale contract\n");
		const state = loadState(root).state;
		const entry = state?.managed.find((item) => item.path === CONTRACT_FILE);
		expect(entry?.templateSha256).toBe(sha256(text));
	});

	it("never overwrites a hand-edited framework file", () => {
		const root = installed();
		writeFileSync(join(root, CONTRACT_FILE), "my own contract\n", "utf8");
		writeState(root, [
			{
				path: CONTRACT_FILE,
				sha256: sha256("original contract\n"),
				template: "memory-readme",
				templateSha256: sha256("original contract\n"),
			},
		]);
		const result = refreshFramework(root);
		expect(result.updated).not.toContain(CONTRACT_FILE);
		expect(result.skipped.map((entry) => entry.path)).toContain(CONTRACT_FILE);
		expect(result.skipped.find((entry) => entry.path === CONTRACT_FILE)?.reason).toMatch(/edited by hand/);
		expect(readFileSync(join(root, CONTRACT_FILE), "utf8")).toBe("my own contract\n");
	});

	it("reports a missing AGENTS.md instead of calling the framework current", () => {
		const root = installed();
		remove(join(root, "AGENTS.md"));
		const result = refreshFramework(root, { dryRun: true });
		expect(result.block).toBe("missing-agents");
		expect(describeRefresh(result)).toContain("AGENTS.md is missing");
	});

	it("writes nothing in a dry run", () => {
		const root = installed();
		const before = readFileSync(join(root, "AGENTS.md"), "utf8");
		const result = refreshFramework(root, { dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(result.created).toContain(UAT_CONTRACT_FILE);
		expect(existsSync(join(root, UAT_CONTRACT_FILE))).toBe(false);
		expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(before);
	});

	it("does not trust a legacy disk hash as proof that a file was not hand-edited", () => {
		const root = installed();
		const edited = "operator edited this contract\n";
		writeFileSync(join(root, CONTRACT_FILE), edited, "utf8");
		writeState(root, [
			{
				path: CONTRACT_FILE,
				sha256: sha256(edited),
				template: "memory-readme",
				// Legacy state has no template anchor. The disk hash only says what
				// the last run saw, not what the framework originally rendered.
				templateSha256: undefined,
			},
		]);
		const result = refreshFramework(root);
		expect(result.updated).not.toContain(CONTRACT_FILE);
		expect(result.skipped.map((entry) => entry.path)).toContain(CONTRACT_FILE);
		expect(readFileSync(join(root, CONTRACT_FILE), "utf8")).toBe(edited);
	});

	it("adopts a legacy file only when --adopt is explicit", () => {
		const root = installed();
		const legacy = "legacy contract from an older version\n";
		writeFileSync(join(root, CONTRACT_FILE), legacy, "utf8");
		writeState(root, [
			{
				path: CONTRACT_FILE,
				sha256: sha256(legacy),
				template: "memory-readme",
				templateSha256: undefined,
			},
		]);
		const skipped = refreshFramework(root);
		expect(skipped.updated).not.toContain(CONTRACT_FILE);
		expect(skipped.skipped.map((entry) => entry.path)).toContain(CONTRACT_FILE);

		const adopted = refreshFramework(root, { adoptLegacy: true });
		expect(adopted.adopted).toContain(CONTRACT_FILE);
		expect(adopted.updated).toContain(CONTRACT_FILE);
		expect(readFileSync(join(root, CONTRACT_FILE), "utf8")).not.toBe(legacy);
	});

	it("persists missing template anchors even when no file content changes", () => {
		const root = installed();
		refreshFramework(root, { toolVersion: "test" });
		const statePath = join(root, ".agents/framework/state.toml");
		const state = loadState(root).state!;
		writeFileSync(
			statePath,
			stateToToml({
				...state,
				managed: state.managed.map((entry) => ({ ...entry, templateSha256: undefined })),
			}),
			"utf8",
		);
		const result = refreshFramework(root, { toolVersion: "test" });
		expect(result.created).toEqual([]);
		expect(result.updated).toEqual([]);
		expect(result.stateUpdated).toBe(true);
		expect(
			loadState(root).state?.managed
				.filter((entry) => existsSync(join(root, entry.path)))
				.every((entry) => entry.templateSha256 !== undefined),
		).toBe(true);
	});

	it("refuses a project without the framework", () => {
		const root = installed();
		remove(root);
		roots.splice(roots.indexOf(root), 1);
		expect(() => refreshFramework(root)).toThrow(/\/ask-init first/);
	});
});
