/**
 * ask feature — read-only consult mode.
 *
 * Design notes (see PLAN.md and AGENTS.md):
 *  - Project writes stay impossible: write/edit/powershell are removed from the
 *    active tool set via pi.setActiveTools(), and pi's runtime rejects calls to
 *    non-active tools ("Tool not found"). A gate blocks them again as defence in
 *    depth, in case anything re-enables them.
 *  - The mode is not "no writes at all": a consult session may need somewhere to
 *    keep an outline or a checklist, and confiscating temp files made the mode
 *    hostile enough that it went unused. One write channel is allowed —
 *    `scratchpad`, which takes a relative note name and can only reach
 *    `<os.tmpdir()>/pi-ask/<session>`. It is registered `defaultActive: false`
 *    and activated for the duration, so no path ever arrives from the model and
 *    the bash sandbox needs no write allowance. When no writable temp dir
 *    exists, the tool stays inactive and ask mode degrades to pure read-only.
 *  - Read-only helper tools (grep/find/ls) are activated for the duration so
 *    the model gets proper search tools; the entry snapshot restores exactly.
 *  - bash stays available but is gated by a read-only sandbox
 *    (see bash-sandbox.ts) through the shared gate bus (lib/gates.ts), so
 *    another feature's gate (`permission`) runs alongside it rather than
 *    replacing it: each feature owns its own concern and the call is blocked
 *    when either objects.
 *  - Mode banner appended to the system prompt via before_agent_start
 *    (see prompt.ts). It is short on purpose: a mode line, the scratch rule, and
 *    the exit path. Everything else is learned from tool declarations and from
 *    rejection reasons, which cost tokens only when they apply.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { GateHub } from "../../lib/gates.js";
// The jailed-tool registry lives here too: ask marks `scratchpad` while the mode
// is active so the boundary gate (`permission`) knows it has no path to judge.
import {
	clearJailedTool,
	markJailedTool,
	restoreActiveTools,
	snapshotActiveTools,
	withoutTools,
} from "../../lib/tools.js";
import {
	ASK_BLOCKED_TOOLS,
	ASK_READ_ONLY_HELPERS,
	ASK_SCRATCH_TOOL,
	ASK_STATUS_KEY,
	ASK_STATUS_LABEL,
} from "./constants.js";
import { isReadOnlyCommand } from "./bash-sandbox.js";
import { appendAskBanner } from "./prompt.js";
import { blockedBashReason, blockedToolReason } from "./reasons.js";
import { createScratchStore, type ScratchStore } from "./scratch.js";
import { registerScratchTool } from "./scratch-tool.js";

export interface AskOptions {
	/**
	 * Base directory for the scratch space. Default: the OS temp dir. Tests
	 * inject a fresh directory so they never touch the real temp space.
	 */
	readonly scratchBaseDir?: string;
}

/** Session id, or a process-scoped fallback when the host exposes none. */
function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return `pid-${process.pid}`;
	}
}

export function registerAsk(
	pi: ExtensionAPI,
	gates: GateHub,
	options: AskOptions = {},
): void {
	let enabled = false;
	/** Active tools before ask mode was entered (for exact restore on exit). */
	let snapshot: string[] = [];
	/** Scratch space of this session, or undefined when unavailable. */
	let scratch: ScratchStore | undefined;
	/** Session id the scratch store is bound to (rebound on session switch). */
	let scratchSessionId: string | undefined;

	// The tool is registered up front but stays inactive: activating it on entry
	// is what puts its declaration (and guidelines) into the request.
	registerScratchTool(pi, () => scratch);

	/**
	 * Create the scratch store for `sessionId` and bind the state. On failure the
	 * mode runs degraded (no scratch tool), with a warning.
	 */
	function bindScratch(ctx: ExtensionContext, sessionId: string): void {
		try {
			scratch = createScratchStore({
				sessionId,
				baseDir: options.scratchBaseDir,
			});
			scratchSessionId = sessionId;
			// Self-jailed: permission has no boundary to judge for this tool.
			markJailedTool(ASK_SCRATCH_TOOL);
		} catch (error) {
			// No usable temp dir (read-only TMPDIR, locked-down container, …): fall
			// back to the fully read-only mode rather than half-opening one.
			scratch = undefined;
			scratchSessionId = undefined;
			clearJailedTool(ASK_SCRATCH_TOOL);
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Ask mode: no scratch space (${reason}) — fully read-only.`,
				"warning",
			);
		}
	}

	/** Gray footer status while ask mode is active; cleared on exit. */
	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			ASK_STATUS_KEY,
			enabled ? ctx.ui.theme.fg("muted", ASK_STATUS_LABEL) : undefined,
		);
	}

	/**
	 * The tool set ask mode pins: entry snapshot minus the confiscated tools, plus
	 * the read-only helpers and the scratch tool.
	 *
	 * Recomputed (not just applied on entry) because `setActiveTools()` during
	 * `session_start` — which is how autostart enters the mode — is overwritten
	 * by the host's loadout preparation for the first run: the mode banner still
	 * appears, but the run would not declare `scratchpad` (or the helpers).
	 * Re-asserting in `before_agent_start` makes the mode's tool surface
	 * deterministic for every run.
	 */
	function askToolSet(): string[] {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const helpers = ASK_READ_ONLY_HELPERS.filter(
			(name) => registered.has(name) && !snapshot.includes(name),
		);
		const tools = [...withoutTools(snapshot, ASK_BLOCKED_TOOLS), ...helpers];
		if (scratch !== undefined && registered.has(ASK_SCRATCH_TOOL)) {
			tools.push(ASK_SCRATCH_TOOL);
		}
		return tools;
	}

	// Synchronous on purpose: creating the scratch store is sync (see scratch.ts),
	// so a `/ask` dispatched from `session_start` completes before the first run.
	function enter(ctx: ExtensionContext): void {
		if (enabled) return;
		enabled = true;
		snapshot = snapshotActiveTools(pi);
		bindScratch(ctx, sessionIdOf(ctx));
		pi.setActiveTools(askToolSet());
		updateStatus(ctx);
		ctx.ui.notify(
			scratch === undefined
				? "Ask mode ON — read-only, no scratch space. /ask to exit."
				: `Ask mode ON — read-only; notes go to ${scratch.root}. /ask to exit.`,
			"info",
		);
	}

	function exit(ctx: ExtensionContext): void {
		if (!enabled) return;
		enabled = false;
		clearJailedTool(ASK_SCRATCH_TOOL);
		scratch = undefined;
		scratchSessionId = undefined;
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
		description: "Toggle ask mode (consult mode: no project writes, scratch notes allowed)",
		handler: async (_args, ctx) => {
			toggle(ctx);
		},
	});

	// The scratch space is per session: an in-process session switch (/new,
	// /resume, fork) while the mode is on rebinds it to the new session id, so
	// notes do not keep landing in the previous session's directory. A repeated
	// emission for the same session (startup rebind) is a no-op.
	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		const sessionId = sessionIdOf(ctx);
		if (sessionId === scratchSessionId) return;
		bindScratch(ctx, sessionId);
		pi.setActiveTools(askToolSet());
		if (scratch !== undefined) {
			ctx.ui.notify(
				`Ask mode: notes now go to ${scratch.root}.`,
				"info",
			);
		}
	});

	// Defense-in-depth gate while ask mode is active:
	//  - write/edit/powershell are already removed from the active set (runtime
	//    rejects them); this blocks them again in case anything re-enables them.
	//  - bash is kept available but only read-only commands pass the sandbox.
	//    Scratch notes are written by the `scratchpad` tool, not by bash, so the
	//    sandbox needs no write allowance and no path analysis.
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
					reason: blockedToolReason(event.toolName, {
						scratch: scratch !== undefined,
					}),
				};
			}

			if (event.toolName === "bash") {
				const command =
					typeof event.input.command === "string" ? event.input.command : "";
				if (!isReadOnlyCommand(command)) {
					return {
						kind: "block",
						reason: blockedBashReason(command, {
							scratch: scratch !== undefined,
						}),
					};
				}
			}
			return undefined;
		},
	});

	// Mode banner: chained append to the current system prompt while enabled.
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		// Re-assert the mode's tool surface: entering from `session_start` (the
		// autostart path) is followed by the host's loadout preparation for the
		// first run, which would otherwise drop the tools set on entry.
		// Documented contract: a handler may call setActiveTools() and the live
		// loadout wins over the prepared selection.
		pi.setActiveTools(askToolSet());
		// event.systemPrompt is the current (possibly already modified by other
		// extensions) system prompt — append, don't replace.
		return {
			systemPrompt: appendAskBanner(event.systemPrompt, {
				scratch: scratch !== undefined,
			}),
		};
	});
}
// (No other write path exists in ask mode: bash is read-only, and the scratch
// tool is the only thing that can create a file — inside its own temp dir.)
