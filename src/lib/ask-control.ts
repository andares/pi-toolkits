/**
 * ask control — lets `/ask-plan` leave consult mode before opening its broader
 * planning phase.
 *
 * `/ask` owns its state and its tool-set snapshot, so another feature must not
 * imitate the exit by manipulating tools itself. This small handle is the same
 * registry pattern as `permission-control.ts`: the owner publishes enter/exit
 * semantics, the caller only asks for a transition.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AskControl {
	isActive(): boolean;
	exit(ctx: ExtensionContext): void;
}

let current: AskControl | undefined;

export function setAskControl(control: AskControl | undefined): void {
	current = control;
}

export function getAskControl(): AskControl | undefined {
	return current;
}
