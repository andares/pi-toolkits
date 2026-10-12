/**
 * Shared tool-set management helpers (feature-agnostic).
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
