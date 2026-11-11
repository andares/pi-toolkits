import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalRecordName,
	createRecord,
	isoMinute,
	listRecords,
	parseRecordFileName,
	parseRecordHeader,
	readRecordText,
	slugify,
} from "./records.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "uat-records-"));
	mkdirSync(join(root, ".agents/implementations"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeRaw(name: string, text: string): void {
	writeFileSync(join(root, ".agents/implementations", name), text, "utf8");
}

describe("header and name shapes", () => {
	it("parses the canonical minute header", () => {
		const parsed = parseRecordHeader("# 2026-11-13T21:07+08:00 — Ask UAT lands");
		expect(parsed).toEqual({
			at: "2026-11-13T21:07+08:00",
			title: "Ask UAT lands",
			minute: "2026-11-13T21:07",
			hasSeconds: false,
		});
	});

	it("still parses the older seconds-precision header", () => {
		const parsed = parseRecordHeader("# 2026-11-11T02:55:59+08:00 — legacy");
		expect(parsed?.hasSeconds).toBe(true);
		expect(parsed?.title).toBe("legacy");
	});

	it("rejects a plain heading", () => {
		expect(parseRecordHeader("# Just a title")).toBeUndefined();
	});

	it("reads both file-name generations", () => {
		expect(parseRecordFileName("2026-11-13_2107_ask-uat.md")).toEqual({
			date: "2026-11-13",
			hhmm: "2107",
			slug: "ask-uat",
		});
		expect(parseRecordFileName("2026-11-11_ask-plan.md")).toEqual({
			date: "2026-11-11",
			hhmm: undefined,
			slug: "ask-plan",
		});
	});

	it("builds the canonical name and slug", () => {
		expect(canonicalRecordName("2026-11-13T21:07+08:00", "ask-uat")).toBe("2026-11-13_2107_ask-uat");
		expect(slugify("Ask UAT 落地！")).toBe("ask-uat");
		expect(slugify("验收台")).toBe("change");
	});
});

describe("listRecords", () => {
	it("accepts old records and marks them non-canonical", () => {
		writeRaw("2026-11-11_ask-plan.md", "# 2026-11-11T02:55:59+08:00 — plan review\n\nbody\n");
		const [record] = listRecords(root);
		expect(record.id).toBe("2026-11-11_ask-plan");
		expect(record.title).toBe("plan review");
		expect(record.canonical).toBe(false);
		expect(record.epochMs).toBeGreaterThan(0);
	});

	it("marks canonical records and sorts newest first", () => {
		writeRaw("2026-11-12_0900_old.md", "# 2026-11-12T09:00+08:00 — old\n");
		writeRaw("2026-11-13_2107_new.md", "# 2026-11-13T21:07+08:00 — new\n");
		const records = listRecords(root);
		expect(records.map((record) => record.id)).toEqual([
			"2026-11-13_2107_new",
			"2026-11-12_0900_old",
		]);
		expect(records[0].canonical).toBe(true);
	});

	it("falls back to the file name when the header is unparsable", () => {
		writeRaw("2026-11-10_0800_freeform.md", "# Whatever happened\n");
		const [record] = listRecords(root);
		expect(record.title).toBe("Whatever happened");
		expect(record.epochMs).toBe(Date.parse("2026-11-10T08:00"));
	});

	it("ignores archived subdirectories", () => {
		mkdirSync(join(root, ".agents/implementations/archive/2025"), { recursive: true });
		writeFileSync(
			join(root, ".agents/implementations/archive/2025/2025-01-01_old.md"),
			"# 2025-01-01T10:00+00:00 — archived\n",
		);
		expect(listRecords(root)).toEqual([]);
	});
});

describe("createRecord", () => {
	it("writes the canonical header, name and body", () => {
		const now = new Date(2026, 10, 13, 21, 7, 30);
		const { entry } = createRecord(root, {
			title: "Ask UAT lands",
			body: "# A duplicate title\n\nWhat changed.",
			now,
		});
		expect(entry.path).toBe(`.agents/implementations/${canonicalRecordName(isoMinute(now), "ask-uat-lands")}.md`);
		const text = readFileSync(join(root, entry.path), "utf8");
		expect(text.split("\n")[0]).toBe(`# ${isoMinute(now)} — Ask UAT lands`);
		expect(text).not.toContain("A duplicate title");
		expect(text).toContain("What changed.");
		expect(entry.canonical).toBe(true);
	});

	it("does not overwrite a record written in the same minute", () => {
		const now = new Date(2026, 10, 13, 21, 7);
		createRecord(root, { title: "same", body: "one", now, slug: "same" });
		const second = createRecord(root, { title: "same", body: "two", now, slug: "same" });
		expect(second.entry.id.endsWith("-2")).toBe(true);
		expect(listRecords(root)).toHaveLength(2);
	});

	it("rejects an empty title", () => {
		expect(() => createRecord(root, { title: "   ", body: "x" })).toThrow(/title/);
	});
});

describe("readRecordText", () => {
	it("reads by id and refuses traversal", () => {
		const { entry } = createRecord(root, { title: "read me", body: "body" });
		expect(readRecordText(root, entry.id)).toContain("read me");
		expect(readRecordText(root, "../etc/passwd")).toBeUndefined();
	});
});
