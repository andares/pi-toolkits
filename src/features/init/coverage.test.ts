import { describe, expect, it } from "vitest";
import { parseHeadings } from "./detect.js";
import { buildCoverage, parseCoverage, renderCoverage } from "./coverage.js";
import type { DocInfo } from "./types.js";

function doc(rel: string, text: string): DocInfo {
	return {
		rel,
		text,
		bytes: text.length,
		lines: text.split("\n").length,
		mtimeMs: 0,
		headings: parseHeadings(text),
	};
}

const SOURCE = doc(
	"AGENTS.md",
	[
		"# demo",
		"",
		"## 定位",
		"",
		"这是一个相片管理软件。",
		"",
		"## 硬规则",
		"",
		"不要猜事实。",
		"",
		"## 术语",
		"",
		"勾选与选中是两回事。",
		"",
	].join("\n"),
);

const TARGET = doc(
	".agents/memory/ARCHITECTURE.md",
	["# Architecture", "", "## 硬规则", "", "不要猜事实。", ""].join("\n"),
);

describe("coverage", () => {
	it("marks a section hit when the destination carries the same heading", () => {
		const report = buildCoverage([SOURCE], [TARGET]);
		const row = report.rows.find((item) => item.heading === "硬规则");
		expect(row?.status).toBe("hit");
	});

	it("counts declared and open sections separately", () => {
		const mapping = new Map([
			["AGENTS.md#定位", { destination: ".agents/memory/ARCHITECTURE.md (intro)" }],
		]);
		const report = buildCoverage([SOURCE], [TARGET], mapping);
		expect(report.hit).toBe(1);
		expect(report.mapped).toBe(1);
		expect(report.open).toBe(1);
	});

	it("finds a section by its opening paragraph when the heading changed", () => {
		const renamed = doc(
			".agents/memory/TERMS.md",
			["# Terms", "", "## 选择语义", "", "勾选与选中是两回事。", ""].join("\n"),
		);
		const report = buildCoverage([SOURCE], [renamed]);
		const row = report.rows.find((item) => item.heading === "术语");
		expect(row?.status).toBe("hit");
	});

	it("renders a table and reads it back", () => {
		const mapping = new Map([
			["AGENTS.md#定位", { destination: "somewhere", reason: "merged" }],
		]);
		const report = buildCoverage([SOURCE], [TARGET], mapping);
		const text = renderCoverage(report, {
			createdAt: "2026-10-26T10:00:00+08:00",
			sources: ["AGENTS.md"],
			targets: [".agents/memory/ARCHITECTURE.md"],
		});
		expect(text).toContain("| AGENTS.md | 硬规则 | found |");
		const parsed = parseCoverage(text);
		expect(parsed.hit).toBe(report.hit);
		expect(parsed.mapped).toBe(report.mapped);
		expect(parsed.open).toBe(report.open);
		expect(parsed.rows.find((row) => row.heading === "定位")?.destination).toBe("somewhere");
	});

	it("treats an unknown status as open so a malformed row cannot pass", () => {
		const parsed = parseCoverage(
			["| Source | Section | Status | Destination | Reason |", "| --- | --- | --- | --- | --- |", "| AGENTS.md | 定位 | declared | | |"].join("\n"),
		);
		expect(parsed.open).toBe(1);
	});
});
