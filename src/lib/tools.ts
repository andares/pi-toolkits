/**
 * Shared tool-set management helpers (feature-agnostic).
 *
 * Two concerns live here because both are about tool identity rather than any
 * one feature: snapshotting/restoring the active set, and the registry of
 * self-jailed tools that the boundary gate consults.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Snapshot the currently active tool names (for later restore). */
export function snapshotActiveTools(pi: ExtensionAPI): string[] {
	return [...pi.getActiveTools()];
}

/** Restore a previously snapshotted tool set (an empty snapshot = no tools). */
export function restoreActiveTools(
	pi: ExtensionAPI,
	snapshot: readonly string[],
): void {
	pi.setActiveTools([...snapshot]);
}

/** Return `active` minus the tools in `removed` (order preserved). */
export function withoutTools(
	active: readonly string[],
	removed: ReadonlySet<string>,
): string[] {
	return active.filter((name) => !removed.has(name));
}

/**
 * Self-jailed tools — a registry the boundary gate consults.
 *
 * A tool can be *jailed*: its own implementation only reaches a place it
 * created and owns, so there is no boundary for `permission` to judge and no
 * dialog to raise. Example: ask mode's `scratchpad` writes into the session's
 * temp directory through a relative, validated name; running it through the
 * boundary analysis would ask "outside the project, write?" on every note even
 * though the operator already sanctioned that space by entering ask mode.
 *
 * This is intentionally a registry rather than a bypass baked into
 * `permission`: the owning feature marks the tool only while it is active, and
 * `permission` does not need to know which feature that is. A tool that is not
 * marked is judged normally, so forgetting to clear the mark would widen the
 * boundary — hence the owning feature clears it on exit.
 *
 * Narrow on purpose: the registry covers tool *names*, not paths. A tool only
 * belongs here when its caller cannot point it at a path.
 */
const jailed = new Set<string>();

/** Mark a tool as self-jailed (call while it is active). */
export function markJailedTool(name: string): void {
	jailed.add(name);
}

/** Remove the mark (call when the tool is deactivated). */
export function clearJailedTool(name: string): void {
	jailed.delete(name);
}

/** Whether `name` is a self-jailed tool that is currently active. */
export function isJailedTool(name: string): boolean {
	return jailed.has(name);
}

/**
 * Drop every mark. Tests call this between cases; production code clears one
 * tool at a time when the owning feature exits.
 */
export function resetJailedTools(): void {
	jailed.clear();
}
