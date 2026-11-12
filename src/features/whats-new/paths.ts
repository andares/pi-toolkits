/**
 * whats-new feature — locates files shipped next to this module.
 *
 * The published package contains `src/` plus `CHANGELOG.md` (package.json
 * `files`), so both are reachable by URL relative to this module. The host
 * loads extensions through jiti, which preserves `import.meta.url` (verified:
 * a probed extension reports `file:///…/src/…`), so the resolution works in a
 * checkout and in an installed package alike.
 *
 * Everything here is best-effort: callers treat a missing file as "no notes"
 * rather than failing the feature.
 */
import { fileURLToPath } from "node:url";
import { CHANGELOG_FILENAME } from "./constants.js";

/** Absolute path of a file at the package root. */
export function packageAsset(name: string): string {
	return fileURLToPath(new URL(`../../../${name}`, import.meta.url));
}

/** `package.json` — the runtime source of the version being run. */
export function defaultPackageFile(): string {
	return packageAsset("package.json");
}

/** `CHANGELOG.md` — the bundled release notes. */
export function defaultChangelogFile(): string {
	return packageAsset(CHANGELOG_FILENAME);
}
