/**
 * UAT feature — where the project lives and what the ledger currently says.
 *
 * **The ledger belongs to the main checkout.** A linked git worktree has its
 * own working tree, and writing acceptance history into it would split the
 * record the moment a second agent session uses `git worktree add`. So the root
 * is resolved through `git worktree list` (first entry = the main worktree) and
 * every read/write of `.agents/uat/` and `.agents/implementations/` uses it.
 *
 * Resolution is cached per cwd: the page polls, `/ask-uat` reads, and nothing
 * changed in between. The cache is the reason a UI refresh does not spawn git.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { STATE_FILE } from "../init/spec.js";
import { deriveState, ledgerPath, readEvents, type UatState } from "./ledger.js";
import { listRecords, type RecordEntry } from "./records.js";

const rootCache = new Map<string, string>();

/** The main worktree of the repository containing `cwd` (or `cwd` itself). */
export function resolveProjectRoot(cwd: string): string {
	const start = resolve(cwd);
	const cached = rootCache.get(start);
	if (cached) return cached;

	let root = start;
	try {
		const output = execFileSync("git", ["-C", start, "worktree", "list", "--porcelain"], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const line = output.split("\n").find((entry) => entry.startsWith("worktree "));
		const first = line?.slice("worktree ".length).trim();
		if (first) root = resolve(first);
	} catch {
		// Not a git checkout (or git is missing): the cwd is the project.
	}
	rootCache.set(start, root);
	return root;
}

/** Test seam: forget the memoized roots. */
export function resetProjectRootCache(): void {
	rootCache.clear();
}

/** The UAT flow only exists in a project that installed the framework. */
export function frameworkInstalled(root: string): boolean {
	return existsSync(join(root, STATE_FILE));
}

export interface UatSnapshot {
	root: string;
	records: RecordEntry[];
	state: UatState;
	/** Malformed ledger lines; surfaced so a corrupt file is not silently "empty". */
	skipped: number;
}

export function loadSnapshot(root: string): UatSnapshot {
	const records = listRecords(root);
	const { events, skipped } = readEvents(ledgerPath(root));
	return { root, records, state: deriveState(records, events), skipped };
}
