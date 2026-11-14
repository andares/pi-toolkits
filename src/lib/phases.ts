/**
 * Phase helpers shared by the ask-family commands.
 *
 * `ask` is a mode; `ask-plan` and `ask-uat` are phases whose owning feature
 * publishes a marker tool for the duration. The markers are deliberately the
 * tool names the host already tracks (`plan_submit`, `uat_item`) so this helper
 * does not need a second global control registry.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAskControl } from "./ask-control.js";

/** Tool the plan feature activates for the whole planning phase. */
export const PLAN_PHASE_TOOL = "plan_submit";
/** Tool the UAT feature activates while its page/phase is open. */
export const UAT_PHASE_TOOL = "uat_item";

export type Phase = "ask" | "plan" | "uat";

const PHASE_COMMAND: Record<Phase, string> = {
	ask: "/ask",
	plan: "/ask-plan",
	uat: "/ask-uat",
};

export function activePhases(pi: ExtensionAPI): Phase[] {
	const tools = new Set(pi.getActiveTools());
	const phases: Phase[] = [];
	if (getAskControl()?.isActive()) phases.push("ask");
	if (tools.has(PLAN_PHASE_TOOL)) phases.push("plan");
	if (tools.has(UAT_PHASE_TOOL)) phases.push("uat");
	return phases;
}

/** Human-readable command names for a refusal message. */
export function describePhases(phases: readonly Phase[]): string {
	return phases.map((phase) => PHASE_COMMAND[phase]).join(" + ");
}
