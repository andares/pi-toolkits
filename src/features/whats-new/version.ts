/**
 * whats-new feature — strict `X.Y.Z` versions.
 *
 * Package versions in this repo are always plain `X.Y.Z` (the release script
 * rejects anything else), so prerelease/build metadata is deliberately not
 * parsed. An unparseable version yields `undefined`, and callers treat that as
 * "do not announce" instead of guessing an ordering — a wrong comparison would
 * replay notes the operator already saw.
 */

export interface VersionParts {
	major: number;
	minor: number;
	patch: number;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Parse `X.Y.Z` (an optional leading `v` is tolerated). */
export function parseVersion(value: string): VersionParts | undefined {
	const match = VERSION_RE.exec(value.trim());
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

/**
 * Numeric ordering: negative when `a < b`, positive when `a > b`, 0 when equal
 * or when either side is unparseable (never announce on an unknown ordering).
 */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return 0;
	return (
		left.major - right.major ||
		left.minor - right.minor ||
		left.patch - right.patch
	);
}
