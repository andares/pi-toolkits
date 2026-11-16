import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	appendSpecVersion,
	createSpecSession,
	latestVersion,
	listSpecSessions,
	loadSpecSession,
	specSlug,
	readVersionText,
	recordSpecDecision,
	setSpecAnnotations,
	type SpecSession,
} from "./store.js";

let agentDir: string;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-plan-store-"));
});

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds));

function makeSession(text = "## Spec\n\nfirst step"): SpecSession {
	return createSpecSession({
		agentDir,
		slug: `plan-${Math.random().toString(36).slice(2, 8)}`,
		text,
		source: "specs/x.md",
		now: at(0),
	});
}

describe("specSlug", () => {
	it("lowercases, collapses separators and keeps CJK", () => {
		expect(specSlug("Ask-Spec: Web UI!")).toBe("ask-spec-web-ui");
		expect(specSlug("计划 评审")).toContain("计划");
		expect(specSlug("   ")).toBe("spec");
	});
});

describe("legacy store", () => {
	it("migrates the pre-rename ask-plan directory on first use", () => {
		const isolated = mkdtempSync(join(tmpdir(), "pi-spec-legacy-"));
		const legacy = join(isolated, "ask-plan");
		const old = join(legacy, "old");
		mkdirSync(old, { recursive: true });
		writeFileSync(
			join(old, "state.json"),
			JSON.stringify({ slug: "old", dir: old, createdAt: at(0).toISOString(), versions: [] }),
		);
		expect(listSpecSessions(isolated)).toContain(join(isolated, "ask-spec", "old"));
		expect(existsSync(legacy)).toBe(false);
		rmSync(isolated, { recursive: true, force: true });
	});

	it("keeps legacy sessions visible when both store directories exist", () => {
		const isolated = mkdtempSync(join(tmpdir(), "pi-spec-both-stores-"));
		for (const [store, slug] of [["ask-spec", "new"], ["ask-plan", "old"]]) {
			const dir = join(isolated, store, slug);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "state.json"),
				JSON.stringify({ slug, dir, createdAt: at(0).toISOString(), versions: [] }),
			);
		}
		expect(listSpecSessions(isolated)).toEqual(
			expect.arrayContaining([join(isolated, "ask-spec", "new"), join(isolated, "ask-plan", "old")]),
		);
		rmSync(isolated, { recursive: true, force: true });
	});
});

describe("createSpecSession", () => {
	it("writes the first revision and the state file", () => {
		const session = makeSession();
		expect(session.versions).toHaveLength(1);
		expect(session.versions[0].n).toBe(1);
		expect(session.versions[0].diff).toEqual([]);
		expect(readVersionText(session, 1)).toBe("## Spec\n\nfirst step");
		const onDisk = JSON.parse(readFileSync(join(session.dir, "state.json"), "utf8"));
		expect(onDisk.versions).toHaveLength(1);
		expect(onDisk.slug).toBe(session.slug);
	});

	it("allocates a second directory for a slug that already exists", () => {
		const first = createSpecSession({ agentDir, slug: "same", text: "a" });
		const second = createSpecSession({ agentDir, slug: "same", text: "b" });
		expect(first.slug).toBe("same");
		expect(second.slug).toBe("same-2");
		expect(first.dir).not.toBe(second.dir);
	});
});

describe("appendSpecVersion", () => {
	it("numbers revisions and diffs against the previous one", () => {
		const session = makeSession("## Spec\n\nfirst step\n\nsecond step");
		const second = appendSpecVersion(session, {
			text: "## Spec\n\nfirst step edited\n\nsecond step",
			now: at(10),
		});
		expect(second.n).toBe(2);
		expect(second.diff.map((entry) => entry.status).filter((status) => status !== "unchanged")).toEqual([
			"modified",
		]);
		expect(session.versions).toHaveLength(2);
		expect(readVersionText(session, 2)).toContain("first step edited");
		expect(latestVersion(session).n).toBe(2);
	});

	it("keeps at most 50 revisions and never drops a decided one", () => {
		const session = makeSession("v1");
		recordSpecDecision(session, 1, "approve", at(1));
		for (let i = 2; i <= 53; i += 1) {
			appendSpecVersion(session, { text: `v${i}`, now: at(i) });
		}
		expect(session.versions.length).toBeLessThanOrEqual(50);
		expect(session.versions.some((version) => version.n === 1 && version.decision?.action === "approve")).toBe(true);
		expect(latestVersion(session).n).toBe(53);
		expect(existsSync(join(session.dir, "v001.md"))).toBe(true);

		// The next identity follows the highest revision number, not the number
		// of retained entries — otherwise pruning reuses 51 and overwrites it.
		const next = appendSpecVersion(session, { text: "v54", now: at(54) });
		expect(next.n).toBe(54);
		expect(new Set(session.versions.map((version) => version.n)).size).toBe(session.versions.length);
		expect(readVersionText(session, 54)).toBe("v54");
	});
});

describe("annotations and decisions", () => {
	it("persists annotations on the revision they belong to", () => {
		const session = makeSession();
		setSpecAnnotations(session, 1, {
			global: [{ verdict: "change", comment: "rethink scope" }],
			blocks: [{ blockId: session.versions[0].blocks[0].id, annotations: [{ verdict: "question", comment: "why?" }] }],
		});
		const reloaded = loadSpecSession(session.dir);
		expect(reloaded.versions[0].annotations.global).toHaveLength(1);
		expect(reloaded.versions[0].annotations.blocks[0].annotations[0].verdict).toBe("question");
	});

	it("records a decision with a timestamp", () => {
		const session = makeSession();
		recordSpecDecision(session, 1, "approve", at(5));
		expect(loadSpecSession(session.dir).versions[0].decision).toEqual({
			action: "approve",
			at: at(5).toISOString(),
		});
	});

	it("refuses a revision that does not exist", () => {
		const session = makeSession();
		expect(() => recordSpecDecision(session, 99, "approve")).toThrow(/no spec revision 99/);
		expect(() => setSpecAnnotations(session, 99, { global: [], blocks: [] })).toThrow(/no spec revision 99/);
	});
});

describe("loadSpecSession", () => {
	it("reports a corrupt state file with its path", () => {
		const session = makeSession();
		writeFileSync(join(session.dir, "state.json"), "{not json");
		expect(() => loadSpecSession(session.dir)).toThrow(/cannot read spec state at .*state\.json/);
	});

	it("keeps paths in empty-session and non-object state errors", () => {
		const session = makeSession();
		writeFileSync(join(session.dir, "state.json"), "null");
		expect(() => loadSpecSession(session.dir)).toThrow(
			`spec state at ${join(session.dir, "state.json")} is not an object`,
		);
		session.versions = [];
		expect(() => latestVersion(session)).toThrow(`spec session ${session.dir} has no revisions`);
	});

	it("lists sessions that have a state file", () => {
		const session = makeSession();
		const dirs = listSpecSessions(agentDir);
		expect(dirs).toContain(session.dir);
	});
});
