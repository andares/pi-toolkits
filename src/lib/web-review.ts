/**
 * Shared web-review server — the HTTP shell used by `/ask-plan` and `/ask-uat`.
 *
 * Both features do the same thing: serve a small Vite page from inside the pi
 * process, hand it a token, and let it read/write state over HTTP + SSE. The
 * shell is what makes that safe and boring:
 *
 *   - a per-run token in the URL, echoed back as a header on API calls;
 *   - a Host allowlist and a cross-origin refusal on writes, because WSL forces
 *     `0.0.0.0` binding (see lib/opener.ts) and a loopback-only assumption would
 *     be wrong there;
 *   - a port walk so two features (or two sessions) never fight over a port;
 *   - SSR-less static file serving with real-path containment;
 *   - SSE listeners with a heartbeat, so a closed tab cannot hold the process
 *     open (listeners are removed on `close`, the server is `unref`ed).
 *
 * Feature code only supplies routes and renders its own payload; it never
 * touches sockets, tokens or MIME types.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { relative as pathRelative } from "node:path";

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

export interface WebRequestContext {
	url: URL;
	req: IncomingMessage;
	res: ServerResponse;
	port: number;
	token: string;
	json(body: unknown, status?: number): void;
	text(body: string, status?: number, type?: string): void;
	readBody(limit?: number): Promise<unknown>;
	/** Start an SSE stream on this response (handled by the shell). */
	sse(): void;
	broadcast(event: string, data: unknown): void;
	/** Set when the feature decided the server is closing (refuse new writes). */
	closing: boolean;
}

export interface WebServerOptions {
	assetsDir: string;
	/** Called for authenticated `/api/*` requests; return true when handled. */
	routes: (ctx: WebRequestContext) => boolean | Promise<boolean>;
	portStart?: number;
	portAttempts?: number;
	/** Header the page echoes the token in. Default `x-plan-token`. */
	tokenHeader?: string;
	bindHost?: string;
	urlHost?: string;
	missingUiHtml?: string;
	heartbeatMs?: number;
	onClose?: () => void;
}

export interface WebServerHandle {
	url: string;
	port: number;
	token: string;
	close(): Promise<void>;
	broadcast(event: string, data: unknown): void;
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
	});
	res.end(text);
}

export function text(
	res: ServerResponse,
	body: string,
	status = 200,
	type = "text/plain; charset=utf-8",
): void {
	res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

export async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
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
				resolveBody(raw === "" ? {} : JSON.parse(raw));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

/** Host:port pairs the page may be served under. */
export function allowedHosts(port: number, extra: string): string[] {
	return ["127.0.0.1", "localhost", "[::1]", "::1", extra]
		.filter((host) => host !== "")
		.map((host) => `${host}:${port}`);
}

function parseHost(value: string | undefined): string {
	return (value ?? "").toLowerCase();
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const token = randomBytes(12).toString("hex");
	const tokenHeader = options.tokenHeader ?? "x-plan-token";
	const portStart = options.portStart ?? 3401;
	const attempts = options.portAttempts ?? 20;
	const host = options.bindHost ?? "127.0.0.1";
	const displayHost = options.urlHost ?? "127.0.0.1";
	const assetsRoot = resolve(options.assetsDir);
	const heartbeatMs = options.heartbeatMs ?? 25_000;

	const listeners = new Set<ServerResponse>();
	let heartbeat: NodeJS.Timeout | undefined;

	const broadcast = (event: string, data: unknown): void => {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const listener of listeners) listener.write(payload);
	};

	const authenticate = (url: URL, req: IncomingMessage): boolean => {
		if (url.searchParams.get("t") === token) return true;
		return req.headers[tokenHeader] === token;
	};

	const sameOrigin = (req: IncomingMessage, port: number): boolean => {
		const site = req.headers["sec-fetch-site"];
		if (site === "same-origin" || site === "none") return true;
		const origin = req.headers.origin;
		// curl and same-process callers carry neither header. If the browser did
		// tell us this is a cross-/same-site request but omitted Origin, fail
		// closed rather than treating the missing header as proof of safety.
		if (typeof origin !== "string") return site === undefined;
		try {
			const parsed = new URL(origin);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
			// An Origin without an explicit port means the protocol's default,
			// never the port of the server receiving the request. Substituting the
			// latter would let a page on localhost:80 impersonate this review.
			const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
			return allowedHosts(port, displayHost).includes(
				parseHost(`${parsed.hostname}:${originPort}`),
			);
		} catch {
			return false;
		}
	};

	const handler = async (
		req: IncomingMessage,
		res: ServerResponse,
		port: number,
		state: { closing: boolean },
	): Promise<void> => {
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
			const indexPath = resolve(assetsRoot, "index.html");
			if (existsSync(indexPath)) {
				text(res, readFileSync(indexPath, "utf8"), 200, MIME[".html"]);
			} else {
				text(res, options.missingUiHtml ?? MISSING_UI_HTML, 200, MIME[".html"]);
			}
			return;
		}

		if (url.pathname === "/favicon.ico") {
			res.writeHead(204).end();
			return;
		}

		if (!url.pathname.startsWith("/api/")) {
			// Vite emits the bundle at the root of `outDir` (assetsDir: "."), so the
			// page asks for `/index-<hash>.js`, not `/assets/index-<hash>.js` —
			// resolving any path inside assetsDir covers both layouts.
			const requested = pathRelative(
				assetsRoot,
				resolve(assetsRoot, `.${decodeURIComponent(url.pathname)}`),
			);
			const path = resolve(assetsRoot, requested);
			const insideAssets =
				requested !== "" && !requested.startsWith("..") && !isAbsolute(requested);
			if (!insideAssets || !existsSync(path) || !statSync(path).isFile()) {
				text(res, "not found", 404);
				return;
			}
			const body = readFileSync(path);
			res.writeHead(200, {
				"Content-Type": MIME[extname(path)] ?? "application/octet-stream",
				"Content-Length": body.length,
			});
			res.end(body);
			return;
		}

		if (!authenticate(url, req)) {
			text(res, "missing or invalid token", 401);
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

		const handled = await options.routes({
			url,
			req,
			res,
			port,
			token,
			json: (body, status) => json(res, body, status),
			text: (body, status, type) => text(res, body, status, type),
			readBody: (limit) => readBody(req, limit),
			sse: () => {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-store",
					Connection: "keep-alive",
				});
				res.write(": connected\n\n");
				listeners.add(res);
				req.on("close", () => listeners.delete(res));
			},
			broadcast,
			closing: state.closing,
		});
		if (!handled) {
			text(res, "not found", 404);
			return;
		}
	};

	const state = { closing: false };
	let currentPort = 0;
	let server: ReturnType<typeof createServer> | undefined;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const port = portStart + attempt;
		const candidate = createServer((req, res) => {
			void handler(req, res, port, state).catch((error: unknown) => {
				text(res, `internal error: ${error instanceof Error ? error.message : String(error)}`, 500);
			});
		});
		const started = await new Promise<boolean>((resolveStarted) => {
			candidate.once("error", () => resolveStarted(false));
			candidate.listen(port, host, () => resolveStarted(true));
		});
		if (started) {
			server = candidate;
			currentPort = port;
			break;
		}
		candidate.close();
	}
	if (!server) {
		throw new Error(`cannot bind a review server on ports ${portStart}–${portStart + attempts - 1}`);
	}
	server.unref();
	heartbeat = setInterval(() => {
		for (const listener of listeners) listener.write(": ping\n\n");
	}, heartbeatMs);
	heartbeat.unref();

	const close = async (): Promise<void> => {
		state.closing = true;
		if (heartbeat) clearInterval(heartbeat);
		for (const listener of listeners) listener.end();
		listeners.clear();
		await new Promise<void>((resolveClosed) => server?.close(() => resolveClosed()) ?? resolveClosed());
		options.onClose?.();
	};

	return {
		url: `http://${displayHost}:${currentPort}/?t=${token}`,
		port: currentPort,
		token,
		close,
		broadcast,
	};
}

const MISSING_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pi-toolkits</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:3rem;max-width:42rem;color:#d8dee9;background:#1e222a}
code{background:#2b313c;padding:.1rem .35rem;border-radius:4px}</style></head>
<body><h1>The review UI is not built</h1>
<p>The feature's <code>assets/</code> directory is empty. Build it with <code>pnpm ui:build</code>
from the repository root, then reload this page.</p>
<p>The API works without the UI: <code>GET /api/state?t=&lt;token&gt;</code>.</p>
</body></html>`;
