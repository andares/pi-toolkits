/**
 * ask feature — read-only bash sandbox.
 *
 * Delegates to @dreki-gg/pi-command-sandbox: proper shell-quote tokenization,
 * per-segment validation (&& | ; etc.), command-substitution rejection and
 * deny-by-default for unmodeled operators.
 *
 * This wrapper adds four things on top:
 *  1. write-intent detection for known blind spots — allowlisted commands
 *     whose arguments can still write files (curl/wget output targets, dd of=,
 *     tee, sed -i, sort -o, tree -o, find -delete, the git diff family's
 *     --output).
 *  2. exec-intent detection — read-by-name commands whose options run another
 *     program (git grep -O, git --ext-diff, find -exec/-ok, fd -x, rg --pre).
 *  3. `extraSafe` patterns for read-only commands the upstream allowlist does
 *     not model: git archaeology verbs, package metadata queries,
 *     `python -m json.tool`, wget's stdout form.
 *  4. a per-segment read-only bypass for DESTRUCTIVE_PATTERNS that match only
 *     a command's *arguments* (`git log --grep=rm`, `git blame src/rm-utils.ts`)
 *     — see READ_ONLY_COMMAND_PATTERNS.
 *
 * Heuristic only — not a security boundary.
 */
import {
	hasCommandSubstitution,
	isSafeCommand,
	parseCommandSegments,
} from "@dreki-gg/pi-command-sandbox";

/* -------------------------------------------------------------------------- */
/* Write intent                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Commands that are safe by name but whose arguments can write files.
 * Patterns are anchored at the command position and checked per shell segment,
 * so grep/rg *search arguments* mentioning a flag (`grep -rn "curl -so"`) are
 * data, not intent. Stdout forms stay explicitly allowed: `-o -` / `-O -` /
 * `-qO-` / `--output -` / `--output=-` / `--output-document=-`.
 */
const WRITE_INTENT_PATTERNS: RegExp[] = [
	// curl --output FILE (curl --output - / --output=- = stdout, allowed)
	/^\s*curl\b[^|;&]*\s--output(?:=|\s+)(?!-)\S+/i,
	// curl -o FILE / -oFILE / -so FILE: short form, attached or clustered
	// (`-o -` / `-o-` / `-so-` are stdout and stay allowed)
	/^\s*curl\b[^|;&]*\s-[a-zA-Z]*o(?:\s+(?!-)\S+|(?!-)\S+)/,
	// curl -O / -sO / --remote-name: always saves to disk
	/^\s*curl\b[^|;&]*\s-[a-zA-Z]*O\b/,
	/^\s*curl\b[^|;&]*\s--remote-name\b/i,
	// wget --output-document FILE (--output-document - = stdout, allowed)
	/^\s*wget\b[^|;&]*\s--output-document(?:=|\s+)(?!-)\S+/i,
	// wget -O FILE (wget -O - / -qO- = stdout, allowed)
	/^\s*wget\b[^|;&]*\s-O\s+(?!-)\S+/,
	// dd of=FILE
	/^\s*dd\b[^|;&]*\sof=/i,
	// tee FILE (writes to stdout AND file)
	/^\s*tee\b/i,
	// sed -i / -ni: in-place edits; only `sed -n` is otherwise allowlisted
	/^\s*sed\b[^|;&]*\s-[a-zA-Z]*i(?:\s|$)/i,
	/^\s*sed\b[^|;&]*\s--in-place\b/i,
	// sort -o FILE / --output FILE
	/^\s*sort\b[^|;&]*\s(?:-o\s|--output(?:=|\s+))/i,
	// tree -o FILE / --output FILE (short form may be clustered: -ao FILE)
	/^\s*tree\b[^|;&]*\s(?:-[a-zA-Z]*o(?:\s|$)|--output(?:=|\s+))/i,
	// file -C / --compile writes the compiled magic database
	/^\s*file\b[^|;&]*\s(?:-[a-zA-Z]*C(?:\s|$)|--compile\b)/i,
	// find -delete (its -exec/-ok forms are exec intent below)
	/^\s*find\b[^|;&]*\s-delete\b/i,
	// git diff family --output FILE: a real write path on commands that are
	// otherwise read-only (`git diff --output=out.txt` creates the file).
	// `-o` is not a valid short option for these verbs; guarding it is free.
	/^\s*git\s+(?:log|diff|show|diff-tree|whatchanged)\b[^|;&]*(?:\s--output(?:=|\s+)|\s-o\s)\S+/i,
];

/** True when a segment is a write-intent invocation. */
function hasWriteIntent(command: string): boolean {
	return parseCommandSegments(command).some((segment) =>
		WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(segment.command)),
	);
}

/* -------------------------------------------------------------------------- */
/* Exec intent                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read-by-name commands whose options start another program. Same per-segment,
 * command-position anchoring as the write intent above, so an allowed verb
 * cannot smuggle execution in and search arguments stay data.
 */
const EXEC_INTENT_PATTERNS: RegExp[] = [
	// git grep -O[pager] / --open-files-in-pager: runs a pager on matched files
	/^\s*git\s+grep\b[^|;&]*\s(?:-O|--open-files-in-pager\b)/i,
	// external diff drivers (from config/gitattributes)
	/^\s*git\s+\S+\b[^|;&]*\s--ext-diff\b/i,
	// env forwards to another command (`env [-i] [-u NAME] [NAME=VALUE] CMD …`);
	// bare env, flag-only and assignment-only forms print the environment and
	// stay allowed (the lookahead keeps NAME=VALUE from posing as CMD)
	/^\s*env\b(?:\s+(?:-\S+|[A-Za-z_][A-Za-z0-9_]*=\S+))*\s+(?![A-Za-z_][A-Za-z0-9_]*=)[^-\s]\S*/,
	// find/fd command runners
	/^\s*find\b[^|;&]*\s-(?:exec|execdir|ok|okdir)\b/i,
	/^\s*fd\b[^|;&]*\s(?:-x|--exec(?:-batch)?)\b/i,
	// ripgrep preprocessor
	/^\s*rg\b[^|;&]*\s--pre(?:=|\s)/i,
];

/** True when a segment is an exec-intent invocation. */
function hasExecIntent(command: string): boolean {
	return parseCommandSegments(command).some((segment) =>
		EXEC_INTENT_PATTERNS.some((pattern) => pattern.test(segment.command)),
	);
}

/* -------------------------------------------------------------------------- */
/* Read-only allowlist extensions                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read-only commands the upstream allowlist lacks, plus the read-only forms of
 * git verbs that also have mutating siblings.
 *
 * Every pattern is anchored and pinned to stdout-only shapes:
 *  - no `find -exec`/`-delete`, no `fd -x`, no `sort -o`, no `sed -i`;
 *  - `git stash` is pinned to list/show (`drop`/`pop`/`apply` stay blocked);
 *  - `git tag` is pinned to -l/--list (create/delete stay blocked);
 *  - `git reflog` is pinned to bare/`show` (delete/expire stay blocked);
 *  - `git config` is pinned to get/list forms (set/unset stay blocked).
 */
const READ_ONLY_COMMAND_PATTERNS: RegExp[] = [
	// git: read-only archaeology verbs upstream never modeled
	/^\s*git\s+(?:blame|grep|rev-parse|rev-list|describe|shortlog|cat-file|show-ref|for-each-ref|name-rev|diff-tree|whatchanged|merge-base|cherry|check-ignore|check-attr|count-objects)\b/i,
	// git: upstream read verbs whose arguments may hold destructive words
	/^\s*git\s+(?:log|diff|show|status|ls-files|ls-tree)\b/i,
	// git: read-only forms of verbs that also mutate
	/^\s*git\s+reflog(?:\s+show\b[^|;&]*)?\s*$/i,
	/^\s*git\s+stash\s+(?:list|show)\b/i,
	/^\s*git\s+worktree\s+list\b/i,
	/^\s*git\s+tag\s+(?:-l|--list)\b/i,
	/^\s*git\s+config\s+(?:--get\b|--get-all\b|--get-regexp\b|-l\b|--list\b)/i,
	// harmless navigation/readers commonly chained before a search
	/^\s*cd\b/i,
	/^\s*(?:head|tail|cat|tac|wc|uniq|jq|column)\b/i,
	/^\s*(?:ls|file|stat|tree|du|df|bat|eza)\b/i,
	/^\s*(?:grep|rg)\b/i,
	/^\s*sed\s+-n\b/i,
	// package metadata (network/library reads, never installs)
	/^\s*pnpm\s+(?:view|info|search|licenses)\b/i,
	/^\s*pip3?\s+(?:show|list|freeze)\b/i,
	/^\s*uv\s+(?:pip\s+(?:list|show|freeze)|tree)\b/i,
	/^\s*python3?\s+-m\s+json\.tool\b/i,
	// network reads: wget to stdout only (file targets stay blocked)
	/^\s*wget\b[^|;&]*\s(?:-O\s*-|-O-|-qO-|--output-document(?:=|\s+)-)/i,
];

/**
 * Gaps in the upstream DESTRUCTIVE_PATTERNS closed here: git commands that can
 * write but are not modeled as destructive — `git branch <name>` creates a ref,
 * `git branch -m/-M/-c/-C` moves/copies, `git remote add/remove/set-url/...`
 * edits .git/config. File-write and command-runner options are handled by the
 * write/exec intent checks above (which run on the raw command, so pipelines
 * are covered too).
 */
const EXTRA_DESTRUCTIVE_PATTERNS: RegExp[] = [
	// positional argument after `branch` = create branch (flags stay read-only)
	/^\s*git\s+branch\s+(?=[^-\s])/i,
	/^\s*git\s+branch\s+-(?:[mMcC]\b|move\b|copy\b|edit-description\b)/i,
	// remote subcommands other than the read-only ones
	/^\s*git\s+remote\s+(?!-)(?!(?:show|get-url)(?=\s|$))/i,
];

/**
 * True when every parsed segment is a curated read-only shape: no redirect, no
 * unmodeled operator, each segment matching one of the patterns above.
 *
 * Used as `allowCommand`, which runs *before* the package's destructive check —
 * that is what lets `git log --grep=rm` through while `git log && rm -rf x`
 * still fails (the second segment matches nothing here).
 */
function allSegmentsReadOnly(command: string): boolean {
	const segments = parseCommandSegments(command);
	if (segments.length === 0) return false;
	return segments.every(
		(segment) =>
			!segment.hasRedirect &&
			segment.unsafeOperator === undefined &&
			READ_ONLY_COMMAND_PATTERNS.some((pattern) =>
				pattern.test(segment.command),
			),
	);
}

/** True when `command` is considered read-only by the sandbox. */
export function isReadOnlyCommand(command: string): boolean {
	if (hasWriteIntent(command)) return false;
	if (hasExecIntent(command)) return false;
	// The read-only-segment bypass below runs before the package's own
	// substitution check, so reject command substitution here first.
	if (hasCommandSubstitution(command)) return false;
	return isSafeCommand(command, {
		extraSafe: READ_ONLY_COMMAND_PATTERNS,
		extraDestructive: EXTRA_DESTRUCTIVE_PATTERNS,
		allowCommand: allSegmentsReadOnly,
	});
}

/* -------------------------------------------------------------------------- */
/* Block classification (for actionable rejection messages)                   */
/* -------------------------------------------------------------------------- */

/** Why a bash command was rejected; drives the message shown to the model. */
export type BashBlockKind =
	| "substitution"
	| "redirect"
	| "exec"
	| "write"
	| "download"
	| "git"
	| "install"
	| "unlisted";

const INSTALL_INTENT: RegExp[] = [
	/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|rm|update|up|ci|link|publish|dlx|exec|create)\b/i,
	/\bpip3?\s+(?:install|uninstall)\b/i,
	/\b(?:apt|apt-get|brew|cargo|go)\s+(?:install|add|get)\b/i,
];

/** Classic file writers, for classifying a rejection as a write attempt. */
const WRITER_INTENT =
	/\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|truncate|shred|dd|sed\s+-i|sort\s+-o|yq\s+-i)\b/i;

/** Classify a rejected command so the block reason can point at alternatives. */
export function classifyBlockedCommand(command: string): BashBlockKind {
	if (hasCommandSubstitution(command)) return "substitution";
	if (parseCommandSegments(command).some((segment) => segment.hasRedirect)) {
		return "redirect";
	}
	if (hasExecIntent(command)) return "exec";
	if (hasWriteIntent(command) || WRITER_INTENT.test(command)) return "write";
	if (/\b(?:wget|curl)\b/i.test(command)) return "download";
	if (/^\s*git\b/i.test(command)) return "git";
	if (INSTALL_INTENT.some((pattern) => pattern.test(command))) return "install";
	return "unlisted";
}
