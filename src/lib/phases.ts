/**
 * Phase helpers shared by the ask-family commands.
 *
 * `ask` is a mode; `ask-spec` and `ask-uat` are phases whose owning feature
 * publishes a marker tool for the duration. The markers are deliberately the
 * tool names the host already tracks (`spec_submit`, `uat_item`) so this helper
 * does not need a second global control registry.
 *
 * `plan_submit` is the pre-rename marker: an in-flight session that started
 * before the rename keeps the tool name in its snapshot, and refusing it would
 * make the two phases look disjoint. Detection accepts both; only `spec_submit`
 * is registered now.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAskControl } from "./ask-control.js";

/** Tool the spec feature activates for the whole spec-review phase. */
export const SPEC_PHASE_TOOL = "spec_submit";
/** The previous name of the same marker, kept for sessions that predate the rename. */
export const LEGACY_SPEC_PHASE_TOOL = "plan_submit";
/** Tool the UAT feature activates while its page/phase is open. */
export const UAT_PHASE_TOOL = "uat_item";

export type Phase = "ask" | "spec" | "uat";

const PHASE_COMMAND: Record<Phase, string> = {
	ask: "/ask",
	spec: "/ask-spec",
	uat: "/ask-uat",
};

export function activePhases(pi: ExtensionAPI): Phase[] {
	const tools = new Set(pi.getActiveTools());
	const phases: Phase[] = [];
	if (getAskControl()?.isActive()) phases.push("ask");
	if (tools.has(SPEC_PHASE_TOOL) || tools.has(LEGACY_SPEC_PHASE_TOOL)) phases.push("spec");
	if (tools.has(UAT_PHASE_TOOL)) phases.push("uat");
	return phases;
}

/** Human-readable command names for a refusal message. */
export function describePhases(phases: readonly Phase[]): string {
	return phases.map((phase) => PHASE_COMMAND[phase]).join(" + ");
}

/** True when either the current or the pre-rename submit marker is active. */
export function specPhaseActive(pi: ExtensionAPI): boolean {
	const tools = pi.getActiveTools?.() ?? [];
	return tools.includes(SPEC_PHASE_TOOL) || tools.includes(LEGACY_SPEC_PHASE_TOOL);
}
