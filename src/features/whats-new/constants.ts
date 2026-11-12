/**
 * whats-new feature — constants and the reasoning behind the notice shape.
 *
 * The feature answers one question — "what changed in the version I just
 * installed?" — and answers it exactly once per upgrade. Release notes live in
 * the repository's `CHANGELOG.md`, which ships inside the npm package and is
 * promoted from `## Unreleased` by `pnpm release` (see scripts/publish.mjs), so
 * the text is written at release time instead of being reconstructed from
 * commit subjects at runtime.
 *
 * Why a custom session entry instead of `ctx.ui.notify`: a startup notice needs
 * its own text and must survive `ui.invalidate()` — the same reason the
 * permission feature renders its autostart notice as an entry (see
 * src/features/permission/index.ts). An entry also stays out of the model
 * context, so release notes never cost a token.
 */

/** State file in pi's agent dir (same convention as the other feature stores). */
export const WHATS_NEW_FILE = "pi-toolkits-whats-new.json";

/** Custom entry type; also the renderer key. */
export const NOTICE_ENTRY = "whats-new:notice";

/** Release notes file shipped at the package root. */
export const CHANGELOG_FILENAME = "CHANGELOG.md";

/**
 * Newest N versions shown in the startup notice. An operator upgrading from a
 * much older release gets the versions that actually matter, not a wall of
 * text; the complete notes stay in `CHANGELOG.md`.
 */
export const MAX_VERSIONS_IN_NOTICE = 4;

/** Notes per version in the startup notice; the rest stay in `CHANGELOG.md`. */
export const MAX_NOTES_PER_VERSION = 6;
