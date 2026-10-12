/**
 * ask feature — constants (tool names, UI keys, labels).
 */

/**
 * Tools hard-removed from the active set while ask mode is on.
 *
 * `write`/`edit` are the obvious ones. `powershell` is a shell too: pi
 * registers it on every platform (inactive by default, enabled by settings),
 * and it would otherwise hand ask mode a full write channel.
 */
export const ASK_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"powershell",
]);

/**
 * Read-only helper tools activated for the duration of ask mode (when the host
 * has them registered). pi registers `grep`/`find`/`ls` but leaves them
 * inactive by default; ask mode is a reading mode, so the model gets proper
 * search tools instead of bash-only search. Restored exactly on exit.
 */
export const ASK_READ_ONLY_HELPERS: readonly string[] = ["grep", "find", "ls"];

/** Footer status key (extension-scoped) and label. */
export const ASK_STATUS_KEY = "ask-mode";
export const ASK_STATUS_LABEL = "ask";
