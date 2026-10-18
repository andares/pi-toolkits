/**
 * Quiet handoff for commands dispatched by autostart.
 *
 * The host's interactive status line keeps every info notice in the chat, but
 * each line renders one shared "last status message" field
 * (`interactive-mode.js#showStatus`: `new ThemedText(() => ... this.lastStatusMessage)`).
 * A warning emitted between two info notices breaks the coalescing, so a second
 * info notice creates a new line — and *both* lines then render the newest
 * text. The visible result is the same message twice, separated by the warning.
 *
 * That is a host display quirk, not a second execution. Startup replay is the
 * worst case: `/add-dir` (info) → `/lens-toggle` (warning) → `/ask-perm` (info)
 * shows "Permission ON" twice. Autostart therefore marks the commands it
 * dispatches as quiet, and our own commands skip the chat notice when they were
 * started that way. The footer status still reflects the new state.
 *
 * The mark is keyed by command name and is always cleared by the dispatcher
 * (`finally`), so it cannot leak into a later manual invocation.
 */
const quietCommands = new Set<string>();

/** Mark `commandName` as dispatched by autostart (no chat notice). */
export function markQuiet(commandName: string): void {
	quietCommands.add(commandName);
}

/** Drop a mark whether or not the command consumed it. */
export function clearQuiet(commandName: string): void {
	quietCommands.delete(commandName);
}

/** `true` once, when the command was marked quiet; consumes the mark. */
export function consumeQuiet(commandName: string): boolean {
	return quietCommands.delete(commandName);
}
