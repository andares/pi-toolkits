/**
 * permission feature — path resolution and containment.
 *
 * "Inside the project" means inside the session working directory or inside a
 * directory added to the session (pi-add-dir stores those in a session entry).
 * Containment is decided on canonical paths, so `../` and symlinks cannot walk
 * the check out of a root; a path that does not exist yet is resolved through
 * its nearest existing ancestor.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Expand a leading `~` (and only a leading `~/` or bare `~`). */
export function expandHome(pathValue: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith(`~${sep}`) || pathValue.startsWith("~/")) {
		return join(homedir(), pathValue.slice(2));
	}
	return pathValue;
}

/**
 * Absolute, symlink-resolved form of `pathValue`.
 *
 * The path itself may not exist (a write target, `mkdir` argument, …), so the
 * nearest existing ancestor is resolved and the missing suffix re-appended.
 */
export function canonicalize(pathValue: string): string {
	const absolute = resolve(pathValue);
	const suffix: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return suffix.length === 0
				? real
				: join(real, ...suffix.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return absolute;
			suffix.push(basename(current));
			current = parent;
		}
	}
}

function fold(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Whether `pathValue` is `root` or under it. Both must be canonical. */
export function isWithin(root: string, pathValue: string): boolean {
	const a = fold(root);
	const b = fold(pathValue);
	return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

/** The directory a session grant on `pathValue` should cover. */
export function grantRoot(pathValue: string): string {
	try {
		return statSync(pathValue).isDirectory() ? pathValue : dirname(pathValue);
	} catch {
		// A path that does not exist (a write target, a `mkdir` argument) is
		// granted at its enclosing directory: the operator is approving an area,
		// and a per-file grant would ask again for the next sibling.
		return dirname(pathValue);
	}
}

/** Structural shape of a session entry, so no host type is imported here. */
interface SessionEntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

interface AddDirState {
	readonly dirs?: ReadonlyArray<{ readonly absolutePath?: unknown }>;
}

/**
 * Directories added to the session by pi-add-dir.
 *
 * pi exposes no directory-list API; pi-add-dir records its state as a session
 * custom entry (`add-dir:state`, appended on every change). The last such
 * entry on the branch wins. Absence of pi-add-dir is a normal, silent miss —
 * only the working directory is then in scope.
 */
export function readAddedDirectories(
	entries: readonly SessionEntryLike[],
): string[] {
	let dirs: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "add-dir:state") {
			continue;
		}
		const state = entry.data as AddDirState | undefined;
		if (!Array.isArray(state?.dirs)) continue;
		dirs = state.dirs
			.map((dir) =>
				typeof dir?.absolutePath === "string" ? dir.absolutePath : "",
			)
			.filter((dir) => dir !== "");
	}
	return dirs;
}

/** Canonical root list for one session: working directory plus added dirs. */
export function sessionRoots(cwd: string, added: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const value of [cwd, ...added]) {
		if (!value) continue;
		roots.add(canonicalize(expandHome(value)));
	}
	return [...roots];
}

/** `true` when `pathValue` is inside at least one root. */
export function insideAnyRoot(
	roots: readonly string[],
	pathValue: string,
): boolean {
	return roots.some((root) => isWithin(root, pathValue));
}

