/**
 * init feature — pure document analysis shared by the planner and the auditor.
 *
 * These helpers answer questions about *documents*, not about the filesystem:
 * duplicated sections, tombstones, appendix ordering, oversized sections and
 * path references. Keeping them here means the plan's warnings and the audit's
 * findings cannot drift apart.
 */
import type { DocInfo, Heading } from "./types.js";

/** Normalise a heading for comparison: drop numbering, markup, emoji, case. */
export function normalizeHeading(text: string): string {
	return text
		.replace(/^[§#\s]*\d+(?:[.\-–]\d+)*[.、:)]?\s*/, "")
		.replace(/[`*_~[\]]/g, "")
		.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
		.replace(/[\s\u3000]+/g, "")
		.replace(/[：:，,。.、（）()]/g, "")
		.toLowerCase();
}

/** H2 headings (level 2 only) of a document. */
export function topSections(doc: DocInfo): Heading[] {
	return doc.headings.filter((heading) => heading.level === 2);
}

export interface DuplicateGroup {
	readonly normalized: string;
	readonly occurrences: Array<{ path: string; heading: string; line: number }>;
}

/** Same H2 heading appearing in two or more documents. */
export function duplicateHeadings(docs: readonly DocInfo[]): DuplicateGroup[] {
	const groups = new Map<string, DuplicateGroup["occurrences"]>();
	for (const doc of docs) {
		for (const heading of topSections(doc)) {
			const key = normalizeHeading(heading.text);
			if (key.length < 2) continue;
			const list = groups.get(key) ?? [];
			list.push({ path: doc.rel, heading: heading.text, line: heading.line });
			groups.set(key, list);
		}
	}
	const out: DuplicateGroup[] = [];
	for (const [normalized, occurrences] of groups) {
		if (occurrences.length < 2) continue;
		// Same file twice is a different problem (repeated section), still useful.
		out.push({ normalized, occurrences });
	}
	return out.sort((a, b) => b.occurrences.length - a.occurrences.length);
}

/** Section bodies as `[heading, body]`, body ending at the next same-or-higher heading. */
export function sectionBodies(doc: DocInfo): Array<{ heading: Heading; body: string }> {
	const lines = doc.text.split("\n");
	const out: Array<{ heading: Heading; body: string }> = [];
	for (const heading of doc.headings) {
		if (heading.level !== 2) continue;
		const start = heading.line; // 0-based index of the line *after* the heading
		let end = lines.length;
		for (const other of doc.headings) {
			if (other.line <= heading.line) continue;
			if (other.level <= 2) {
				end = other.line - 1;
				break;
			}
		}
		out.push({ heading, body: lines.slice(start, end).join("\n").trim() });
	}
	return out;
}

const POINTER_PHRASES =
	/(已迁|迁至|移至|见\s*`|参见\s*`|moved to|see\s+`|已并入|merged into)/i;

/**
 * A "tombstone": a section whose whole body is a one-line pointer to wherever
 * the content went. After the move is registered in the index such sections are
 * pure noise, so the plan asks for their removal.
 */
export function tombstones(doc: DocInfo): Heading[] {
	const out: Heading[] = [];
	for (const { heading, body } of sectionBodies(doc)) {
		if (body.length === 0 || body.length > 220) continue;
		if (!POINTER_PHRASES.test(body)) continue;
		const meaningful = body
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("|"));
		if (meaningful.length <= 3) out.push(heading);
	}
	return out;
}

/**
 * Headings that sit after the historical appendix started. Appendices are the
 * last thing in a document by convention; dated sections appended later mean
 * the file grew without a compacting pass.
 */
export function sectionsAfterAppendix(doc: DocInfo): Heading[] {
	const sections = topSections(doc);
	const firstAppendix = sections.findIndex((heading) =>
		/^(附录|appendix)/i.test(heading.text.trim()),
	);
	if (firstAppendix < 0) return [];
	return sections
		.slice(firstAppendix + 1)
		.filter((heading) => !/^(附录|appendix)/i.test(heading.text.trim()));
}

/** The N largest H2 sections, with their character counts (split candidates). */
export function largestSections(
	doc: DocInfo,
	limit = 3,
): Array<{ heading: Heading; chars: number }> {
	return sectionBodies(doc)
		.map(({ heading, body }) => ({ heading, chars: body.length }))
		.sort((a, b) => b.chars - a.chars)
		.slice(0, limit);
}

/**
 * Paths mentioned in a document that the framework can verify: memory files,
 * specs, implementation records. Returned without the surrounding backticks so
 * callers can `existsSync` them directly.
 */
export function extractFrameworkPaths(text: string): string[] {
	const out = new Set<string>();
	const re =
		/(?:\.agents\/memory\/(?:[\w.\-]+\.md)|specs\/[\w./-]+\.md|\.agents\/implementations\/[\w.\-]+\.md)/g;
	for (const match of text.matchAll(re)) out.add(match[0]);
	return [...out];
}

/** First paragraph of a section, used as the coverage anchor. */
export function sectionAnchor(doc: DocInfo, heading: Heading): string {
	const lines = doc.text.split("\n");
	let index = heading.line; // first line after the heading
	let collected = "";
	let started = false;
	for (; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (/^#{1,6}\s/.test(line)) break;
		if (line.length === 0) {
			if (started) break;
			continue;
		}
		if (/^([-*+]\s|\d+[.)]\s|\||>)/.test(line)) continue;
		collected = collected.length === 0 ? line : `${collected} ${line}`;
		started = true;
		if (collected.length >= 80) break;
	}
	return collected.slice(0, 80);
}

/** Normalise prose for anchor matching (drop markdown emphasis and spacing). */
export function normalizeProse(text: string): string {
	return text
		.replace(/[`*_~[\]]/g, "")
		.replace(/[\s\u3000]+/g, "")
		.toLowerCase();
}
