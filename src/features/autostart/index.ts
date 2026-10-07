/**
 * autostart feature — run project-declared slash commands at session start.
 *
 * Config lives at `<project root>/.pi/autostart.toml` (see autostart.ts for
 * the schema). Execution gates, in order:
 *
 *  1. reason filter — only startup/new/fork replay (see RUNNABLE_REASONS)
 *  2. config file exists — a missing file is a silent opt-in skip
 *  3. `ctx.isProjectTrusted()` — an untrusted project never auto-executes
 *  4. per-command pre-validation against `pi.getCommands()`: only commands
 *     registered by an *extension* are dispatched. This is mandatory:
 *     sendUserMessage with an unhandled "/x" falls through prompt() to the
 *     model as a plain user message (pi agent-session.js), so an unknown
 *     command must be skipped here, never sent.
 *
 * Dispatch uses `sendUserMessage(cmd, { expandPromptTemplates: true })` —
 * that flag is what routes "/cmd args" through _tryExecuteExtensionCommand
 * instead of the model prompt path. The wrapper defaults it to false
 * (verified against pi 1.0.4 agent-session.js; see AGENTS.md host-compat
 * discipline for the version matrix).
 *
 * Only extension commands can run this way. Built-in commands (/compact,
 * /reload, /resume, …) are dispatched at the TUI layer and cannot be
 * triggered from the extension layer; skill commands (/skill:name) expand
 * into prompts rather than execute. First-party use case: `/add-dir`
 * (pi-add-dir), which is idempotent ("Already added" check).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AUTOSTART_CONFIG_PATH,
	AutostartParseError,
	commandNameOf,
	parseAutostartConfig,
	RUNNABLE_REASONS,
} from "./autostart.js";

export function registerAutostart(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		if (!RUNNABLE_REASONS.has(event.reason)) return;

		let text: string;
		try {
			text = await readFile(join(ctx.cwd, AUTOSTART_CONFIG_PATH), "utf8");
		} catch (err) {
			// Missing file = opt-in skip. Any other read failure (EACCES, EISDIR,
			// …) is a misconfiguration the operator should hear about.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				ctx.ui.notify(
					`autostart: skipped — cannot read ${AUTOSTART_CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
			return;
		}

		let commands: string[];
		try {
			commands = parseAutostartConfig(text);
		} catch (err) {
			const message = err instanceof AutostartParseError ? err.message : String(err);
			ctx.ui.notify(
				`autostart: skipped — ${message} (${AUTOSTART_CONFIG_PATH})`,
				"error",
			);
			return;
		}
		if (commands.length === 0) return;

		if (!ctx.isProjectTrusted()) {
			ctx.ui.notify(
				`autostart: skipped — project not trusted (${AUTOSTART_CONFIG_PATH})`,
				"warning",
			);
			return;
		}

		// Only extension-registered commands are dispatchable; skill and
		// prompt-template entries expand rather than execute.
		const dispatchable = new Set(
			pi
				.getCommands()
				.flatMap((cmd) =>
					cmd.source === "extension" ? [cmd.name.replace(/^\//, "")] : [],
				),
		);

		for (const command of commands) {
			const name = commandNameOf(command);
			if (!name || !dispatchable.has(name)) {
				ctx.ui.notify(
					`autostart: skipped "${command}" — not a registered extension command`,
					"warning",
				);
				continue;
			}
			// One failing command must not cancel the rest of the list.
			try {
				await pi.sendUserMessage(command, { expandPromptTemplates: true });
			} catch (err) {
				ctx.ui.notify(
					`autostart: "${command}" failed — ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		}
	});
}
