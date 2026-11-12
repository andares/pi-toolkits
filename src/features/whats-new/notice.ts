/**
 * whats-new feature — startup notice text.
 *
 * Pure string building, capped so an upgrade across many releases cannot push
 * the first prompt off the screen. The full text always stays in the bundled
 * `CHANGELOG.md`.
 */
import type { ReleaseNote } from "./changelog.js";
import {
	MAX_NOTES_PER_VERSION,
	MAX_VERSIONS_IN_NOTICE,
} from "./constants.js";

/** Data carried by the `whats-new:notice` session entry. */
export interface NoticeData {
	title: string;
	lines: string[];
}

export interface SectionOptions {
	maxVersions?: number;
	maxNotesPerVersion?: number;
}

/** `version` heading plus indented bullets, newest first. */
export function renderReleaseSections(
	releases: ReleaseNote[],
	options: SectionOptions = {},
): string[] {
	const maxVersions = options.maxVersions ?? MAX_VERSIONS_IN_NOTICE;
	const maxNotes = options.maxNotesPerVersion ?? MAX_NOTES_PER_VERSION;
	const shown = releases.slice(0, maxVersions);
	const lines: string[] = [];

	for (const release of shown) {
		lines.push(release.version);
		for (const note of release.notes.slice(0, maxNotes)) {
			lines.push(`  - ${note}`);
		}
		const hiddenNotes = release.notes.length - Math.min(release.notes.length, maxNotes);
		if (hiddenNotes > 0) {
			lines.push(`  - (+${hiddenNotes} more in CHANGELOG.md)`);
		}
	}

	const hiddenVersions = releases.length - shown.length;
	if (hiddenVersions > 0) {
		lines.push(
			`(+${hiddenVersions} older version${hiddenVersions === 1 ? "" : "s"} — see CHANGELOG.md)`,
		);
	}

	return lines;
}

/** Startup notice: what changed between the recorded version and this one. */
export function buildUpgradeNotice(
	from: string,
	to: string,
	releases: ReleaseNote[],
): NoticeData {
	const sections = renderReleaseSections(releases);
	const lines =
		sections.length > 0
			? sections
			: ["No release notes are bundled for this version."];
	return { title: `pi-toolkits updated ${from} → ${to}`, lines };
}
