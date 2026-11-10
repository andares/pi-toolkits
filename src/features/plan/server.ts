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
 * Security posture is stricter than a loopback dev server needs *because* WSL
 * forces us to bind 0.0.0.0 (see opener.ts): Host allowlist, a per-review token
 * in the URL echoed back as a header, and a cross-origin refusal on writes.
 * Nothing else on the machine should be able to read a plan or approve it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
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
import { bindHost, urlHost } from "./opener.js";

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

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
};

const MISSING_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ask-plan</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:3rem;max-width:42rem;color:#d8dee9;background:#1e222a}
code{background:#2b313c;padding:.1rem .35rem;border-radius:4px}</style></head>
<body><h1>The review UI is not built</h1>
<p><code>src/features/plan/assets/</code> is empty. Build it with <code>pnpm ui:build</code>
from the repository root, then reload this page.</p>
<p>The API works without the UI: <code>GET /api/state?t=&lt;token&gt;</code>.</p>
</body></html>`;

/** Compose what the page renders: blocks of one revision, tagged with their diff status. */
export function buildPlanState(session: PlanSession, versionNumber?: number): PlanStatePayload {
	const version = versionNumber === undefined ? latestVersion(session) : session.versions.find((candidate) => candidate.n === versionNumber);
	if (!version) throw new Error(`no plan revision ${versionNumber} in ${session.dir}`);
	const previous = session.versions.find((candidate) => candidate.n === version.n - 1);

	const byId = new Map<string, Block>(version.blocks.map((block) => [block.id, block]));
	const previousById = new Map<string, Block>((previous?.blocks ?? []).map((block) => [block.id, block]));
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
		totalVersions: session.versions.length,
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

function json(res: ServerResponse, body: unknown, status = 200): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
	});
	res.end(text);
}

function text(res: ServerResponse, body: string, status = 200, type = "text/plain; charset=utf-8"): void {
	res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				const raw = Buffer.concat(chunks).toString("utf8");
				resolve(raw === "" ? {} : JSON.parse(raw));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
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
						? group.annotations.map(toAnnotation).filter((item): item is Annotation => item !== undefined)
						: [];
					return { blockId, annotations };
				})
				.filter((group) => group.blockId !== "" && group.annotations.length > 0)
		: [];
	return { global, blocks };
}

/** Host:port pairs the review may be served under. */
function allowedHosts(port: number, extra: string): string[] {
	return ["127.0.0.1", "localhost", "[::1]", "::1", extra]
		.filter((host) => host !== "")
		.map((host) => `${host}:${port}`);
}

function parseHost(value: string | undefined): string {
	return (value ?? "").toLowerCase();
}

export async function startPlanServer(options: StartPlanServerOptions): Promise<PlanServerHandle> {
	const token = randomBytes(12).toString("hex");
	const assetsDir = options.assetsDir ?? fileURLToPath(new URL("./assets/", import.meta.url));
	const render = options.render ?? ((block: Pick<Block, "kind" | "text">) => block.text);
	const portStart = options.portStart ?? 3401;
	const attempts = options.portAttempts ?? 20;
	const closeDelayMs = options.closeDelayMs ?? 1500;
	const host = options.bindHost ?? bindHost(true);
	const displayHost = options.urlHost ?? urlHost(true);

	const listeners = new Set<ServerResponse>();
	let heartbeat: NodeJS.Timeout | undefined;
	let closing = false;

	const authenticate = (url: URL, req: IncomingMessage): boolean => {
		if (url.searchParams.get("t") === token) return true;
		const header = req.headers["x-plan-token"];
		return header === token;
	};

	const sameOrigin = (req: IncomingMessage, port: number): boolean => {
		const site = req.headers["sec-fetch-site"];
		if (site === "same-origin" || site === "none") return true;
		const origin = req.headers.origin;
		if (typeof origin !== "string") return true; // curl / same-process callers
		try {
			const parsed = new URL(origin);
			return allowedHosts(port, displayHost).includes(parseHost(`${parsed.hostname}:${parsed.port || port}`));
		} catch {
			return false;
		}
	};

	const handler = async (req: IncomingMessage, res: ServerResponse, port: number): Promise<void> => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const allowed = allowedHosts(port, displayHost);
		if (!allowed.includes(parseHost(req.headers.host))) {
			text(res, "host not allowed", 400);
			return;
		}
		const writes = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
		if (writes && !sameOrigin(req, port)) {
			text(res, "cross-origin write refused", 403);
			return;
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			if (!authenticate(url, req)) {
				text(res, "missing or invalid token", 401);
				return;
			}
			const indexPath = join(assetsDir, "index.html");
			text(res, existsSync(indexPath) ? readFileSync(indexPath, "utf8") : MISSING_UI_HTML, 200, MIME[".html"]);
			return;
		}

		if (url.pathname === "/favicon.ico") {
			res.writeHead(204).end();
			return;
		}

		if (!url.pathname.startsWith("/api/")) {
			// Everything else is a static file from the build output. Vite emits
			// the bundle at the root of `outDir` (assetsDir: "."), so the page asks
			// for `/index-<hash>.js`, not `/assets/index-<hash>.js` — resolving any
			// path inside assetsDir covers both layouts without a second route.
			const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
			const path = join(assetsDir, relative);
			const insideAssets = path.startsWith(assetsDir);
			if (relative === "" || !insideAssets || !existsSync(path) || !statSync(path).isFile()) {
				text(res, "not found", 404);
				return;
			}
			text(res, readFileSync(path, "utf8"), 200, MIME[extname(path)] ?? "application/octet-stream");
			return;
		}
		if (!authenticate(url, req) && req.headers["x-plan-token"] !== token) {
			text(res, "missing or invalid token", 401);
			return;
		}

		if (url.pathname === "/api/state" && req.method === "GET") {
			const versionParam = url.searchParams.get("version");
			const state = buildPlanState(
				options.session,
				versionParam ? Number(versionParam) : undefined,
			);
			const version = options.session.versions.find((candidate) => candidate.n === state.version);
			const htmlById = new Map<string, string>();
			for (const block of version?.blocks ?? []) htmlById.set(block.id, render(block));
			const previous = options.session.versions.find((candidate) => candidate.n === state.version - 1);
			for (const block of previous?.blocks ?? []) {
				if (!htmlById.has(block.id)) htmlById.set(block.id, render(block));
			}
			json(res, {
				...state,
				items: state.items.map((item) => ({ ...item, html: htmlById.get(item.id) ?? "" })),
			});
			return;
		}

		if (url.pathname === "/api/events" && req.method === "GET") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			listeners.add(res);
			req.on("close", () => listeners.delete(res));
			return;
		}

		if (url.pathname === "/api/annotate" && req.method === "POST") {
			const body = (await readBody(req)) as { version?: number; annotations?: unknown };
			const annotations = normalizeAnnotations(body.annotations);
			const version = body.version ?? latestVersion(options.session).n;
			setPlanAnnotations(options.session, version, annotations);
			options.onAnnotations?.(annotations, version);
			broadcast("annotations", { version, annotations });
			json(res, { ok: true, version });
			return;
		}

		if (url.pathname === "/api/decide" && req.method === "POST") {
			const body = (await readBody(req)) as { action?: unknown; version?: number };
			const action = body.action === "approve" || body.action === "deny" ? body.action : undefined;
			if (!action) {
				json(res, { error: "action must be approve or deny" }, 400);
				return;
			}
			const version = body.version ?? latestVersion(options.session).n;
			recordPlanDecision(options.session, version, action);
			json(res, { ok: true, action, version });
			broadcast("decided", { action, version });
			if (!closing) {
				closing = true;
				setTimeout(() => {
					options.onDecision?.({ action, version });
					void close();
				}, closeDelayMs).unref();
			}
			return;
		}

		text(res, "not found", 404);
	};

	function broadcast(event: string, data: unknown): void {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const listener of listeners) listener.write(payload);
	}

	let currentPort = 0;
	let server: ReturnType<typeof createServer> | undefined;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const port = portStart + attempt;
		const candidate = createServer((req, res) => {
			void handler(req, res, port).catch((error: unknown) => {
				text(res, `internal error: ${error instanceof Error ? error.message : String(error)}`, 500);
			});
		});
		const started = await new Promise<boolean>((resolve) => {
			candidate.once("error", () => resolve(false));
			candidate.listen(port, host, () => resolve(true));
		});
		if (started) {
			server = candidate;
			currentPort = port;
			break;
		}
		candidate.close();
	}
	if (!server) {
		throw new Error(`cannot bind a plan server on ports ${portStart}–${portStart + attempts - 1}`);
	}
	server.unref();
	heartbeat = setInterval(() => {
		for (const listener of listeners) listener.write(": ping\n\n");
	}, 25_000);
	heartbeat.unref();

	const close = async (): Promise<void> => {
		if (heartbeat) clearInterval(heartbeat);
		for (const listener of listeners) listener.end();
		listeners.clear();
		await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
	};

	return {
		url: `http://${displayHost}:${currentPort}/?t=${token}`,
		port: currentPort,
		token,
		close,
		broadcast,
	};
}
