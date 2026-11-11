import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendEvent,
	deriveState,
	ledgerPath,
	newEventId,
	parseEvents,
	readEvents,
	type CandidateEvent,
	type CheckEvent,
	type ItemEvent,
	type UatEvent,
} from "./ledger.js";
import { createRecord, type RecordEntry } from "./records.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "uat-ledger-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function event<T extends Omit<UatEvent, "v" | "id" | "ts">>(
	body: T,
	ts = "2026-11-13T21:00+08:00",
): UatEvent {
	counter += 1;
	return { v: 1, id: `e-test-${counter}`, ts, ...body } as unknown as UatEvent;
}

function record(title: string, at: Date): RecordEntry {
	return createRecord(root, { title, body: "body", now: at }).entry;
}

function candidate(report: string, behavior = "operator sees it"): CandidateEvent {
	return event({ type: "candidate", report, title: report, behavior }) as CandidateEvent;
}

function item(id: string, reports: string[], ts = "2026-11-13T21:00+08:00"): ItemEvent {
	return event(
		{ type: "item", item: id, title: id, summary: "summary", reports },
		ts,
	) as ItemEvent;
}

function check(id: string, ts: string): CheckEvent {
	return event({ type: "check", item: id }, ts) as CheckEvent;
}

describe("event stream", () => {
	it("appends and reads back", () => {
		const file = ledgerPath(root);
		appendEvent(file, candidate("a"));
		appendEvent(file, item("U-1", ["a"]));
		const { events, skipped } = readEvents(file);
		expect(events).toHaveLength(2);
		expect(skipped).toBe(0);
		expect(events[0]?.type).toBe("candidate");
	});

	it("skips malformed lines and duplicate ids", () => {
		const duplicate = candidate("a");
		const parsed = parseEvents(
			[
				JSON.stringify(duplicate),
				"{not json",
				JSON.stringify(duplicate),
				JSON.stringify({ id: "x", ts: "t", v: 1, type: "nope" }),
			].join("\n"),
		);
		expect(parsed.events).toHaveLength(1);
		expect(parsed.skipped).toBe(2);
	});

	it("skips structurally invalid events instead of crashing derivation", () => {
		const parsed = parseEvents(
			JSON.stringify({
				v: 1,
				id: "bad-item",
				ts: "2026-11-13T21:00+08:00",
				type: "item",
				item: "U-bad",
				title: "bad",
				summary: "missing reports",
			}),
		);
		expect(parsed.events).toEqual([]);
		expect(parsed.skipped).toBe(1);
		expect(() => deriveState([], parsed.events)).not.toThrow();
	});

	it("repairs a file whose last line has no newline", () => {
		const file = ledgerPath(root);
		mkdirSync(join(root, ".agents/uat"), { recursive: true });
		writeFileSync(file, JSON.stringify(candidate("a")), "utf8");
		appendEvent(file, candidate("b"));
		const text = readFileSync(file, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(readEvents(file).events).toHaveLength(2);
	});

	it("generates distinct ids", () => {
		const ids = new Set(Array.from({ length: 50 }, () => newEventId()));
		expect(ids.size).toBe(50);
	});
});

describe("derivation", () => {
	it("keeps unreferenced records pending and enriches them", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const b = record("beta", new Date(2026, 10, 13, 10, 0));
		const state = deriveState([a, b], [candidate(a.id, "alpha behaviour")]);
		expect(state.pending.map((entry) => entry.id)).toEqual([b.id, a.id]);
		expect(state.pending[1]?.behavior).toBe("alpha behaviour");
		expect(state.counts.pending).toBe(2);
	});

	it("maps one record into several items and several records into one item", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const b = record("beta", new Date(2026, 10, 13, 10, 0));
		const state = deriveState(
			[a, b],
			[item("U-1", [a.id]), item("U-2", [a.id, b.id]), event({ type: "link", item: "U-2", reports: [a.id] })],
		);
		expect(state.items).toHaveLength(2);
		expect(state.items.find((entry) => entry.id === "U-2")?.reports).toEqual([a.id, b.id]);
		expect(state.pending).toEqual([]);
	});

	it("reopens an item when new evidence is newer than the check", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const b = record("beta", new Date(2026, 10, 14, 9, 0));
		const state = deriveState(
			[a, b],
			[
				item("U-1", [a.id], "2026-11-13T20:00+08:00"),
				check("U-1", "2026-11-13T21:00+08:00"),
				event({ type: "link", item: "U-1", reports: [b.id] }, "2026-11-14T10:00+08:00"),
			],
		);
		const entry = state.items.find((candidateItem) => candidateItem.id === "U-1");
		expect(entry?.checkedAt).toBe("2026-11-13T21:00+08:00");
		expect(entry?.reopened).toBe(true);
		expect(state.open.map((candidateItem) => candidateItem.id)).toEqual(["U-1"]);
		expect(state.checked).toEqual([]);
	});

	it("reopens when evidence is linked later in the same minute as the check", () => {
		const a = record("alpha", new Date(2026, 10, 13, 21, 7));
		const b = record("beta", new Date(2026, 10, 13, 21, 7));
		const state = deriveState(
			[a, b],
			[
				item("U-1", [a.id], "2026-11-13T21:06:00+08:00"),
				check("U-1", "2026-11-13T21:07:10+08:00"),
				event(
					{ type: "link", item: "U-1", reports: [b.id] },
					"2026-11-13T21:07:50+08:00",
				),
			],
		);
		expect(state.open.map((entry) => entry.id)).toEqual(["U-1"]);
		expect(state.items[0]?.reopened).toBe(true);
	});

	it("keeps a checked item checked when no newer evidence exists", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const state = deriveState([a], [item("U-1", [a.id], "2026-11-13T20:00+08:00"), check("U-1", "2026-11-13T21:00+08:00")]);
		expect(state.checked.map((entry) => entry.id)).toEqual(["U-1"]);
		expect(state.open).toEqual([]);
	});

	it("unchecks on the uncheck event", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const state = deriveState(
			[a],
			[
				item("U-1", [a.id], "2026-11-13T20:00+08:00"),
				check("U-1", "2026-11-13T21:00+08:00"),
				event({ type: "uncheck", item: "U-1" }, "2026-11-13T22:00+08:00"),
			],
		);
		expect(state.open.map((entry) => entry.id)).toEqual(["U-1"]);
	});

	it("merges sources into the target and hides them", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const b = record("beta", new Date(2026, 10, 13, 10, 0));
		const state = deriveState(
			[a, b],
			[
				item("U-1", [a.id]),
				item("U-2", [b.id]),
				event({ type: "merge", item: "U-1", sources: ["U-2"] }),
			],
		);
		expect(state.items.map((entry) => entry.id)).toEqual(["U-1"]);
		expect(state.items[0]?.reports).toEqual([a.id, b.id]);
		expect(state.pending).toEqual([]);
	});

	it("drops an item without resurrecting its evidence as pending", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const state = deriveState([a], [item("U-1", [a.id]), event({ type: "drop", item: "U-1", reason: "abandoned" })]);
		expect(state.items).toEqual([]);
		// Dropping retires the behaviour and its evidence; putting the records
		// back into pending would recreate the abandoned work on the next run.
		expect(state.pending).toEqual([]);
	});

	it("reopens a checked target when an unchecked item is merged into it", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const b = record("beta", new Date(2026, 10, 12, 9, 0));
		const state = deriveState(
			[a, b],
			[
				item("U-target", [a.id], "2026-11-13T10:00+08:00"),
				item("U-source", [b.id], "2026-11-12T10:00+08:00"),
				check("U-target", "2026-11-13T11:00+08:00"),
				event({ type: "merge", item: "U-target", sources: ["U-source"] }, "2026-11-13T12:00+08:00"),
			],
		);
		expect(state.open.map((entry) => entry.id)).toEqual(["U-target"]);
		expect(state.checked).toEqual([]);
	});

	it("amends the text without touching evidence", () => {
		const a = record("alpha", new Date(2026, 10, 13, 9, 0));
		const state = deriveState(
			[a],
			[item("U-1", [a.id]), event({ type: "amend", item: "U-1", title: "renamed", steps: ["click"] })],
		);
		expect(state.items[0]?.title).toBe("renamed");
		expect(state.items[0]?.steps).toEqual(["click"]);
		expect(state.items[0]?.reports).toEqual([a.id]);
	});

	it("reports evidence ids that no longer exist on disk", () => {
		const state = deriveState([], [item("U-1", ["gone"])]);
		expect(state.items[0]?.missingReports).toEqual(["gone"]);
	});
});
