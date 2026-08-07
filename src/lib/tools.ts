/**
 * Shared tool-set management helpers (feature-agnostic).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Snapshot the currently active tool names (for later restore). */
export function snapshotActiveTools(pi: ExtensionAPI): string[] {
  return [...pi.getActiveTools()];
}

/** Restore a previously snapshotted tool set. No-op when the snapshot is empty. */
export function restoreActiveTools(pi: ExtensionAPI, snapshot: string[]): void {
  if (snapshot.length === 0) return;
  pi.setActiveTools([...snapshot]);
}

/** Return `active` minus the tools in `removed` (order preserved). */
export function withoutTools(
  active: readonly string[],
  removed: ReadonlySet<string>,
): string[] {
  return active.filter((name) => !removed.has(name));
}
