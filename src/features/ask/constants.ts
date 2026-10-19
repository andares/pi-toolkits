/**
 * ask feature — constants (tool names, UI keys, labels).
 */

/**
 * Tools hard-removed from the active set while ask mode is on.
 *
 * `write`/`edit` are the obvious ones. `powershell` is a shell too: pi
 * registers it on every platform (inactive by default, enabled by settings),
 * and it would otherwise hand ask mode a full write channel.
 *
 * The one write channel ask mode keeps is its own tool, {@link ASK_SCRATCH_TOOL}:
 * it takes a relative note name and can only reach the session's scratch
 * directory (see scratch.ts), so it needs no path check from the model and no
 * write allowance in the bash sandbox.
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

/**
 * The scratch-note tool. Registered inactive (`defaultActive: false`) and
 * activated only while ask mode is on, so its declaration and
 * `promptGuidelines` are part of the request exactly when they apply.
 */
export const ASK_SCRATCH_TOOL = "scratchpad";

/** Footer status key (extension-scoped) and label. */
export const ASK_STATUS_KEY = "ask-mode";
export const ASK_STATUS_LABEL = "ask";
