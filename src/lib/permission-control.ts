/**
 * permission control — the handle `/ask-plan` uses to turn the boundary checks
 * on for the planning phase and put them back afterwards.
 *
 * Why a registry instead of an import: `/ask-perm` keeps its state in a closure
 * inside `registerPermission()`, so there is no module-level setter to call.
 * A tiny registry (same pattern as `src/lib/startup.ts` for the autostart
 * handoff) lets the permission feature publish a control handle at registration
 * time and the plan feature look it up — without either feature importing the
 * other's internals, and without the plan feature knowing anything about modes.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionModes } from "../features/permission/constants.js";

export interface PermissionSnapshot {
	enabled: boolean;
	modes: PermissionModes;
}

export interface PermissionControl {
	/** Current state, for `restore` later. */
	snapshot(): PermissionSnapshot;
	/** Turn checks on with the default modes — a no-op when already enabled. */
	enableDefaults(ctx: ExtensionContext): void;
	/** Put back exactly what `snapshot()` returned. */
	restore(ctx: ExtensionContext, snapshot: PermissionSnapshot): void;
	/** Turn checks off (used when there was nothing to restore). */
	disable(ctx: ExtensionContext): void;
}

let current: PermissionControl | undefined;

export function setPermissionControl(control: PermissionControl | undefined): void {
	current = control;
}

export function getPermissionControl(): PermissionControl | undefined {
	return current;
}
