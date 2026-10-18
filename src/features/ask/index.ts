/**
 * ask feature — read-only Q&A mode.
 *
 * Design notes (see PLAN.md):
 *  - Hard guarantee: write/edit/powershell are removed from the active tool set
 *    via pi.setActiveTools(); pi's runtime rejects calls to non-active tools
 *    ("Tool not found") so nothing executes.
 *  - Read-only helper tools (grep/find/ls) are activated for the duration so
 *    the model gets proper search tools; the entry snapshot restores exactly.
 *  - bash stays available but is gated by a read-only sandbox
 *    (see bash-sandbox.ts) through the shared gate bus (lib/gates.ts), so
 *    another feature's gate (`permission`) runs alongside it rather than
 *    replacing it: each feature owns its own concern and the call is blocked
 *    when either objects.
 *  - Mode banner appended to the system prompt via before_agent_start
 *    chained systemPrompt (see prompt.ts), listing blocked -> alternative.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { GateHub } from "../../lib/gates.js";
import {
	restoreActiveTools,
	snapshotActiveTools,
	withoutTools,
} from "../../lib/tools.js";
import {
	ASK_BLOCKED_TOOLS,
	ASK_READ_ONLY_HELPERS,
	ASK_STATUS_KEY,
	ASK_STATUS_LABEL,
} from "./constants.js";
import { isReadOnlyCommand } from "./bash-sandbox.js";
import { appendAskBanner } from "./prompt.js";
import { blockedBashReason, blockedToolReason } from "./reasons.js";

export function registerAsk(pi: ExtensionAPI, gates: GateHub): void {
	let enabled = false;
	/** Active tools before ask mode was entered (for exact restore on exit). */
	let snapshot: string[] = [];

	/** Gray footer status while ask mode is active; cleared on exit. */
	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			ASK_STATUS_KEY,
			enabled ? ctx.ui.theme.fg("muted", ASK_STATUS_LABEL) : undefined,
		);
	}

	/** Read-only helpers currently active (drives the banner's search hint). */
	function activeHelperTools(): string[] {
		const active = new Set(pi.getActiveTools());
		return ASK_READ_ONLY_HELPERS.filter((name) => active.has(name));
	}

	function enter(ctx: ExtensionContext): void {
		if (enabled) return;
		enabled = true;
		snapshot = snapshotActiveTools(pi);
		// Activate grep/find/ls when the host has them registered and they were
		// not already active. Names must be registered; unknown names are ignored
		// by setActiveTools, but filtering here keeps the intent explicit.
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const helpers = ASK_READ_ONLY_HELPERS.filter(
			(name) => registered.has(name) && !snapshot.includes(name),
		);
		pi.setActiveTools([
			...withoutTools(snapshot, ASK_BLOCKED_TOOLS),
			...helpers,
		]);
		updateStatus(ctx);
		ctx.ui.notify(
			"Ask mode ON — read-only (write/edit/powershell disabled, bash sandboxed). /ask to exit.",
			"info",
		);
	}

	function exit(ctx: ExtensionContext): void {
		if (!enabled) return;
		enabled = false;
		restoreActiveTools(pi, snapshot);
		snapshot = [];
		updateStatus(ctx);
		ctx.ui.notify("Ask mode OFF — full tool access restored.", "info");
	}

	function toggle(ctx: ExtensionContext): void {
		if (enabled) {
			exit(ctx);
		} else {
			enter(ctx);
		}
	}

	pi.registerCommand("ask", {
		description: "Toggle ask mode (read-only Q&A)",
		handler: async (_args, ctx) => {
			toggle(ctx);
		},
	});

	// Defense-in-depth gate while ask mode is active:
	//  - write/edit/powershell are already removed from the active set (runtime
	//    rejects them); this blocks them again in case anything re-enables them.
	//  - bash is kept available but only read-only commands pass the sandbox.
	// The rejection `reason` reaches the model as the tool result, so it names
	// the nearest allowed alternative (see reasons.ts).
	//
	// Registered through the gate bus so the permission gate composes with it:
	// ask answers "does this mutate?", permission answers "does this cross the
	// project boundary?". A denied outside read still applies in ask mode, and
	// a blocked write never reaches permission's dialog because a block
	// short-circuits the bus.
	gates.register({
		name: "ask",
		order: 10,
		evaluate(event) {
			if (!enabled) return undefined;

			if (ASK_BLOCKED_TOOLS.has(event.toolName)) {
				return {
					kind: "block",
					reason: blockedToolReason(event.toolName),
				};
			}

			if (event.toolName === "bash") {
				const command =
					typeof event.input.command === "string" ? event.input.command : "";
				if (!isReadOnlyCommand(command)) {
					return { kind: "block", reason: blockedBashReason(command) };
				}
			}
			return undefined;
		},
	});

	// Mode banner: chained append to the current system prompt while enabled.
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		// event.systemPrompt is the current (possibly already modified by other
		// extensions) system prompt — append, don't replace.
		return {
			systemPrompt: appendAskBanner(event.systemPrompt, {
				helperTools: activeHelperTools(),
			}),
		};
	});
}
