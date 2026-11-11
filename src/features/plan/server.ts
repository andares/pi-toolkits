/**
 * plan server — the review UI, served from inside the pi process.
 *
 * Shape of the contract:
 *   - one revision is reviewed at a time; the page pulls `/api/state` and then
 *     follows `/api/events` (SSE) for new revisions and annotations;
 *   - the browser posts annotations and the decision; both land in the store,
 *     and the decision resolves a promise the extension is awaiting — no IPC,
 *     no unix socket, no second process (the browser can only speak HTTP, and
 *     the server is already in the process that needs the answer);
 *   - on a decision the server broadcasts it, answers the request, and closes
 *     shortly after, so a finished review cannot keep a port open.
 *
 * The HTTP shell (token, Host allowlist, Origin refusal, port walk, static
 * files, SSE) lives in `src/lib/web-review.ts`; this file is the plan-specific
 * routes and payload.
 */
import { fileURLToPath } from "node:url";
import { blockLabel, type Block } from "./blocks.js";
import type { BlockStatus, DiffEntry } from "./diff.js";
import type { Annotation, BlockAnnotations } from "./feedback.js";
import {
	latestVersion,
	recordPlanDecision,
	setPlanAnnotations,
	type PlanAnnotations,
	type PlanSession,
} from "./store.js";
import { bindHost, isWsl, urlHost } from "../../lib/opener.js";
import { startWebServer, type WebServerHandle } from "../../lib/web-review.js";
import { renderBlockHtml } from "./render.js";

export interface PlanStateItem {
	status: BlockStatus;
	id: string;
	prevId?: string;
	/** Rendered HTML of the block (escaped markdown subset). */
	html: string;
	/** First line, for the feedback text and the collapsed rail. */
	label: string;
}

export interface PlanStatePayload {
	slug: string;
	version: number;
	totalVersions: number;
	at: string;
	source?: string;
	items: PlanStateItem[];
	annotations: PlanAnnotations;
	decision?: { action: "approve" | "deny"; at: string };
	decided: boolean;
	/** Earlier revisions, newest first — the history drawer. */
	history: Array<{ n: number; at: string; changed: number }>;
}

/** Compose what the page renders: blocks of one revision, tagged with their diff status. */
export function buildPlanState(session: PlanSession, versionNumber?: number): PlanStatePayload {
	const version =
		versionNumber === undefined
			? latestVersion(session)
			: session.versions.find((candidate) => candidate.n === versionNumber);
	if (!version) throw new Error(`no plan revision ${versionNumber} in ${session.dir}`);
	const previous = session.versions.find((candidate) => candidate.n === version.n - 1);

	const byId = new Map<string, Block>(version.blocks.map((block) => [block.id, block]));
	const previousById = new Map<string, Block>(
		(previous?.blocks ?? []).map((block) => [block.id, block]),
	);
	// A first revision has nothing to diff against: no badges, not "all added".
	const entries: DiffEntry[] =
		version.diff.length > 0
			? version.diff
			: version.blocks.map((block) => ({ status: "unchanged" as const, id: block.id }));

	const items: PlanStateItem[] = [];
	for (const entry of entries) {
		const current = byId.get(entry.id);
		const source = current ?? previousById.get(entry.id);
		if (!source) continue;
		items.push({
			status: entry.status,
			id: entry.id,
			prevId: entry.prevId,
			html: "",
			label: blockLabel(source),
		});
	}

	return {
		slug: session.slug,
		version: version.n,
		totalVersions: latestVersion(session).n,
		at: version.at,
		source: version.source,
		items,
		annotations: version.annotations,
		decision: version.decision,
		decided: version.decision !== undefined,
		history: session.versions
			.map((candidate) => ({
				n: candidate.n,
				at: candidate.at,
				changed: candidate.diff.filter((entry) => entry.status !== "unchanged").length,
			}))
			.sort((a, b) => b.n - a.n),
	};
}

export interface StartPlanServerOptions {
	session: PlanSession;
	/** Directory with the built UI. Defaults to `./assets/` next to this module. */
	assetsDir?: string;
	portStart?: number;
	portAttempts?: number;
	/** Milliseconds between "decision received" and the port closing. */
	closeDelayMs?: number;
	/** Render a block to HTML (injected so tests can skip the renderer). */
	render?: (block: Pick<Block, "kind" | "text">) => string;
	onDecision?: (decision: { action: "approve" | "deny"; version: number }) => void;
	onAnnotations?: (annotations: PlanAnnotations, version: number) => void;
	/** Overridable for tests: bind address and host used in the URL. */
	bindHost?: string;
	urlHost?: string;
}

export interface PlanServerHandle {
	url: string;
	port: number;
	token: string;
	close: () => Promise<void>;
	broadcast: (event: string, data: unknown) => void;
}

function isVerdict(value: unknown): value is Annotation["verdict"] {
	return value === "change" || value === "suggest" || value === "question";
}

/** Normalize whatever the page sent into the store's annotation shape. */
export function normalizeAnnotations(input: unknown): PlanAnnotations {
	const raw = (input ?? {}) as { global?: unknown; blocks?: unknown };
	const toAnnotation = (value: unknown): Annotation | undefined => {
		const candidate = value as { verdict?: unknown; comment?: unknown };
		const comment = typeof candidate?.comment === "string" ? candidate.comment : "";
		const verdict = isVerdict(candidate?.verdict) ? candidate.verdict : undefined;
		if (!verdict || comment.trim() === "") return undefined;
		return { verdict, comment };
	};
	const global = Array.isArray(raw.global)
		? raw.global.map(toAnnotation).filter((value): value is Annotation => value !== undefined)
		: [];
	const blocks: BlockAnnotations[] = Array.isArray(raw.blocks)
		? raw.blocks
				.map((value) => {
					const group = value as { blockId?: unknown; annotations?: unknown };
					const blockId = typeof group?.blockId === "string" ? group.blockId : "";
					const annotations = Array.isArray(group?.annotations)
						? group.annotations
								.map(toAnnotation)
								.filter((item): item is Annotation => item !== undefined)
						: [];
					return { blockId, annotations };
				})
				.filter((group) => group.blockId !== "" && group.annotations.length > 0)
		: [];
	return { global, blocks };
}

export async function startPlanServer(options: StartPlanServerOptions): Promise<PlanServerHandle> {
	const assetsDir = options.assetsDir ?? fileURLToPath(new URL("./assets/", import.meta.url));
	const render = options.render ?? renderBlockHtml;
	const closeDelayMs = options.closeDelayMs ?? 1500;
	let closing = false;
	let handle: WebServerHandle | undefined;

	const server = await startWebServer({
		assetsDir,
		portStart: options.portStart,
		portAttempts: options.portAttempts,
		bindHost: options.bindHost ?? bindHost(isWsl()),
		urlHost: options.urlHost ?? urlHost(isWsl()),
		routes: async (ctx) => {
			if (ctx.url.pathname === "/api/state" && ctx.req.method === "GET") {
				const versionParam = ctx.url.searchParams.get("version");
				const state = buildPlanState(
					options.session,
					versionParam ? Number(versionParam) : undefined,
				);
				const version = options.session.versions.find(
					(candidate) => candidate.n === state.version,
				);
				const htmlById = new Map<string, string>();
				for (const block of version?.blocks ?? []) htmlById.set(block.id, render(block));
				const previous = options.session.versions.find(
					(candidate) => candidate.n === state.version - 1,
				);
				for (const block of previous?.blocks ?? []) {
					if (!htmlById.has(block.id)) htmlById.set(block.id, render(block));
				}
				ctx.json({
					...state,
					items: state.items.map((item) => ({ ...item, html: htmlById.get(item.id) ?? "" })),
				});
				return true;
			}

			if (ctx.url.pathname === "/api/annotate" && ctx.req.method === "POST") {
				const body = (await ctx.readBody()) as { version?: number; annotations?: unknown };
				const annotations = normalizeAnnotations(body.annotations);
				const version = body.version ?? latestVersion(options.session).n;
				if (version !== latestVersion(options.session).n || closing) {
					ctx.json({ error: "only the latest undecided revision can be annotated" }, 409);
					return true;
				}
				setPlanAnnotations(options.session, version, annotations);
				options.onAnnotations?.(annotations, version);
				ctx.broadcast("annotations", { version, annotations });
				ctx.json({ ok: true, version });
				return true;
			}

			if (ctx.url.pathname === "/api/decide" && ctx.req.method === "POST") {
				const body = (await ctx.readBody()) as { action?: unknown; version?: number };
				const action =
					body.action === "approve" || body.action === "deny" ? body.action : undefined;
				if (!action) {
					ctx.json({ error: "action must be approve or deny" }, 400);
					return true;
				}
				const version = body.version ?? latestVersion(options.session).n;
				const current = options.session.versions.find(
					(candidate) => candidate.n === version,
				);
				if (
					version !== latestVersion(options.session).n ||
					closing ||
					current?.decision !== undefined
				) {
					// A second producer must not claim an outcome that will not be
					// delivered (the first decision already owns the message).
					ctx.json(
						{ error: "this revision has already been decided or is not latest" },
						409,
					);
					return true;
				}
				recordPlanDecision(options.session, version, action);
				ctx.json({ ok: true, action, version });
				ctx.broadcast("decided", { action, version });
				if (!closing) {
					closing = true;
					setTimeout(() => {
						options.onDecision?.({ action, version });
						void handle?.close();
					}, closeDelayMs).unref();
				}
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
		close: server.close,
		broadcast: server.broadcast,
	};
}
