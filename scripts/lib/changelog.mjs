/**
 * CHANGELOG.md promotion for the release script.
 *
 * The extension reads `CHANGELOG.md` at runtime (src/features/whats-new) and
 * announces the sections between the operator's last version and the running
 * one. This module is the write side of that contract:
 *
 *   - notes for the next release live under `## Unreleased`;
 *   - `pnpm release` renames that heading to `## <version> — <date>` so the
 *     published package always contains a section for the version it ships;
 *   - an empty or missing Unreleased section aborts the release: announcing
 *     "what changed" with nothing to say is worse than making the maintainer
 *     write one line (`--skip-changelog` is the explicit escape hatch).
 *
 * Only top-level bullets count as notes — the same rule the runtime parser
 * uses (src/features/whats-new/changelog.ts), so the gate cannot pass on text
 * the notice would never show.
 */

/** A heading at level 2 starts a release section. */
const SECTION_RE = /^##\s+(.+?)\s*$/;
const NOTE_RE = /^[-*]\s+\S/;
const UNRELEASED_RE = /^unreleased\b/i;

/**
 * The instruction line the release script itself writes into a fresh Unreleased
 * section. It is stripped back out when that section is promoted: a released
 * section that still says "notes for the next release go here" ships wrong text
 * to every reader of the package.
 */
export const UNRELEASED_PLACEHOLDER =
	"<!-- Notes for the next release go here; `pnpm release` renames this heading. -->";

/** Locate the Unreleased section: its heading index, body lines, and where it ends. */
export function findUnreleasedSection(markdown) {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => {
		const heading = SECTION_RE.exec(line);
		return heading !== null && UNRELEASED_RE.test(heading[1]);
	});
	if (start === -1) return undefined;

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (SECTION_RE.test(lines[i])) {
			end = i;
			break;
		}
	}
	const body = lines.slice(start + 1, end);
	return {
		start,
		end,
		body,
		notes: body.filter((line) => NOTE_RE.test(line)),
	};
}

/**
 * Whether the next release has notes, without throwing. The release script runs
 * this in its pre-flight: an empty or missing section is a material gap, and the
 * verdict has to be reportable before any gate starts.
 *
 * @param {string} markdown
 * @returns {{ state: "ready" | "empty" | "missing", count: number }}
 */
export function releaseNotesStatus(markdown) {
	const section = findUnreleasedSection(markdown);
	if (!section) return { state: "missing", count: 0 };
	if (section.notes.length === 0) return { state: "empty", count: 0 };
	return { state: "ready", count: section.notes.length };
}

/**
 * Rename the Unreleased heading to `version` and open a fresh Unreleased
 * section above it. Throws with an actionable message when there is nothing
 * to promote.
 *
 * @param {string} markdown
 * @param {string} version
 * @param {string} date `YYYY-MM-DD`
 * @returns {{ markdown: string, notes: string[] }}
 */
export function promoteUnreleased(markdown, version, date) {
	const section = findUnreleasedSection(markdown);
	if (!section) {
		throw new Error(
			"CHANGELOG.md has no `## Unreleased` section — add one and put this release's notes there.",
		);
	}
	if (section.notes.length === 0) {
		throw new Error(
			"`## Unreleased` in CHANGELOG.md has no top-level `- ` bullets — add at least one note " +
				"(or pass --skip-changelog to release without notes).",
		);
	}

	const lines = markdown.split(/\r?\n/);
	const before = lines
		.slice(0, section.start)
		.join("\n")
		.replace(/\s+$/, "");
	const body = section.body
		.filter((line) => line.trim() !== UNRELEASED_PLACEHOLDER)
		.join("\n")
		.replace(/^\s*\n/, "")
		.replace(/\s+$/, "");
	const after = lines
		.slice(section.end)
		.join("\n")
		.replace(/^\s*\n/, "");

	const parts = [
		"## Unreleased",
		"",
		UNRELEASED_PLACEHOLDER,
		"",
		`## ${version} — ${date}`,
		"",
		body,
	];
	if (before !== "") parts.unshift(before);
	if (after !== "") parts.push("", after);

	return { markdown: `${parts.join("\n")}\n`, notes: section.notes };
}
