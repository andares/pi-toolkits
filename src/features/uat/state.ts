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
import { resolve } from "node:path";
import { frameworkReadiness } from "../init/parity.js";
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

/**
 * The ask loop needs a usable framework, not byte-identical files: state,
 * AGENTS.md, the memory contract and the evidence directory. Small edits to any
 * of them are the operator's business and do not block acceptance.
 */
export function frameworkInstalled(root: string): boolean {
	return frameworkReadiness(root).ready;
}

/** Missing pieces, for a refusal message that tells the operator what to fix. */
export function frameworkMissing(root: string): string[] {
	return frameworkReadiness(root).missing;
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
