/**
 * autostart feature — run declared slash commands at session start.
 *
 * Two sources, executed in order, never merged:
 *
 *  1. `<agentDir>/autostart.toml` — the operator's own defaults. Runs in every
 *     project; no trust gate, because the file lives in pi's config directory
 *     and is not controlled by the project.
 *  2. `<project root>/.pi/autostart.toml` — project-declared commands. Gated on
 *     `ctx.isProjectTrusted()`: an untrusted repository must not execute
 *     anything.
 *
 * Execution gates, in order:
 *
 *  - reason filter — see `shouldReplay`: startup/new/fork replay, but a
 *    `startup` that already carries conversation history is a process started
 *    on an existing session (`pi -c`/`-r`/`--session`/`--fork`) and does not
 *  - config file exists — a missing file is a silent opt-in skip
 *  - project trust (project source only)
 *  - per-command pre-validation against `pi.getCommands()`: only commands
 *    registered by an *extension* are dispatched. This is mandatory:
 *    sendUserMessage with an unhandled "/x" falls through prompt() to the
 *    model as a plain user message (pi agent-session.js), so an unknown
 *    command must be skipped here, never sent.
 *
 * Dispatch uses `sendUserMessage(cmd, { expandPromptTemplates: true })` —
 * that flag is what routes "/cmd args" through _tryExecuteExtensionCommand
 * instead of the model prompt path. The wrapper defaults it to false in this
 * package (each byte-identical across every published version of the supported
 * window, 1.0.0 → 1.3.0; see AGENTS.md host-compat discipline for the version
 * matrix).
 *
 * Only extension commands can run this way. Built-in commands (/compact,
 * /reload, /resume, …) are dispatched at the TUI layer and cannot be
 * triggered from the extension layer; skill commands (/skill:name) expand
 * into prompts rather than execute. First-party use cases: `/add-dir`
 * (pi-add-dir, idempotent) and `/ask-perm` (session-scoped permission).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AUTOSTART_CONFIG_PATH,
	AutostartParseError,
	commandNameOf,
	GLOBAL_AUTOSTART_FILENAME,
	parseAutostartConfig,
	shouldReplay,
} from "./autostart.js";

export interface AutostartOptions {
	/** pi's config directory; defaults to `getAgentDir()`. */
	readonly agentDir?: string;
}

interface Source {
	readonly path: string;
	readonly label: string;
	/** Project sources require trust; the operator's global file does not. */
	readonly requiresTrust: boolean;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Entry types that prove the session already held a conversation.
 *
 * `buildContextEntries()` returns the active branch's entries including the
 * boot-level ones (`session`, `model_change`, `thinking_level_change`), so
 * presence alone is not enough — a brand-new session has those too.
 */
const HISTORY_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"message",
	"custom_message",
	"compaction",
	"branch_summary",
]);

/**
 * Whether the session already carries conversation history.
 *
 * This is how a `startup` on an existing session (a resumed process) is told
 * apart from a genuinely new one — see {@link shouldReplay}. An unreadable
 * session manager counts as new, which keeps the feature working in hosts where
 * the session surface is unavailable.
 */
/** Session id, or `undefined` when the host exposes none. */
function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function hasConversationHistory(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager
			.buildContextEntries()
			.some((entry) => HISTORY_ENTRY_TYPES.has(entry.type));
	} catch {
		return false;
	}
}

export function registerAutostart(
	pi: ExtensionAPI,
	options: AutostartOptions = {},
): void {
	const agentDir = options.agentDir ?? getAgentDir();
	// One replay per session. The host can emit `session_start` more than once
	// for the same session (a runtime rebind during startup reports `startup`
	// again), and replaying on the second emission would announce everything
	// twice.
	const replayedSessions = new Set<string>();

	async function readCommands(
		ctx: ExtensionContext,
		source: Source,
	): Promise<string[] | undefined> {
		let text: string;
		try {
			text = await readFile(source.path, "utf8");
		} catch (err) {
			// Missing file = opt-in skip. Any other read failure (EACCES, EISDIR,
			// …) is a misconfiguration the operator should hear about.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				ctx.ui.notify(
					`autostart: skipped ${source.label} — cannot read ${source.path}: ${messageOf(err)}`,
					"warning",
				);
			}
			return undefined;
		}

		try {
			return parseAutostartConfig(text);
		} catch (err) {
			const message = err instanceof AutostartParseError ? err.message : String(err);
			ctx.ui.notify(
				`autostart: skipped ${source.label} — ${message} (${source.path})`,
				"error",
			);
			return undefined;
		}
	}

	pi.on("session_start", async (event, ctx) => {
		// `pi -c` / `-r` / `--session` / `--fork` report `startup` for a session
		// that already has history; the content is what tells them apart. See
		// shouldReplay in autostart.ts for the host-side evidence.
		if (!shouldReplay(event.reason, hasConversationHistory(ctx))) return;

		const sessionId = sessionIdOf(ctx);
		if (sessionId !== undefined) {
			if (replayedSessions.has(sessionId)) return;
			replayedSessions.add(sessionId);
		}

		const sources: Source[] = [
			{
				path: join(agentDir, GLOBAL_AUTOSTART_FILENAME),
				label: "global config",
				requiresTrust: false,
			},
			{
				path: join(ctx.cwd, AUTOSTART_CONFIG_PATH),
				label: "project config",
				requiresTrust: true,
			},
		];

		// Only extension-registered commands are dispatchable; skill and
		// prompt-template entries expand rather than execute.
		const dispatchable = new Set(
			pi
				.getCommands()
				.flatMap((cmd) =>
					cmd.source === "extension" ? [cmd.name.replace(/^\//, "")] : [],
				),
		);

		// The same line may be declared by both sources (global defaults plus a
		// project copy). Running an identical command twice in one replay is
		// never meaningful — a repeated `/ask-perm` would re-notify, and a
		// repeated `/add-dir` is pure noise — so identical text runs once.
		// Different commands still both run, which keeps the project's override.
		const dispatched = new Set<string>();

		for (const source of sources) {
			const commands = await readCommands(ctx, source);
			if (commands === undefined || commands.length === 0) continue;

			if (source.requiresTrust && !ctx.isProjectTrusted()) {
				ctx.ui.notify(
					`autostart: skipped ${source.label} — project not trusted (${source.path})`,
					"warning",
				);
				continue;
			}

			for (const command of commands) {
				const name = commandNameOf(command);
				if (!name || !dispatchable.has(name)) {
					ctx.ui.notify(
						`autostart: skipped "${command}" — not a registered extension command`,
						"warning",
					);
					continue;
				}
				if (dispatched.has(command)) continue;
				dispatched.add(command);
				// One failing command must not cancel the rest of the list.
				try {
					await pi.sendUserMessage(command, { expandPromptTemplates: true });
				} catch (err) {
					ctx.ui.notify(
						`autostart: "${command}" failed — ${messageOf(err)}`,
						"error",
					);
				}
			}
		}
	});
}
