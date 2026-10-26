/**
 * init feature — coverage accounting.
 *
 * "Nothing was lost" is only checkable if the migration *declares* where every
 * source section went. This module extracts source sections, looks for a
 * destination that already contains the same heading or its opening paragraph,
 * and renders the remaining rows as a table the model must fill in.
 *
 * What it proves: every source section has a destination or a written reason.
 * What it cannot prove: that the destination kept the fact intact. That is why
 * the default migration pass is conservative and why the diff is reviewed.
 */
import {
	normalizeHeading,
	normalizeProse,
	sectionAnchor,
	topSections,
} from "./analyze.js";
import type {
	CoverageReport,
	CoverageRow,
	DocInfo,
} from "./types.js";

/** Destination docs searched for a section's heading or anchor. */
export function buildCoverage(
	sources: readonly DocInfo[],
	targets: readonly DocInfo[],
	mapping: ReadonlyMap<string, { destination: string; reason?: string }> = new Map(),
): CoverageReport {
	const rows: CoverageRow[] = [];
	const targetText = targets.map((doc) => ({
		rel: doc.rel,
		headings: new Map(topSections(doc).map((heading) => [normalizeHeading(heading.text), heading])),
		prose: normalizeProse(doc.text),
	}));

	for (const source of sources) {
		for (const heading of topSections(source)) {
			const key = normalizeHeading(heading.text);
			if (key.length < 2) continue;
			const anchor = normalizeProse(sectionAnchor(source, heading)).slice(0, 60);

			let hit: string | undefined;
			for (const target of targetText) {
				if (target.headings.has(key)) {
					hit = `${target.rel} §${target.headings.get(key)?.text ?? heading.text}`;
					break;
				}
				if (anchor.length >= 8 && target.prose.includes(anchor)) {
					hit = `${target.rel} (opening paragraph)`;
					break;
				}
			}

			const declared = mapping.get(`${source.rel}#${heading.text}`);
			if (hit) {
				rows.push({ source: source.rel, heading: heading.text, status: "hit", destination: hit });
			} else if (declared) {
				rows.push({
					source: source.rel,
					heading: heading.text,
					status: "mapped",
					destination: declared.destination,
					reason: declared.reason,
				});
			} else {
				rows.push({ source: source.rel, heading: heading.text, status: "open" });
			}
		}
	}

	return {
		rows,
		hit: rows.filter((row) => row.status === "hit").length,
		mapped: rows.filter((row) => row.status === "mapped").length,
		open: rows.filter((row) => row.status === "open").length,
	};
}

const STATUS_LABEL = {
	hit: "found",
	mapped: "declared",
	open: "OPEN",
} as const;

/** Render the table the model fills in (and the audit reads back). */
export function renderCoverage(
	report: CoverageReport,
	context: { createdAt: string; sources: string[]; targets: string[] },
): string {
	const lines = [
		"# Migration coverage",
		"",
		`- created: ${context.createdAt}`,
		`- sources: ${context.sources.join(", ")}`,
		`- targets: ${context.targets.join(", ")}`,
		"",
		"> Every section of every source must end up either found in a destination,",
		"> declared with a destination, or declared as dropped with a reason. A row",
		"> left `OPEN` blocks the migration from being called complete.",
		"",
		"| Source | Section | Status | Destination | Reason |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const row of report.rows) {
		lines.push(
			`| ${row.source} | ${escapeCell(row.heading)} | ${STATUS_LABEL[row.status]} | ${
				row.destination ? escapeCell(row.destination) : ""
			} | ${row.reason ? escapeCell(row.reason) : ""} |`,
		);
	}
	lines.push(
		"",
		`Summary: ${report.hit} found, ${report.mapped} declared, ${report.open} open.`,
		"",
	);
	return lines.join("\n");
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Read a filled coverage table back. Tolerant on purpose: the model edits this
 * file, and a formatting wobble should not make the audit blind.
 */
export function parseCoverage(text: string): CoverageReport {
	const rows: CoverageRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("|")) continue;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim());
		if (cells.length < 3) continue;
		if (/^-+$/.test(cells[0]) || cells[0] === "Source") continue;
		const status = cells[2].toLowerCase();
		// A declared/found row without a destination is not accounted for: the
		// table is the evidence, so an empty cell must not make it pass.
		const hasDestination = Boolean(cells[3]);
		const parsed =
			(status === "found" || status === "hit") && hasDestination
				? "hit"
				: (status === "declared" || status === "mapped") && hasDestination
					? "mapped"
					: "open";
		rows.push({
			source: cells[0],
			heading: cells[1],
			status: parsed,
			destination: cells[3] ? cells[3] : undefined,
			reason: cells[4] ? cells[4] : undefined,
		});
	}
	return {
		rows,
		hit: rows.filter((row) => row.status === "hit").length,
		mapped: rows.filter((row) => row.status === "mapped").length,
		open: rows.filter((row) => row.status === "open").length,
	};
}
