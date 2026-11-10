import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	appendPlanVersion,
	createPlanSession,
	latestVersion,
	listPlanSessions,
	loadPlanSession,
	planSlug,
	readVersionText,
	recordPlanDecision,
	setPlanAnnotations,
	type PlanSession,
} from "./store.js";

let agentDir: string;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-plan-store-"));
});

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds));

function makeSession(text = "## Plan\n\nfirst step"): PlanSession {
	return createPlanSession({
		agentDir,
		slug: `plan-${Math.random().toString(36).slice(2, 8)}`,
		text,
		source: "specs/x.md",
		now: at(0),
	});
}

describe("planSlug", () => {
	it("lowercases, collapses separators and keeps CJK", () => {
		expect(planSlug("Ask-Plan: Web UI!")).toBe("ask-plan-web-ui");
		expect(planSlug("计划 评审")).toContain("计划");
		expect(planSlug("   ")).toBe("plan");
	});
});

describe("createPlanSession", () => {
	it("writes the first revision and the state file", () => {
		const session = makeSession();
		expect(session.versions).toHaveLength(1);
		expect(session.versions[0].n).toBe(1);
		expect(session.versions[0].diff).toEqual([]);
		expect(readVersionText(session, 1)).toBe("## Plan\n\nfirst step");
		const onDisk = JSON.parse(readFileSync(join(session.dir, "state.json"), "utf8"));
		expect(onDisk.versions).toHaveLength(1);
		expect(onDisk.slug).toBe(session.slug);
	});

	it("allocates a second directory for a slug that already exists", () => {
		const first = createPlanSession({ agentDir, slug: "same", text: "a" });
		const second = createPlanSession({ agentDir, slug: "same", text: "b" });
		expect(first.slug).toBe("same");
		expect(second.slug).toBe("same-2");
		expect(first.dir).not.toBe(second.dir);
	});
});

describe("appendPlanVersion", () => {
	it("numbers revisions and diffs against the previous one", () => {
		const session = makeSession("## Plan\n\nfirst step\n\nsecond step");
		const second = appendPlanVersion(session, {
			text: "## Plan\n\nfirst step edited\n\nsecond step",
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
		for (let i = 2; i <= 52; i += 1) {
			appendPlanVersion(session, { text: `v${i}`, now: at(i) });
		}
		// Decide the oldest revision as if the operator had acted on it.
		recordPlanDecision(session, session.versions[0].n, "approve", at(60));
		appendPlanVersion(session, { text: "v53", now: at(53) });
		expect(session.versions.length).toBeLessThanOrEqual(50);
		expect(session.versions.some((version) => version.decision?.action === "approve")).toBe(true);
		const last = session.versions[session.versions.length - 1];
		expect(latestVersion(session).n).toBe(last.n);
	});
});

describe("annotations and decisions", () => {
	it("persists annotations on the revision they belong to", () => {
		const session = makeSession();
		setPlanAnnotations(session, 1, {
			global: [{ verdict: "change", comment: "rethink scope" }],
			blocks: [{ blockId: session.versions[0].blocks[0].id, annotations: [{ verdict: "question", comment: "why?" }] }],
		});
		const reloaded = loadPlanSession(session.dir);
		expect(reloaded.versions[0].annotations.global).toHaveLength(1);
		expect(reloaded.versions[0].annotations.blocks[0].annotations[0].verdict).toBe("question");
	});

	it("records a decision with a timestamp", () => {
		const session = makeSession();
		recordPlanDecision(session, 1, "approve", at(5));
		expect(loadPlanSession(session.dir).versions[0].decision).toEqual({
			action: "approve",
			at: at(5).toISOString(),
		});
	});

	it("refuses a revision that does not exist", () => {
		const session = makeSession();
		expect(() => recordPlanDecision(session, 99, "approve")).toThrow(/no plan revision 99/);
		expect(() => setPlanAnnotations(session, 99, { global: [], blocks: [] })).toThrow(/no plan revision 99/);
	});
});

describe("loadPlanSession", () => {
	it("reports a corrupt state file with its path", () => {
		const session = makeSession();
		writeFileSync(join(session.dir, "state.json"), "{not json");
		expect(() => loadPlanSession(session.dir)).toThrow(/cannot read plan state at .*state\.json/);
	});

	it("lists sessions that have a state file", () => {
		const session = makeSession();
		const dirs = listPlanSessions(agentDir);
		expect(dirs).toContain(session.dir);
	});
});
