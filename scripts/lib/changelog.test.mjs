/**
 * Release-script changelog promotion tests.
 *
 * `pnpm release` rewrites the repository's CHANGELOG.md, so the transformation
 * is tested here rather than trusted by inspection: the promoted heading, the
 * kept body, the fresh Unreleased section above it, and the two abort cases
 * (missing section, no top-level notes).
 */
import { describe, expect, it } from "vitest";
import { findUnreleasedSection, promoteUnreleased } from "./changelog.mjs";

const HEADER = `# Changelog

Notable changes.

`;

describe("findUnreleasedSection", () => {
	it("finds the section and counts only top-level bullets", () => {
		const section = findUnreleasedSection(
			`${HEADER}## Unreleased\n\n- one\n  - nested\n* two\n\n## 0.1.0\n\n- old\n`,
		);
		expect(section?.notes).toEqual(["- one", "* two"]);
	});

	it("returns undefined without the section", () => {
		expect(findUnreleasedSection(`${HEADER}## 0.1.0\n\n- old\n`)).toBeUndefined();
	});
});

describe("promoteUnreleased", () => {
	it("renames the heading, keeps the notes, and opens a fresh Unreleased", () => {
		const result = promoteUnreleased(
			`${HEADER}## Unreleased\n\n- new thing\n- second note\n\n## 0.1.0 — 2026-01-01\n\n- old note\n`,
			"0.2.0",
			"2026-02-02",
		);

		expect(result.notes).toEqual(["- new thing", "- second note"]);
		expect(result.markdown).toContain("## 0.2.0 — 2026-02-02\n\n- new thing\n- second note");
		expect(result.markdown).toContain("## 0.1.0 — 2026-01-01\n\n- old note");
		expect(result.markdown.indexOf("## Unreleased")).toBeLessThan(
			result.markdown.indexOf("## 0.2.0"),
		);
		// The fresh Unreleased is empty, so the next release has to write notes.
		expect(findUnreleasedSection(result.markdown)?.notes).toEqual([]);
	});

	it("handles a changelog with no released sections yet", () => {
		const result = promoteUnreleased("## Unreleased\n\n- first release\n", "0.1.0", "2026-02-02");
		expect(result.markdown).toContain("## 0.1.0 — 2026-02-02\n\n- first release");
		expect(findUnreleasedSection(result.markdown)?.notes).toEqual([]);
	});

	it("refuses a missing Unreleased section", () => {
		expect(() => promoteUnreleased(`${HEADER}## 0.1.0\n\n- old\n`, "0.2.0", "2026-02-02"))
			.toThrow(/no `## Unreleased` section/);
	});

	it("refuses an Unreleased section with no top-level notes", () => {
		expect(() =>
			promoteUnreleased(
				`${HEADER}## Unreleased\n\n<!-- nothing yet -->\n  - nested only\n`,
				"0.2.0",
				"2026-02-02",
			),
		).toThrow(/no top-level `- ` bullets/);
	});

	it("is not what the runtime parser would mistake for a version", () => {
		const result = promoteUnreleased("## Unreleased\n\n- note\n", "0.2.0", "2026-02-02");
		// The comment inside the fresh Unreleased must not become a note.
		const section = findUnreleasedSection(result.markdown);
		expect(section?.body.join("\n")).not.toContain("- note");
	});
});
