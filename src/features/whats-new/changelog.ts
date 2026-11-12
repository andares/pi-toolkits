/**
 * whats-new feature — `CHANGELOG.md` parsing.
 *
 * Contract with the release script (scripts/lib/changelog.mjs):
 *
 *   - one `## <version>` section per released version, optionally decorated
 *     (`## [0.14.0] — 2026-11-12`); the first `X.Y.Z` in the heading wins;
 *   - `## Unreleased` holds the notes for the next release; `pnpm release`
 *     renames that heading to the version it is about to publish;
 *   - top-level bullets are the notes shown in the notice; nested bullets are
 *     detail for humans reading the file and are not repeated in the TUI.
 *
 * Parsing is tolerant on purpose: a malformed section is skipped, never fatal.
 * A missing file degrades to "no notes" with one warning — an extension must
 * not break a session because a documentation file moved.
 */
import { readFileSync } from "node:fs";
import { defaultChangelogFile } from "./paths.js";
import { compareVersions, parseVersion } from "./version.js";

export interface ReleaseNote {
	version: string;
	notes: string[];
}

const HEADING_RE = /^##\s+(.+?)\s*$/;
const VERSION_IN_HEADING_RE = /\[?v?(\d+\.\d+\.\d+)\]?/;
const BULLET_RE = /^[-*]\s+(.+?)\s*$/;

/** Split a changelog into version sections, in document order. */
export function parseChangelog(markdown: string): ReleaseNote[] {
	const releases: ReleaseNote[] = [];
	let current: ReleaseNote | undefined;

	for (const line of markdown.split(/\r?\n/)) {
		const heading = HEADING_RE.exec(line);
		if (heading) {
			const match = VERSION_IN_HEADING_RE.exec(heading[1]);
			current = match ? { version: match[1], notes: [] } : undefined;
			if (current) releases.push(current);
			continue;
		}
		if (!current) continue;
		const bullet = BULLET_RE.exec(line);
		if (bullet) current.notes.push(bullet[1]);
	}

	return releases;
}

/** Newest first. */
export function sortReleasesDescending(releases: ReleaseNote[]): ReleaseNote[] {
	return [...releases].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Notes for a `from → to` upgrade: `from < version <= to`, newest first.
 * Equal and older versions are excluded so a downgrade never replays notes.
 */
export function releasesForUpgrade(
	releases: ReleaseNote[],
	from: string,
	to: string,
): ReleaseNote[] {
	return sortReleasesDescending(releases).filter(
		(release) =>
			compareVersions(release.version, from) > 0 &&
			compareVersions(release.version, to) <= 0,
	);
}

/** Paths already warned about, so a missing file warns once per process. */
const warned = new Set<string>();

/** Read and parse the notes; a missing/invalid file becomes an empty list. */
export function readChangelog(file: string = defaultChangelogFile()): ReleaseNote[] {
	try {
		return parseChangelog(readFileSync(file, "utf8"));
	} catch (error) {
		if (!warned.has(file)) {
			warned.add(file);
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/whats-new] Failed to read release notes:",
				error instanceof Error ? error.message : String(error),
			);
		}
		return [];
	}
}

/** The version this copy of the package was published as, if readable. */
export function readPackageVersion(file: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const version = (parsed as { version?: unknown }).version;
		return typeof version === "string" && parseVersion(version) !== undefined
			? version
			: undefined;
	} catch {
		return undefined;
	}
}
