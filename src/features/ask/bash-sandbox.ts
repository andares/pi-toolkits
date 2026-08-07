/**
 * ask feature — read-only bash sandbox.
 *
 * Delegates to @dreki-gg/pi-command-sandbox: proper shell-quote tokenization,
 * per-segment validation (&& | ; etc.), command-substitution rejection and
 * deny-by-default for unmodeled operators.
 *
 * On top of that, this wrapper adds write-intent detection for known blind
 * spots: allowlisted commands whose arguments can write files (curl -o/-O,
 * wget -O, dd of=, tee). Heuristic only — not a security boundary.
 */
import { isSafeCommand } from "@dreki-gg/pi-command-sandbox";

const WRITE_INTENT_PATTERNS: RegExp[] = [
	// curl --output FILE
	/\bcurl\b[^|;&]*\s--output\b/i,
	// curl -o FILE (curl -o - / -o- = stdout, allowed)
	/\bcurl\b[^|;&]*\s-o\s+(?!-)\S+/,
	// curl -O (uppercase: save to disk under remote name)
	/\bcurl\b[^|;&]*\s-O\b/,
	// wget --output-document FILE
	/\bwget\b[^|;&]*\s--output-document\b/i,
	// wget -O FILE (wget -O - / -qO- = stdout, allowed)
	/\bwget\b[^|;&]*\s-O\s+(?!-)\S+/,
	// dd of=FILE
	/\bdd\b[^|;&]*\sof=/i,
	// tee FILE (writes to stdout AND file)
	/\btee\b/i,
];

function hasWriteIntent(command: string): boolean {
	return WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(command));
}

/** True when `command` is considered read-only by the sandbox. */
export function isReadOnlyCommand(command: string): boolean {
	if (hasWriteIntent(command)) return false;
	return isSafeCommand(command);
}
