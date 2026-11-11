/**
 * UAT feature — change records on disk, read and written.
 *
 * A change record is one Markdown file in `.agents/implementations/`. The shape
 * is deliberately thin: the first line carries the time to the minute, the rest
 * is free prose the agent reads later. This module owns exactly three things:
 *
 *   1. the canonical first line (`# YYYY-MM-DDTHH:MM±HH:MM — title`);
 *   2. the canonical file name (`YYYY-MM-DD_HHMM_slug.md`);
 *   3. a lenient reader that also accepts the older `YYYY-MM-DD_slug.md` /
 *      seconds-precision files, because renaming history would break every
 *      pointer written into FINISHED.md, specs and other records.
 *
 * The reader is the fallback index of the whole UAT flow: a record exists as
 * soon as the file exists, whether or not `record_change` was used. That keeps
 * acceptance usable in a project that never adopted the tool.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";

export interface RecordEntry {
	/** File name without `.md`; also the ledger's report id. */
	id: string;
	/** Path relative to the project root, POSIX separators. */
	path: string;
	title: string;
	/** Timestamp exactly as parsed from the first line (may be second-precision). */
	at?: string;
	/** Ordering key; 0 when nothing could be parsed. */
	epochMs: number;
	firstLine: string;
	/** First line and file name already follow the canonical minute shape. */
	canonical: boolean;
	/** File name carries `_HHMM`. */
	nameHasTime: boolean;
	slug: string;
}

export interface CreateRecordInput {
	title: string;
	/** Prose body. A leading `# title` line is dropped — the tool owns the header. */
	body: string;
	/** Clock injection for tests. */
	now?: Date;
	slug?: string;
}

const HEADER_RE =
	/^#\s+(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?\s+[—–-]\s+(.+)$/;
const NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2}))?_(.+)$/;

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

/** Local time with the numeric offset, to the minute: `2026-11-13T21:07+08:00`. */
export function isoMinute(date: Date): string {
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const absolute = Math.abs(offset);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
		date.getHours(),
	)}:${pad(date.getMinutes())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The canonical first line of a change record. */
export function formatRecordHeader(title: string, at: string): string {
	return `# ${at} — ${title}`;
}

export function parseRecordHeader(line: string):
	| { at: string; title: string; minute: string; hasSeconds: boolean }
	| undefined {
	const match = HEADER_RE.exec(line.trim());
	if (!match) return undefined;
	const [, date, hours, minutes, seconds, offset, title] = match;
	const zone = offset ?? "";
	const at = `${date}T${hours}:${minutes}${seconds ? `:${seconds}` : ""}${zone}`;
	return {
		at,
		title: (title ?? "").trim(),
		minute: `${date}T${hours}:${minutes}`,
		hasSeconds: seconds !== undefined,
	};
}

/** `2026-11-13_2107_slug` → `{date: "2026-11-13", hhmm: "2107", slug}`. */
export function parseRecordFileName(name: string):
	| { date: string; hhmm?: string; slug: string }
	| undefined {
	const base = name.endsWith(".md") ? name.slice(0, -3) : name;
	const match = NAME_RE.exec(base);
	if (!match) return undefined;
	const [, date, hh, mm, slug] = match;
	return { date, hhmm: hh && mm ? `${hh}${mm}` : undefined, slug };
}

/** ASCII slug from a title; non-ASCII titles fall back to `change`. */
export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug.length >= 3 ? slug : "change";
}

/** Rewrite one file name into the canonical minute-precision shape. */
export function canonicalRecordName(at: string, slug: string): string {
	const [date, time] = at.split("T");
	const hhmm = (time ?? "").slice(0, 2).concat((time ?? "").slice(3, 5));
	return `${date}_${hhmm}_${slug}`;
}

/**
 * Read every top-level change record. Subdirectories (`archive/<year>/`) are
 * skipped on purpose: archived records are rolled up already and would
 * resurrect acceptance debt that was settled before the roll-up.
 */
export function listRecords(root: string): RecordEntry[] {
	const dir = join(root, ".agents/implementations");
	if (!existsSync(dir)) return [];
	const entries: RecordEntry[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".md")) continue;
		const absolute = join(dir, name);
		let stat;
		try {
			stat = statSync(absolute);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		let text = "";
		try {
			text = readFileSync(absolute, "utf8");
		} catch {
			continue;
		}
		const firstLine = (text.split("\n", 1)[0] ?? "").trim();
		const header = parseRecordHeader(firstLine);
		const parsedName = parseRecordFileName(name);
		const id = name.slice(0, -3);

		let epochMs = header ? Date.parse(header.at) : Number.NaN;
		if (!Number.isFinite(epochMs)) {
			// Fall back to the file name, then to mtime. Never invent "now": an
			// undated record must not jump to the top of the acceptance queue.
			const fromName = parsedName
				? Date.parse(
						`${parsedName.date}T${
							parsedName.hhmm
								? `${parsedName.hhmm.slice(0, 2)}:${parsedName.hhmm.slice(2)}`
								: "00:00"
						}`,
					)
				: Number.NaN;
			epochMs = Number.isFinite(fromName) ? fromName : stat.mtimeMs;
		}

		const nameMinute = parsedName?.hhmm
			? `${parsedName.date}T${parsedName.hhmm.slice(0, 2)}:${parsedName.hhmm.slice(2)}`
			: undefined;
		const canonical =
			header !== undefined &&
			!header.hasSeconds &&
			nameMinute !== undefined &&
			header.minute === nameMinute;

		entries.push({
			id,
			path: posix.join(".agents/implementations", name),
			title: header?.title ?? (firstLine.replace(/^#+\s*/, "") || parsedName?.slug || id),
			at: header?.at,
			epochMs: Number.isFinite(epochMs) ? epochMs : 0,
			firstLine,
			canonical,
			nameHasTime: nameMinute !== undefined,
			slug: parsedName?.slug ?? id,
		});
	}
	for (const entry of entries) entry.epochMs = entry.epochMs || 0;
	entries.sort((a, b) => b.epochMs - a.epochMs || a.id.localeCompare(b.id));
	return entries;
}

/** One-line title: collapse whitespace so the header stays one line. */
export function normalizeTitle(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Write one record and return its entry. Collisions inside the same minute get
 * a `-2`, `-3` suffix instead of overwriting a sibling.
 */
export function createRecord(
	root: string,
	input: CreateRecordInput,
): { entry: RecordEntry; absolute: string } {
	const now = input.now ?? new Date();
	const at = isoMinute(now);
	const title = normalizeTitle(input.title);
	if (title === "") throw new Error("record title is required");
	const slug = input.slug ? slugify(input.slug) : slugify(title);
	const dir = join(root, ".agents/implementations");
	mkdirSync(dir, { recursive: true });

	const header = formatRecordHeader(title, at);
	const body = stripLeadingHeading(input.body ?? "");
	const content = body === "" ? `${header}\n` : `${header}\n\n${body}\n`;

	let name = `${canonicalRecordName(at, slug)}.md`;
	// `existsSync` + a normal write has a race between two sessions in the same
	// minute. Exclusive create makes the filename claim atomic: only the loser
	// advances to `-2`, and neither process can overwrite the other's record.
	for (let suffix = 2; ; suffix += 1) {
		if (suffix > 99) throw new Error("too many records in the same minute");
		const absolute = join(dir, name);
		try {
			writeFileSync(absolute, content, { encoding: "utf8", flag: "wx" });
			const entry: RecordEntry = {
				id: name.slice(0, -3),
				path: posix.join(".agents/implementations", name),
				title,
				at,
				epochMs: Date.parse(at) || now.getTime(),
				firstLine: header,
				canonical: true,
				nameHasTime: true,
				slug,
			};
			return { entry, absolute };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			name = `${canonicalRecordName(at, slug)}-${suffix}.md`;
		}
	}
}

/** Drop a leading `# ...` line: the tool owns the header, the body is prose. */
function stripLeadingHeading(body: string): string {
	const trimmed = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
	if (!trimmed.startsWith("#")) return trimmed;
	const newline = trimmed.indexOf("\n");
	return newline === -1 ? "" : trimmed.slice(newline + 1).trim();
}

/** Text of one record by id, bounded so a huge file cannot flood the page. */
export function readRecordText(root: string, id: string, limit = 128 * 1024): string | undefined {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined;
	const absolute = join(root, ".agents/implementations", `${id}.md`);
	if (!existsSync(absolute)) return undefined;
	try {
		const text = readFileSync(absolute, "utf8");
		return text.length > limit ? `${text.slice(0, limit)}\n\n… (truncated)` : text;
	} catch {
		return undefined;
	}
}
