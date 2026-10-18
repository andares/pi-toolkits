/**
 * permission feature — session-scoped grants.
 *
 * Ephemeral by design: an allow/deny recorded here lives only in this process
 * and is cleared when the mode is switched off or the session ends. Nothing is
 * written to disk, so a forgotten toggle cannot outlive the session it was
 * meant for.
 *
 * A grant is `(effect, directory root)`. Read grants do not imply write grants.
 * Matching is containment — no globs — because the operator grants "this
 * directory", not "this pattern".
 */
import type { Effect } from "./constants.js";
import { insideAnyRoot } from "./paths.js";

/** One session-scoped allow or deny. */
export interface Grant {
	readonly effect: Effect;
	/** Canonical directory root; the file that triggered it was folded in. */
	readonly root: string;
}

export class SessionRules {
	private readonly allowList: Grant[] = [];
	private readonly denyList: Grant[] = [];
	/**
	 * Grants for commands that cannot be resolved to a path (an opaque unit).
	 * Keyed on the command text, so only the exact command is covered.
	 */
	private readonly allowedCommands = new Set<string>();
	private readonly deniedCommands = new Set<string>();

	/** Record an allow for `(effect, root)`; replaces an identical grant. */
	allow(grant: Grant): void {
		this.add(this.allowList, grant);
	}

	/** Record a deny for `(effect, root)`; replaces an identical grant. */
	deny(grant: Grant): void {
		this.add(this.denyList, grant);
	}

	private add(list: Grant[], grant: Grant): void {
		const index = list.findIndex(
			(entry) => entry.effect === grant.effect && entry.root === grant.root,
		);
		if (index >= 0) list[index] = grant;
		else list.push(grant);
	}

	/** `true` when an allow covers this access. */
	allows(effect: Effect, pathValue: string): boolean {
		return this.allowList.some(
			(grant) =>
				grant.effect === effect && insideAnyRoot([grant.root], pathValue),
		);
	}

	/** `true` when a deny covers this access. */
	denies(effect: Effect, pathValue: string): boolean {
		return this.denyList.some(
			(grant) =>
				grant.effect === effect && insideAnyRoot([grant.root], pathValue),
		);
	}

	/** Record an allow for an opaque command's exact text. */
	allowCommand(command: string): void {
		this.allowedCommands.add(command);
	}

	/** Record a deny for an opaque command's exact text. */
	denyCommand(command: string): void {
		this.deniedCommands.add(command);
	}

	/** `true` when this exact command was allowed for the session. */
	allowsCommand(command: string): boolean {
		return this.allowedCommands.has(command);
	}

	/** `true` when this exact command was denied for the session. */
	deniesCommand(command: string): boolean {
		return this.deniedCommands.has(command);
	}

	/** Drop every grant (mode off, session boundary). */
	clear(): void {
		this.allowList.length = 0;
		this.denyList.length = 0;
		this.allowedCommands.clear();
		this.deniedCommands.clear();
	}

	/** Counts for `/ask-perm status` and tests. */
	counts(): { allow: number; deny: number } {
		return { allow: this.allowList.length, deny: this.denyList.length };
	}
}
