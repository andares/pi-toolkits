/**
 * Pre-flight release materials.
 *
 * The script must be runnable from a terminal with no agent attached, so the
 * material verdict has to be complete and honest before anything expensive
 * starts: every gap in one list, and a "fix" line on every blocking item (an
 * abort without a next step is what made the empty-changelog case unusable).
 */
import { describe, expect, it } from "vitest";
import { assessReleaseMaterials } from "./release-materials.mjs";

/** All materials present — the baseline every case deviates from. */
function assess(overrides = {}) {
	return assessReleaseMaterials({
		current: "1.2.2",
		next: "1.2.3",
		arg: "patch",
		dirty: "",
		changelog: { state: "ready", count: 3 },
		filesIncludeChangelog: true,
		nextTagExists: false,
		tail: { state: "ok", localSha: "f775b74c0ffee" },
		...overrides,
	});
}

const levels = (report) =>
	Object.fromEntries(report.items.map((item) => [item.id, item.level]));

describe("assessReleaseMaterials — ready", () => {
	it("passes with every material present", () => {
		const report = assess();
		expect(report.blocked).toBe(false);
		expect(report.blocking).toEqual([]);
		expect(report.promoteNotes).toBe(true);
		expect(levels(report)).toEqual({
			tree: "ok",
			changelog: "ok",
			files: "ok",
			"next-tag": "ok",
			tail: "ok",
		});
	});

	it("names the note count and the version it becomes", () => {
		const item = assess().items.find((entry) => entry.id === "changelog");
		expect(item.title).toContain("3 条");
		expect(item.title).toContain("## 1.2.3");
	});
});

describe("assessReleaseMaterials — blocking gaps", () => {
	it.each([
		["tree", { dirty: " M src/a.ts" }],
		["files", { filesIncludeChangelog: false }],
		["next-tag", { nextTagExists: true }],
		["tail", { tail: { state: "absent" } }],
		["tail", { tail: { state: "unknown" } }],
		["tail", { tail: { state: "mismatch", localSha: "aaa", remoteSha: "bbb" } }],
		["tail", { tail: { state: "missing-local-tag" } }],
	])("blocks on %s", (id, overrides) => {
		const report = assess(overrides);
		expect(report.blocked).toBe(true);
		expect(report.blocking).toEqual([id]);
	});

	// `promoteNotes` answers "are the notes ready", not "may we start": a dirty
	// tree blocks the run but does not make the notes themselves wrong.
	it.each([
		["empty", { state: "empty", count: 0 }],
		["missing", { state: "missing", count: 0 }],
	])("blocks on a %s changelog and cancels the promotion", (_label, changelog) => {
		const report = assess({ changelog });
		expect(report.blocked).toBe(true);
		expect(report.blocking).toEqual(["changelog"]);
		expect(report.promoteNotes).toBe(false);
	});

	it("still reports notes as promotable when another material blocks", () => {
		expect(assess({ dirty: " M src/a.ts" }).promoteNotes).toBe(true);
	});

	it("collects every gap in one pass instead of failing one at a time", () => {
		const report = assess({
			dirty: " M CHANGELOG.md",
			changelog: { state: "empty", count: 0 },
			nextTagExists: true,
			tail: { state: "absent" },
		});
		expect(report.blocking).toEqual(["tree", "changelog", "next-tag", "tail"]);
	});

	it("gives every blocking item a next step, and none to a satisfied one", () => {
		const report = assess({
			dirty: " M src/a.ts",
			changelog: { state: "empty", count: 0 },
			filesIncludeChangelog: false,
			nextTagExists: true,
			tail: { state: "unknown" },
		});
		for (const item of report.items) {
			expect(item.level).toBe("block");
			expect(item.fix, `${item.id} must say what to do`).toBeTruthy();
		}
		for (const item of assess().items) {
			expect(item.fix).toBeUndefined();
		}
	});

	it("keeps the uncommitted files in the detail so they can be acted on", () => {
		const item = assess({ dirty: " M src/a.ts\n?? scratch.txt" }).items.find(
			(entry) => entry.id === "tree",
		);
		expect(item.detail).toContain("M src/a.ts");
		expect(item.detail).toContain("scratch.txt");
	});

	it("names the version for a tag that already exists", () => {
		const item = assess({ nextTagExists: true }).items.find(
			(entry) => entry.id === "next-tag",
		);
		expect(item.title).toContain("v1.2.3");
		expect(item.fix).toContain("v1.2.3");
	});
});

describe("assessReleaseMaterials — explicit bypasses", () => {
	it("--skip-changelog downgrades an empty section to a warning", () => {
		const report = assess({
			changelog: { state: "empty", count: 0 },
			skipChangelog: true,
		});
		expect(report.blocked).toBe(false);
		expect(report.promoteNotes).toBe(false);
		expect(levels(report).changelog).toBe("warn");
	});

	it("--skip-tail-check downgrades a failed tail probe to a warning", () => {
		const report = assess({ skipTailCheck: true, tail: undefined });
		expect(report.blocked).toBe(false);
		expect(levels(report).tail).toBe("warn");
	});

	it("does not let a bypass hide an unrelated gap", () => {
		const report = assess({ skipChangelog: true, dirty: " M src/a.ts" });
		expect(report.blocked).toBe(true);
		expect(report.blocking).toEqual(["tree"]);
	});
});
