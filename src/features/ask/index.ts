/**
 * ask feature — read-only Q&A mode.
 *
 * Design notes (see PLAN.md):
 *  - Hard guarantee: write/edit are removed from the active tool set via
 *    pi.setActiveTools(); pi's runtime rejects calls to non-active tools
 *    ("Tool not found") so nothing executes.
 *  - bash stays available but is gated by a read-only sandbox
 *    (see bash-sandbox.ts) via the tool_call hook.
 *  - Mode banner appended to the system prompt via before_agent_start
 *    chained systemPrompt (see prompt.ts).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  restoreActiveTools,
  snapshotActiveTools,
  withoutTools,
} from "../../lib/tools.js";
import {
  ASK_BLOCKED_TOOLS,
  ASK_STATUS_KEY,
  ASK_STATUS_LABEL,
} from "./constants.js";
import { isReadOnlyCommand } from "./bash-sandbox.js";
import { appendAskBanner } from "./prompt.js";

export function registerAsk(pi: ExtensionAPI): void {
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

  function enter(ctx: ExtensionContext): void {
    if (enabled) return;
    enabled = true;
    snapshot = snapshotActiveTools(pi);
    pi.setActiveTools(withoutTools(snapshot, ASK_BLOCKED_TOOLS));
    updateStatus(ctx);
    ctx.ui.notify("Ask mode ON — read-only (write/edit disabled). /ask to exit.", "info");
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
  //  - write/edit are already removed from the active set (runtime rejects
  //    them), this blocks them again in case anything re-enables them.
  //  - bash is kept available but only read-only commands pass the sandbox.
  pi.on("tool_call", (event) => {
    if (!enabled) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason: "Ask mode: write/edit are disabled. Use /ask to exit ask mode first.",
      };
    }

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isReadOnlyCommand(command)) {
        return {
          block: true,
          reason: `Ask mode: only read-only bash commands are allowed.\nCommand: ${command}\nUse /ask to exit ask mode first.`,
        };
      }
    }
  });

  // Mode banner: chained append to the current system prompt while enabled.
  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    // event.systemPrompt is the current (possibly already modified by other
    // extensions) system prompt — append, don't replace.
    return { systemPrompt: appendAskBanner(event.systemPrompt) };
  });
}
