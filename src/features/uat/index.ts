/**
 * ask-uat — the acceptance phase.
 *
 * `/ask-uat` opens a page that answers one question: *"what did I ship that I
 * have not verified yet?"* The flow is deliberately shallow:
 *
 *   pending change records ──cluster──▶ acceptance items ──check──▶ accepted
 *
 *   - the page opens first, then the clustering work order is dispatched, so
 *     items stream into the page while the agent works;
 *   - `uat_item` is the only writer of item identity, and it is active only in
 *     this phase; `record_change` is active in framework projects outside the
 *     read-only consult and planning phases;
 *   - nothing here edits code, and there is no submit: a checkbox appends one
 *     event to `.agents/uat/ledger.jsonl` and that is the whole decision.
 *
 * The phase ends on `/ask-uat off`, on a session switch, or after the configured
 * idle timeout.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAskControl } from "../../lib/ask-control.js";
import { PLAN_PHASE_TOOL } from "../../lib/phases.js";
import { openInBrowser } from "../../lib/opener.js";
import {
	MAX_CANDIDATES_PER_RUN,
	MAX_ITEMS_PER_RUN,
	RECORD_CHANGE_TOOL,
	UAT_COMMAND,
	UAT_IDLE_CLOSE_MS,
	UAT_ITEM_TOOL,
} from "./constants.js";
import { registerUatItemTool } from "./item-tool.js";
import { deriveState, ledgerPath, readEvents, appendEvent, newEventId } from "./ledger.js";
import { listRecords } from "./records.js";
import { buildUatKickoff, describeCounts, UAT_MODE_BANNER } from "./prompt.js";
import { registerRecordTool } from "./record-tool.js";
import { startUatServer, type UatServerHandle } from "./server.js";
import { frameworkInstalled, frameworkMissing, loadSnapshot, resolveProjectRoot } from "./state.js";

export interface UatOptions {
	/** Opening the browser is injectable so tests never spawn one. */
	openBrowser?: (url: string) => unknown;
	portStart?: number;
	portAttempts?: number;
	idleCloseMs?: number;
	now?: () => Date;
	root?: (cwd: string) => string;
	maxCandidates?: number;
	maxItems?: number;
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return `pid-${process.pid}`;
	}
}

export function registerUat(pi: ExtensionAPI, options: UatOptions = {}): void {
	const open = options.openBrowser ?? openInBrowser;
	const now = options.now ?? (() => new Date());
	const rootOf = options.root ?? resolveProjectRoot;
	const idleCloseMs = options.idleCloseMs ?? UAT_IDLE_CLOSE_MS;
	const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES_PER_RUN;
	const maxItems = options.maxItems ?? MAX_ITEMS_PER_RUN;

	let active = false;
	let server: UatServerHandle | undefined;
	let batch: string | undefined;
	let root: string | undefined;
	let ctxRef: ExtensionContext | undefined;
	let uatSessionId: string | undefined;
	let lastActivity = Date.now();
	let idleTimer: NodeJS.Timeout | undefined;

	// `plan_submit` is the owning feature's phase marker. Detecting the active
	// tool avoids a second global control registry while still keeping the two
	// phases' write surfaces disjoint.
	const planningTool = PLAN_PHASE_TOOL;

	function recordChangeAllowed(tools: readonly string[] = pi.getActiveTools()): boolean {
		return !getAskControl()?.isActive() && !tools.includes(planningTool);
	}

	function syncRecordTool(installed: boolean): void {
		const current = pi.getActiveTools();
		const present = current.includes(RECORD_CHANGE_TOOL);
		const wanted = installed && recordChangeAllowed(current);
		if (present === wanted) return;
		pi.setActiveTools(
			wanted
				? [...current, RECORD_CHANGE_TOOL]
				: current.filter((name) => name !== RECORD_CHANGE_TOOL),
		);
	}

	registerRecordTool(pi, { now, root: rootOf, canRecord: () => recordChangeAllowed() });
	registerUatItemTool(pi, {
		isActive: () => active,
		currentBatch: () => batch,
		now,
		root: rootOf,
	});

	function toolsWith(names: readonly string[], remove: readonly string[] = []): string[] {
		const current = pi.getActiveTools().filter((name) => !remove.includes(name));
		for (const name of names) if (!current.includes(name)) current.push(name);
		return current;
	}

	function closeServer(): void {
		if (!server) return;
		const handle = server;
		server = undefined;
		void handle.close();
	}

	function clearIdle(): void {
		if (idleTimer) clearInterval(idleTimer);
		idleTimer = undefined;
	}

	function touch(): void {
		lastActivity = Date.now();
	}

	function leave(ctx: ExtensionContext, reason: string): void {
		if (!active && !server) return;
		active = false;
		batch = undefined;
		clearIdle();
		closeServer();
		pi.setActiveTools(toolsWith([], [UAT_ITEM_TOOL]));
		ctx.ui.notify(`ask-uat: ${reason}`, "info");
	}

	function startIdleTimer(): void {
		clearIdle();
		if (idleCloseMs <= 0) return;
		idleTimer = setInterval(() => {
			if (!active || !server) return;
			if (Date.now() - lastActivity < idleCloseMs) return;
			const ctx = ctxRef;
			if (ctx) leave(ctx, "page closed after inactivity.");
		}, Math.min(60_000, Math.max(1_000, Math.floor(idleCloseMs / 4))));
		idleTimer.unref();
	}

	/** One `batch` event per clustering run (only when there is something to cluster). */
	function openBatch(candidates: number): string | undefined {
		if (candidates === 0) return undefined;
		const at = now();
		const eventId = newEventId(at);
		const id = `B-${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, "0")}${String(
			at.getDate(),
		).padStart(2, "0")}-${String(at.getHours()).padStart(2, "0")}${String(
			at.getMinutes(),
		).padStart(2, "0")}-${eventId.slice(-6)}`;
		appendEvent(ledgerPath(root ?? process.cwd()), {
			v: 1,
			id: eventId,
			ts: at.toISOString(),
			type: "batch",
			batch: id,
			candidates,
		});
		return id;
	}

	/** Dispatch one clustering turn; the open page streams the resulting items. */
	function dispatchClustering(): void {
		if (!root) return;
		const state = loadSnapshot(root).state;
		if (state.pending.length === 0) return;
		batch = openBatch(state.pending.length);
		const fresh = loadSnapshot(root).state;
		pi.sendUserMessage(
			buildUatKickoff({
				pending: fresh.pending,
				openItems: fresh.open,
				maxCandidates,
				maxItems,
			}),
		);
	}

	async function start(ctx: ExtensionContext): Promise<void> {
		const projectRoot = rootOf(ctx.cwd || process.cwd());
		if (!frameworkInstalled(projectRoot)) {
			const missing = frameworkMissing(projectRoot);
			ctx.ui.notify(
				`ask-uat: the agent framework is incomplete (missing: ${missing.join(", ")}) — run /ask-init first.`,
				"error",
			);
			return;
		}
		root = projectRoot;
		ctxRef = ctx;

		if (pi.getActiveTools().includes(planningTool)) {
			ctx.ui.notify("ask-uat: finish or approve the plan before acceptance.", "warning");
			return;
		}

		if (active && server) {
			open(server.url);
			const state = loadSnapshot(projectRoot).state;
			ctx.ui.notify(`ask-uat: page reopened — ${describeCounts(state)}.`, "info");
			// A second /ask-uat is the explicit "cluster what arrived since then"
			// action; merely reopening must not leave new records stuck forever.
			if (state.pending.length > 0 && ctx.isIdle()) dispatchClustering();
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify("ask-uat: the agent is still running — finish or abort first.", "warning");
			return;
		}

		// UAT legitimately writes ledger events, so it cannot run inside the
		// read-only consult phase. Match /ask-plan: the explicit phase command
		// exits consult mode through its owner, preserving its tool snapshot.
		const ask = getAskControl();
		if (ask?.isActive()) ask.exit(ctx);

		const snapshot = loadSnapshot(projectRoot);
		server = await startUatServer({
			root: projectRoot,
			portStart: options.portStart,
			portAttempts: options.portAttempts,
			now,
			onActivity: touch,
		});
		active = true;
		touch();
		startIdleTimer();
		// The framework is installed here, so both tools belong in the request:
		// clustering writes items, and the same turn may need to record a change.
		pi.setActiveTools(toolsWith(["record_change", UAT_ITEM_TOOL]));
		open(server.url);

		const pending = snapshot.state.pending;
		const state = snapshot.state;
		ctx.ui.notify(
			`ask-uat: ${server.url} — ${describeCounts(state)}.`,
			"info",
		);
		if (snapshot.skipped > 0) {
			ctx.ui.notify(
				`ask-uat: ${snapshot.skipped} malformed ledger line(s) were skipped — check .agents/uat/ledger.jsonl.`,
				"warning",
			);
		}

		if (pending.length === 0) return;
		dispatchClustering();
	}

	pi.registerCommand(UAT_COMMAND, {
		description:
			"Acceptance: cluster unaccepted change records into user-facing items, then open the page. `open` reopens it, `off` closes it.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim();
			ctxRef = ctx;
			if (arg === "off") {
				if (!active && !server) {
					ctx.ui.notify("ask-uat: not open.", "info");
					return;
				}
				leave(ctx, "closed.");
				return;
			}
			if (arg === "open") {
				if (!server) {
					ctx.ui.notify("ask-uat: no page is open — run /ask-uat first.", "warning");
					return;
				}
				open(server.url);
				ctx.ui.notify(`ask-uat: ${server.url}`, "info");
				return;
			}
			if (arg !== "") {
				ctx.ui.notify("ask-uat: usage — /ask-uat | /ask-uat open | /ask-uat off", "warning");
				return;
			}
			await start(ctx);
		},
	});

	// Re-assert the tool surface every turn: the host rebuilds the loadout at the
	// start of a run, so a `setActiveTools` done in `session_start` alone loses.
	pi.on("before_agent_start", (event, ctx) => {
		const projectRoot = root ?? rootOf(ctx.cwd || process.cwd());
		syncRecordTool(frameworkInstalled(projectRoot));
		if (active) {
			const current = pi.getActiveTools();
			if (!current.includes(UAT_ITEM_TOOL)) pi.setActiveTools([...current, UAT_ITEM_TOOL]);
		}
		if (!active) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${UAT_MODE_BANNER}` };
	});

	pi.on("session_start", (_event, ctx) => {
		const next = sessionIdOf(ctx);
		ctxRef = ctx;
		if (next === uatSessionId) return;
		// A different session must not inherit the previous page or phase.
		uatSessionId = next;
		active = false;
		batch = undefined;
		clearIdle();
		closeServer();
		// Session state never leaks: remove the phase tool unconditionally, then
		// recompute the record tool from the new project's framework and phase.
		pi.setActiveTools(toolsWith([], [UAT_ITEM_TOOL]));
		root = rootOf(ctx.cwd || process.cwd());
		syncRecordTool(frameworkInstalled(root));
	});

	pi.on("session_shutdown", () => {
		clearIdle();
		closeServer();
		active = false;
	});
}

/** Exported for tests: what the page would show right now, without a server. */
export function uatSummary(root: string): ReturnType<typeof deriveState> {
	const records = listRecords(root);
	return deriveState(records, readEvents(ledgerPath(root)).events);
}
