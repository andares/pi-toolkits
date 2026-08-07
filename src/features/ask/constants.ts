/**
 * ask feature — constants (tool names, UI keys, labels).
 */

/** Tools hard-removed from the active set while ask mode is on. */
export const ASK_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
	"write",
	"edit",
]);

/** Footer status key (extension-scoped) and label. */
export const ASK_STATUS_KEY = "ask-mode";
export const ASK_STATUS_LABEL = "ask";
