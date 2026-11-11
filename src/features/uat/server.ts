/**
 * UAT server — the acceptance page, served from inside the pi process.
 *
 * Routes (all behind the shared token/Host/Origin shell):
 *   GET  /api/state    → derived acceptance state (items, pending records, counts)
 *   POST /api/toggle   → {item, checked}: append a check/uncheck event
 *   GET  /api/report   → raw text of one change record (evidence in a drawer)
 *   GET  /api/events   → SSE; any change (from this process or another) arrives
 *                        as a `state` event
 *
 * There is no submit endpoint on purpose: a checkbox writes its event
 * immediately, so closing the page cannot lose a decision. The watcher exists
 * because the ledger is a file: another pi session may append to it while this
 * page is open, and the page must converge without a reload.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UAT_WATCH_MS } from "./constants.js";
import {
	appendEvent,
	ledgerPath,
	newEventId,
	type UatState,
} from "./ledger.js";
import { readRecordText } from "./records.js";
import { loadSnapshot } from "./state.js";
import { bindHost, isWsl, urlHost } from "../../lib/opener.js";
import { startWebServer, type WebServerHandle } from "../../lib/web-review.js";

export interface UatPayload extends UatState {
	root: string;
	/** Malformed ledger lines (a corrupt stream must not look like an empty one). */
	skipped: number;
	/** Minimal record index for the evidence drawer. */
	records: Array<{ id: string; title: string; at?: string }>;
}

export function buildUatPayload(root: string): UatPayload {
	const snapshot = loadSnapshot(root);
	return {
		...snapshot.state,
		root,
		skipped: snapshot.skipped,
		records: snapshot.records.map((record) => ({
			id: record.id,
			title: record.title,
			at: record.at,
		})),
	};
}

export interface StartUatServerOptions {
	root: string;
	assetsDir?: string;
	portStart?: number;
	portAttempts?: number;
	bindHost?: string;
	urlHost?: string;
	/** Clock injection (tests). */
	now?: () => Date;
	/** Called on every request, for the idle timeout. */
	onActivity?: () => void;
	watchMs?: number;
}

export interface UatServerHandle {
	url: string;
	port: number;
	token: string;
	close: () => Promise<void>;
	broadcast: (event: string, data: unknown) => void;
}

export async function startUatServer(options: StartUatServerOptions): Promise<UatServerHandle> {
	const assetsDir = options.assetsDir ?? fileURLToPath(new URL("./assets/", import.meta.url));
	const now = options.now ?? (() => new Date());
	const watchMs = options.watchMs ?? UAT_WATCH_MS;
	const touch = options.onActivity ?? (() => {});

	const signature = (): string => {
		const parts: string[] = [];
		try {
			const stat = statSync(ledgerPath(options.root));
			parts.push(`l:${stat.size}:${stat.mtimeMs}`);
		} catch {
			parts.push("l:none");
		}
		try {
			const stat = statSync(join(options.root, ".agents/implementations"));
			parts.push(`r:${stat.mtimeMs}`);
		} catch {
			parts.push("r:none");
		}
		return parts.join("|");
	};

	let handle: WebServerHandle | undefined;
	let lastSignature = signature();

	const server = await startWebServer({
		assetsDir,
		portStart: options.portStart,
		portAttempts: options.portAttempts,
		bindHost: options.bindHost ?? bindHost(isWsl()),
		urlHost: options.urlHost ?? urlHost(isWsl()),
		routes: async (ctx) => {
			touch();
			if (ctx.url.pathname === "/api/state" && ctx.req.method === "GET") {
				ctx.json(buildUatPayload(options.root));
				return true;
			}

			if (ctx.url.pathname === "/api/toggle" && ctx.req.method === "POST") {
				const body = (await ctx.readBody()) as { item?: unknown; checked?: unknown };
				const item = typeof body.item === "string" ? body.item : "";
				if (typeof body.checked !== "boolean") {
					ctx.json({ error: "checked must be a boolean" }, 400);
					return true;
				}
				const checked = body.checked;
				const snapshot = loadSnapshot(options.root);
				const known = snapshot.state.items.some((entry) => entry.id === item);
				if (!known) {
					ctx.json({ error: "unknown item" }, 404);
					return true;
				}
				const at = now();
				appendEvent(ledgerPath(options.root), {
					v: 1,
					id: newEventId(at),
					ts: at.toISOString(),
					type: checked ? "check" : "uncheck",
					item,
				});
				const payload = buildUatPayload(options.root);
				lastSignature = signature();
				ctx.broadcast("state", { reason: "toggle" });
				ctx.json({ ok: true, state: payload });
				return true;
			}

			if (ctx.url.pathname === "/api/report" && ctx.req.method === "GET") {
				const id = ctx.url.searchParams.get("id") ?? "";
				const text = readRecordText(options.root, id);
				if (text === undefined) {
					ctx.json({ error: "unknown record" }, 404);
					return true;
				}
				ctx.json({ id, text });
				return true;
			}

			return false;
		},
	});
	handle = server;

	// Another process may append to the ledger (or add a record) while the page
	// is open; converge without asking the operator to reload.
	const watcher = setInterval(() => {
		const next = signature();
		if (next === lastSignature) return;
		lastSignature = next;
		handle?.broadcast("state", { reason: "external" });
	}, watchMs);
	watcher.unref();

	const close = async (): Promise<void> => {
		clearInterval(watcher);
		await handle?.close();
	};

	return {
		url: server.url,
		port: server.port,
		token: server.token,
		close,
		broadcast: server.broadcast,
	};
}
