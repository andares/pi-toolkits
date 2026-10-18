/**
 * Startup handoff for commands dispatched by autostart.
 *
 * Why the distinction: the host renders an info notice (`ctx.ui.notify`) as a
 * `ThemedText` whose builder reads one shared `lastStatusMessage` field, and a
 * UI invalidation (theme switch, theme-file edit, syntax-grammar load at
 * startup) rebuilds *every* status line from that field. At startup several
 * commands emit status lines (/add-dir, …), so our notice makes the earlier
 * lines display our text too — one command looks like it ran twice.
 *
 * Interactive toggles have the opposite preference: consecutive info notices
 * update the previous line in place, so ON/OFF/ON does not scroll the screen.
 *
 * Autostart therefore marks the commands it starts, and our command answers
 * differently: a startup notice is a custom session entry (own text, immune to
 * invalidation), while an interactive one stays a transient status line.
 *
 * The mark is keyed by command name and is always cleared by the dispatcher
 * (`finally`), so it cannot leak into a later manual invocation.
 */
const startupCommands = new Set<string>();

/** Mark `commandName` as dispatched by autostart. */
export function markStartupCommand(commandName: string): void {
	startupCommands.add(commandName);
}

/** Drop a mark whether or not the command consumed it. */
export function clearStartupCommand(commandName: string): void {
	startupCommands.delete(commandName);
}

/** `true` once, when the command was started by autostart; consumes the mark. */
export function consumeStartupCommand(commandName: string): boolean {
	return startupCommands.delete(commandName);
}
