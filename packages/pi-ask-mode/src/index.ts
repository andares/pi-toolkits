/**
 * @andares/pi-ask-mode — lightweight ask mode for pi.
 *
 * Planned capabilities (design discussion, not yet implemented):
 *
 * - `/ask` toggle command; gray status hint on toggle (setStatus with
 *   theme.fg("muted", ...))
 * - Hard guarantee: write/edit removed from the active tool set via
 *   pi.setActiveTools() (runtime rejects non-active tools, verified in
 *   pi agent-loop prepareToolCall)
 * - bash kept available but gated by a read-only command sandbox
 *   (shell-quote based; either vendored or via @dreki-gg/pi-command-sandbox)
 * - Mode banner appended to the system prompt via before_agent_start
 *   chained systemPrompt (append to event.systemPrompt — do NOT use the
 *   removed systemPromptAppend field or full-systemPrompt replacement)
 *
 * Skeleton only — business logic to be filled in.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function askMode(pi: ExtensionAPI): void {
  void pi;
  // TODO: implement /ask toggle, tool gating, bash sandbox, prompt banner.
}
