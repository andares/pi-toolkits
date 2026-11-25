/**
 * talk server — the reply-annotation page, served from inside pi.
 *
 * Same contract as the spec review (`/ask-spec`), minus the things a snapshot
 * does not have: no revisions, no diff, no decision. The page pulls
 * `/api/state`, writes notes and the composer draft back as the operator types,
 * and `POST /api/continue` ends the round.
 *
 * One snapshot accepts exactly one Continue. After it, every write route answers
 * 409 and the port closes: the page is a tab the operator opened, so a second
 * submit from a stale tab must not deliver a second message into the session.
 *
 * The HTTP shell (token, Host allowlist, Origin refusal, port walk, static
 * files, SSE) lives in `src/lib/web-review.ts`.
 */
import { fileURLToPath } from "node:url";
import { blockLabel, type Block } from "../review-page/blocks.js";
import type { Heading } from "../review-page/headings.js";
import { renderBlockHtml } from "../review-page/render.js";
import { bindHost, isWsl, urlHost } from "../../lib/opener.js";
import { startWebServer, type WebServerHandle } from "../../lib/web-review.js";

/** The one reply being annotated. Lives in memory; a session switch drops it. */
export interface TalkSession {
	text: string;
	blocks: Block[];
	headings: Heading[];
	model?: string;
	at: string;
	/** Session entry id, rechecked when Continue actually arrives. */
	entryId: string;
	fingerprint: string;
	/** blockId → note. One note per block by design. */
	notes: Record<string, string>;
	/** Composer text — kept server-side so a page refresh does not erase it. */
	draft: string;
	sent: boolean;
	/** False when compaction pushed the reply out of the model's context. */
	inContext: boolean;
}

export interface TalkStateItem {
	id: string;
	kind: Block["kind"];
	html: string;
	label: string;
}

export interface TalkStatePayload {
	mode: "talk";
	reply: { model?: string; at: string; chars: number };
	items: TalkStateItem[];
	headings: Heading[];
	notes: Record<string, string>;
	draft: string;
	sent: boolean;
}

/** Everything except the rendered HTML, which needs the renderer. */
export function buildTalkState(session: TalkSession): TalkStatePayload {
	return {
		mode: "talk",
		reply: { model: session.model, at: session.at, chars: session.text.length },
		items: session.blocks.map((block) => ({
			id: block.id,
			kind: block.kind,
			html: "",
			label: blockLabel(block),
		})),
		headings: session.headings,
		notes: { ...session.notes },
		draft: session.draft,
		sent: session.sent,
	};
}

/**
 * Keep only notes that point at a block of this reply.
 *
 * A page left open across a refresh can post ids the new reply does not have;
 * forwarding those would put a quote-less note in front of the model.
 */
export function sanitizeNotes(input: unknown, blocks: readonly Block[]): Record<string, string> {
	const known = new Set<string>();
	for (const block of blocks) {
		if (block.kind !== "heading") known.add(block.id);
	}
	const raw = (input ?? {}) as Record<string, unknown>;
	const notes: Record<string, string> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!known.has(id)) continue;
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (text === "") continue;
		notes[id] = value;
	}
	return notes;
}

const MAX_DRAFT = 200_000;

export interface StartTalkServerOptions {
	session: TalkSession;
	/** Directory with the built UI. Defaults to the shared review-page assets. */
	assetsDir?: string;
	portStart?: number;
	portAttempts?: number;
	/** Milliseconds between Continue and the port closing. */
	closeDelayMs?: number;
	render?: (block: Pick<Block, "kind" | "text">) => string;
	/** Fired once, as soon as Continue is accepted. */
	onContinue?: (result: { notes: Record<string, string>; message: string }) => void;
	onNotes?: (result: { notes: Record<string, string>; draft: string }) => void;
	bindHost?: string;
	urlHost?: string;
}

export interface TalkServerHandle {
	url: string;
	port: number;
	token: string;
	close: () => Promise<void>;
	broadcast: (event: string, data: unknown) => void;
	/** False once Continue was accepted or `close()` ran. */
	active: () => boolean;
}

export async function startTalkServer(
	options: StartTalkServerOptions,
): Promise<TalkServerHandle> {
	const assetsDir =
		options.assetsDir ?? fileURLToPath(new URL("../review-page/assets/", import.meta.url));
	const render = options.render ?? renderBlockHtml;
	const closeDelayMs = options.closeDelayMs ?? 1200;
	let closing = false;
	let closed = false;
	let handle: WebServerHandle | undefined;

	const closeHandle = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		closing = true;
		await handle?.close();
	};

	const server = await startWebServer({
		assetsDir,
		portStart: options.portStart ?? 3501,
		portAttempts: options.portAttempts,
		bindHost: options.bindHost ?? bindHost(isWsl()),
		urlHost: options.urlHost ?? urlHost(isWsl()),
		routes: async (ctx) => {
			if (ctx.url.pathname === "/api/state" && ctx.req.method === "GET") {
				const state = buildTalkState(options.session);
				const html = new Map<string, string>();
				for (const block of options.session.blocks) html.set(block.id, render(block));
				ctx.json({
					...state,
					items: state.items.map((item) => ({ ...item, html: html.get(item.id) ?? "" })),
				});
				return true;
			}

			if (ctx.url.pathname === "/api/notes" && ctx.req.method === "POST") {
				if (closing || options.session.sent) {
					ctx.json({ error: "this reply has already been sent" }, 409);
					return true;
				}
				const body = (await ctx.readBody()) as { notes?: unknown; draft?: unknown };
				const notes = sanitizeNotes(body.notes, options.session.blocks);
				const draft = typeof body.draft === "string" ? body.draft.slice(0, MAX_DRAFT) : "";
				options.session.notes = notes;
				options.session.draft = draft;
				options.onNotes?.({ notes, draft });
				ctx.json({ ok: true });
				return true;
			}

			if (ctx.url.pathname === "/api/continue" && ctx.req.method === "POST") {
				if (closing || options.session.sent) {
					ctx.json({ error: "this reply has already been sent" }, 409);
					return true;
				}
				const body = (await ctx.readBody()) as { notes?: unknown; message?: unknown };
				const notes = sanitizeNotes(body.notes, options.session.blocks);
				const message = typeof body.message === "string" ? body.message.slice(0, MAX_DRAFT) : "";
				options.session.notes = notes;
				options.session.draft = message;
				options.session.sent = true;
				closing = true;
				ctx.json({ ok: true });
				ctx.broadcast("sent", { at: new Date().toISOString() });
				options.onContinue?.({ notes, message });
				setTimeout(() => void closeHandle(), closeDelayMs).unref();
				return true;
			}

			return false;
		},
	});
	handle = server;

	return {
		url: server.url,
		port: server.port,
		token: server.token,
		close: closeHandle,
		broadcast: server.broadcast,
		active: () => !closing && !closed,
	};
}
