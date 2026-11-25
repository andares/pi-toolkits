/**
 * keep feature — text rendering.
 *
 * Pure string building so the rows, the startup notice and the resume note can
 * be asserted without a terminal. Age is deliberately coarse (`12m`, `3h`,
 * `2d`): the exact minute of a decision is in the ledger, not in the list.
 */
import { basename } from "node:path";
import type { KeepEntryView } from "./ledger.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** `now` / `12m` / `3h` / `2d` / `5w`. */
export function formatAge(iso: string, now: Date): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "?";
	const diff = now.getTime() - then;
	if (diff < MINUTE) return "now";
	if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
	if (diff < 2 * WEEK) return `${Math.floor(diff / DAY)}d`;
	return `${Math.floor(diff / WEEK)}w`;
}

/** `2026-11-24 15:02` in local time (no locale dependence). */
export function formatStamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Last path segment, used as the project column with `--all`. */
export function projectName(cwd: string): string {
	const name = basename(cwd);
	return name.length > 0 ? name : cwd;
}

/**
 * One list row: state glyph, age, note, then optional project and `missing`.
 * `○` is not loaded, `●` is loaded (the row is dimmed by the picker).
 */
export function rowText(
	entry: KeepEntryView,
	options: { readonly now: Date; readonly showProject: boolean },
): string {
	const glyph = entry.loaded ? "●" : "○";
	const age = formatAge(entry.keptAt, options.now);
	const parts = [entry.note.length > 0 ? entry.note : "(no note)"];
	if (options.showProject) parts.push(projectName(entry.cwd));
	if (entry.missing) parts.push("missing");
	return `${glyph} ${age}  ${parts.join("  ·  ")}`;
}

/** Header line above the rows. */
export function pickerTitle(notLoaded: number, loaded: number): string {
	const parts = [`${notLoaded} not loaded`];
	if (loaded > 0) parts.push(`${loaded} loaded`);
	return `Keep backlog — ${parts.join(", ")}`;
}

/** Startup notice: one line, counts only, current project only. */
export function noticeText(count: number): string {
	return `${count} not loaded · /keep-load`;
}

/**
 * Message injected into a loaded session. It is a `custom_message`, so the
 * model sees it on the next turn without the note triggering a turn of its own.
 */
export function resumeText(entry: KeepEntryView): string {
	const note = entry.note.length > 0 ? entry.note : "(no note)";
	return `[keep] Resumed from the backlog — note left ${formatStamp(entry.keptAt)}: "${note}"`;
}
