/**
 * `/ask-talk` — annotate the agent's last reply in the browser.
 *
 * Deliberately NOT a phase: it registers no tool, changes no tool set, touches no
 * permission mode and adds nothing to the system prompt, so it costs nothing
 * until the operator types it, and it works inside `/ask`, `/ask-spec` and
 * `/ask-uat` alike.
 *
 * The page is a snapshot. Running the command again refreshes it: same reply ⇒
 * notes and draft survive, different reply ⇒ they are cleared (the block ids are
 * content hashes, so a new reply means new ids and every note would be orphaned).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openInBrowser } from "../../lib/opener.js";
import { parseBlocks } from "../review-page/blocks.js";
import { extractHeadings } from "../review-page/headings.js";
import { buildReplyMessage, type TalkNote } from "./message.js";
import { extractLastReply } from "./reply.js";
import { startTalkServer, type TalkServerHandle, type TalkSession } from "./server.js";

export const TALK_COMMAND = "ask-talk";
/** 3501 — a different pool from spec/uat (3401), so a URL says which page it is. */
const PORT_START = 3501;

export interface TalkOptions {
	openBrowser?: (url: string) => unknown;
	portStart?: number;
	portAttempts?: number;
	closeDelayMs?: number;
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return `pid-${process.pid}`;
	}
}

/** Notes as an ordered list, for the message builder. */
function noteList(notes: Record<string, string>): TalkNote[] {
	return Object.entries(notes).map(([blockId, text]) => ({ blockId, text }));
}

export function registerTalk(pi: ExtensionAPI, options: TalkOptions = {}): void {
	const open = options.openBrowser ?? openInBrowser;

	let session: TalkSession | undefined;
	let server: TalkServerHandle | undefined;
	let talkSessionId: string | undefined;
	let ctxRef: ExtensionContext | undefined;

	function closeServer(): void {
		if (!server) return;
		const closing = server;
		server = undefined;
		void closing.close();
	}

	/** Start (or restart) a server for this snapshot, with one consistent error path. */
	async function openFresh(current: TalkSession, ctx: ExtensionContext): Promise<void> {
		closeServer();
		try {
			const handle = await startServer(current);
			server = handle;
			open(handle.url);
			ctx.ui.notify(`ask-talk: review open at ${handle.url}`, "info");
		} catch (error) {
			ctx.ui.notify(
				`ask-talk: cannot start the review server — ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	/**
	 * Whether the annotated reply is still in the model's active context.
	 *
	 * A compaction can summarize away the very message being annotated; the
	 * message builder then repeats the reply once, because the quotes would
	 * otherwise point at text the model cannot see.
	 */
	function replyInContext(ctx: ExtensionContext, entryId: string): boolean {
		if (entryId === "") return true;
		try {
			const entries = ctx.sessionManager.buildContextEntries() as Array<{ id?: unknown }>;
			return entries.some((entry) => entry.id === entryId);
		} catch {
			// Unknown shape on an older host: assume context is intact rather than
			// paying for a full re-send of the reply on every Continue.
			return true;
		}
	}

	function startServer(current: TalkSession): Promise<TalkServerHandle> {
		return startTalkServer({
			session: current,
			portStart: options.portStart ?? PORT_START,
			portAttempts: options.portAttempts,
			closeDelayMs: options.closeDelayMs,
			onContinue: ({ notes, message }) => {
				// off / shutdown / a session switch invalidates the snapshot at once;
				// an already in-flight HTTP request must not leak into the next session.
				if (session !== current) return;
				// The operator may have started another run (and a compaction) while the
				// page was open. Context survival is a property of Continue time, not of
				// the moment the page was opened.
				current.inContext = ctxRef ? replyInContext(ctxRef, current.entryId) : current.inContext;
				const text = buildReplyMessage({
					blocks: current.blocks,
					notes: noteList(notes),
					message,
					inContext: current.inContext,
					replyText: current.text,
				});
				if (text.trim() === "") return;
				pi.sendUserMessage(text);
			},
		});
	}

	const command = {
		description:
			"Annotate the agent's last reply in the browser: block notes plus a message, sent back as one short message. `off` closes the page.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim();
			ctxRef = ctx;

			if (arg === "off") {
				if (!session && !server) {
					ctx.ui.notify("ask-talk: nothing open.", "info");
					return;
				}
				closeServer();
				session = undefined;
				ctx.ui.notify("ask-talk: closed.", "info");
				return;
			}

			if (arg !== "") {
				ctx.ui.notify("ask-talk: takes no arguments (use `off` to close the page).", "warning");
				return;
			}

			// The host persists an assistant message on `message_end`, so while a run
			// is in flight the branch still ends with the PREVIOUS reply. Showing it
			// would be silently wrong; say so instead.
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"ask-talk: the agent is still running — finish or abort first, then run /ask-talk.",
					"warning",
				);
				return;
			}

			let entries: unknown[] = [];
			try {
				entries = ctx.sessionManager.getBranch() as unknown[];
			} catch {
				entries = [];
			}
			const reply = extractLastReply(entries);
			if (!reply) {
				ctx.ui.notify(
					"ask-talk: no reply to annotate yet — send a prompt and wait for the answer.",
					"warning",
				);
				return;
			}

			const inContext = replyInContext(ctx, reply.entryId);
			const sameReply =
				session !== undefined && !session.sent && session.fingerprint === reply.fingerprint;

			if (sameReply && session) {
				session.inContext = inContext;
				if (server?.active() !== true) {
					await openFresh(session, ctx);
					return;
				}
				// Nothing about the snapshot changed. Re-fetching here would overwrite
				// keystrokes still inside the page's save debounce window.
				ctx.ui.notify(`ask-talk: already showing this reply — ${server.url}`, "info");
				return;
			}

			const blocks = parseBlocks(reply.text);
			const next: TalkSession = {
				text: reply.text,
				blocks,
				headings: extractHeadings(blocks),
				entryId: reply.entryId,
				model: reply.model,
				at: reply.at,
				fingerprint: reply.fingerprint,
				notes: {},
				draft: "",
				sent: false,
				inContext,
			};

			const previous = session;
			const replaced = previous !== undefined && previous.fingerprint !== reply.fingerprint;
			talkSessionId = sessionIdOf(ctx);

			if (previous && server?.active()) {
				// The routes and the Continue callback both close over the object passed
				// to startTalkServer. Replace its CONTENTS, not just the `session`
				// variable, or a refresh would serve and submit the previous reply.
				Object.assign(previous, next);
				session = previous;
				server.broadcast("refresh", {});
				ctx.ui.notify(
					`ask-talk: review refreshed${replaced ? " (notes cleared — this is a new reply)" : ""} — ${server.url}`,
					"info",
				);
				return;
			}

			session = next;
			await openFresh(next, ctx);
		},
	};

	pi.registerCommand(TALK_COMMAND, command);

	pi.on("session_shutdown", () => {
		closeServer();
		session = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		const nextSessionId = sessionIdOf(ctx);
		ctxRef = ctx;
		if (nextSessionId === talkSessionId) return;
		// A different session must not keep a page bound to the old reply.
		talkSessionId = undefined;
		session = undefined;
		closeServer();
	});
}
