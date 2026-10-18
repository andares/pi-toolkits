/**
 * permission feature — argument parsing and display formatting.
 *
 * `/ask-perm` with no argument toggles: on → off, off → panel. With arguments
 * it configures and enables in one step (this is the autostart path, and it
 * never opens a dialog):
 *
 *   /ask-perm [in-read] [in-write] [out-read] [out-write]
 *
 * Missing arguments take their default value — not the current one — so
 * `/ask-perm allow` always means "defaults, which also happens to be all
 * allow on the inside".
 */
import {
	DEFAULT_MODES,
	IN_VALUES,
	OUT_VALUES,
	type PermissionModes,
	type TriMode,
} from "./constants.js";

export type ParsedArgs =
	| { readonly modes: PermissionModes }
	| { readonly error: string };

function isPair(value: string): boolean {
	return (IN_VALUES as readonly string[]).includes(value);
}

function isTri(value: string): boolean {
	return (OUT_VALUES as readonly string[]).includes(value);
}

/**
 * Parse the command arguments. An empty string yields an error — callers must
 * check for "no arguments" before calling this.
 */
export function parsePermissionArgs(raw: string): ParsedArgs {
	const words = raw.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return { error: "expected at least one mode" };
	if (words.length > 4) {
		return { error: "expected at most 4 modes (in-read in-write out-read out-write)" };
	}
	const [inRead, inWrite, outRead, outWrite] = words;
	if (inRead !== undefined && !isPair(inRead)) {
		return { error: `in-read must be one of ${IN_VALUES.join("|")} (got "${inRead}")` };
	}
	if (inWrite !== undefined && !isPair(inWrite)) {
		return { error: `in-write must be one of ${IN_VALUES.join("|")} (got "${inWrite}")` };
	}
	if (outRead !== undefined && !isTri(outRead)) {
		return { error: `out-read must be one of ${OUT_VALUES.join("|")} (got "${outRead}")` };
	}
	if (outWrite !== undefined && !isTri(outWrite)) {
		return { error: `out-write must be one of ${OUT_VALUES.join("|")} (got "${outWrite}")` };
	}
	return {
		modes: {
			inRead: (inRead ?? DEFAULT_MODES.inRead) as PermissionModes["inRead"],
			inWrite: (inWrite ?? DEFAULT_MODES.inWrite) as PermissionModes["inWrite"],
			outRead: (outRead ?? DEFAULT_MODES.outRead) as TriMode,
			outWrite: (outWrite ?? DEFAULT_MODES.outWrite) as TriMode,
		},
	};
}

/** `allow/allow · allow/ask`, the human-readable summary used in notices. */
export function formatModes(modes: PermissionModes): string {
	return `in ${modes.inRead}/${modes.inWrite}, out ${modes.outRead}/${modes.outWrite}`;
}

/** Single-letter form for the footer status (`A` allow, `a` ask, `D` deny). */
export function shortMode(mode: TriMode | "allow"): string {
	switch (mode) {
		case "allow":
			return "A";
		case "ask":
			return "a";
		case "deny":
			return "D";
	}
}
