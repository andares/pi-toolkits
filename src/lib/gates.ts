/**
 * Tool-call gate bus.
 *
 * Features that must veto or confirm tool calls (`ask`, `permission`) register
 * a {@link ToolGate} instead of installing their own `tool_call` handler. One
 * handler composes every gate, which keeps the features independent: each gate
 * speaks only about its own concern, and the call is allowed only when no gate
 * objects.
 *
 * Composition rules:
 *  - A `block` is final and short-circuits the remaining gates, so a call one
 *    feature already denies never raises another feature's dialog.
 *  - An `allow` never overrides another gate's `ask`/`block`; "no opinion" and
 *    "explicitly allowed" are both non-blocking.
 *  - `ask`s are presented through a single queue. Pi runs tool calls from one
 *    assistant message in parallel while `ctx.ui.custom` owns a single inline
 *    slot; a second presentation would mount over the first and strand its
 *    promise. The queue serializes our own presentations; the host slot is
 *    still shared with other extensions (pi does not arbitrate globally).
 *    pi 1.4.0 stacks extension dialogs so a second one no longer strands the
 *    first (#11166), but the 1.1–1.3 hosts in the supported window still
 *    replace it — the queue stays, and it also keeps one confirmation visible
 *    at a time instead of a pile of stacked dialogs on 1.4.0.
 *  - A gate that throws blocks the call (fail closed), matching pi's own
 *    `tool_call` handler contract.
 *
 * The hub is also the single audit point (`lib/approval-log.ts`): it is the
 * only place that sees the gate verdict, the prompt, the operator's answer,
 * and the final outcome in one frame. Features attach a structured `audit`
 * payload; the hub writes blocks and asks, while a gate that auto-allows an
 * operation it considers worth recording writes its own `allow` record through
 * the same log (permission's session-grant allows). Logging never changes a
 * verdict: the writer fails open and the hub swallows payload errors.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalLog, ApprovalRecord } from "./approval-log.js";
import { auditBase, auditTool, clipText, sessionIdOf } from "./approval-log.js";

/** What the operator chose in an interactive ask. */
export type AskDecision =
	| "allow"
	| "allow-session"
	| "deny"
	| "deny-session";

/**
 * One interactive confirmation a gate wants before the call may run.
 *
 * `present` renders the dialog (or falls back to a host selector) and resolves
 * `undefined` when there is no way to ask or the operator cancelled — both are
 * treated as a denial. `apply` records the decision (session grants) and runs
 * only for a real answer.
 */
export interface AskRequest {
	/** Short title, e.g. "Permission required". */
	readonly title: string;
	/** Context lines: command, target, scope, reason. */
	readonly details: readonly string[];
	/** The directory a session grant would cover. */
	readonly root: string;
	/**
	 * Structured context written with the audit record when the log is on.
	 * Built by the feature; the hub adds the tool call, answer and outcome.
	 */
	readonly audit?: ApprovalRecord;
	present(ctx: ExtensionContext): Promise<AskDecision | undefined>;
	apply(decision: AskDecision): void;
	/** Model-facing reason when the operator answers deny/deny-session. */
	denyReason(decision: AskDecision): string;
	/**
	 * Called exactly once when the ask settles — answer, cancel, or "never
	 * shown because an earlier gate blocked". Returned fields are merged into
	 * the audit record (for example the session grant an answer created).
	 * A throwing settle is ignored: auditing must not affect the verdict.
	 */
	settle?(
		decision: AskDecision | undefined,
		meta: { presented: boolean; ms: number },
	): ApprovalRecord | undefined;
}

/** A gate's opinion about one tool call. */
export type GateVerdict =
	| undefined
	| { readonly kind: "allow" }
	| {
			readonly kind: "block";
			readonly reason: string;
			/** Structured context for the audit log. */
			readonly audit?: ApprovalRecord;
	  }
	| { readonly kind: "ask"; readonly request: AskRequest };

/** One feature's tool-call policy. Lower `order` runs first. */
export interface ToolGate {
	readonly name: string;
	readonly order: number;
	evaluate(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): GateVerdict | Promise<GateVerdict>;
}

/** Result of composing the gates: a block reason, or nothing (allow). */
export type GateResult = { readonly reason: string } | undefined;

export interface GateHubOptions {
	/** Write-only audit sink; absent in tests and when logging is off. */
	readonly audit?: ApprovalLog;
}

export interface GateHub {
	register(gate: ToolGate): void;
	/** Compose every gate for one call (also the unit-test entry point). */
	handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<GateResult>;
	/** Install the single `tool_call` handler that owns the gates. */
	install(pi: ExtensionAPI): void;
}

interface PendingAsk {
	readonly gate: string;
	readonly request: AskRequest;
}

interface SessionCounters {
	session?: string;
	startedAt: number;
	calls: number;
	asks: number;
	blocks: number;
	answers: Record<string, number>;
	base?: ApprovalRecord;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emptyCounters(session?: string, base?: ApprovalRecord): SessionCounters {
	return {
		session,
		startedAt: Date.now(),
		calls: 0,
		asks: 0,
		blocks: 0,
		answers: {},
		base,
	};
}

/**
 * Outcome label plus the counter key for a settled ask. A plain nested ternary
 * chain here was unreadable and easy to get wrong, so the mapping lives in one
 * named place.
 */
function answerLabel(
	decision: AskDecision | undefined,
	presented: boolean,
	error: unknown,
): { outcome: string; key: string } {
	if (error !== undefined) return { outcome: "error", key: "error" };
	if (!presented) return { outcome: "not-presented", key: "not-presented" };
	if (decision === undefined) return { outcome: "cancelled", key: "cancelled" };
	if (decision === "allow" || decision === "allow-session") {
		return { outcome: "allowed", key: decision };
	}
	return { outcome: "blocked", key: decision };
}

export function createGateHub(options: GateHubOptions = {}): GateHub {
	const gates: ToolGate[] = [];
	let queue: Promise<void> = Promise.resolve();

	const audit = options.audit;
	const logging = audit !== undefined && audit.mode !== "off";
	/**
	 * Counters per session id. A single slot would be wrong as soon as two
	 * sessions run in one process (a child/subagent session or a parent and a
	 * replaced runtime): each call from the other session would flush the first
	 * one's partial counters and start over, producing a burst of tiny summaries
	 * with misattributed numbers. Keyed storage keeps each session's counters
	 * intact regardless of interleaving.
	 */
	const countersBySession = new Map<string, SessionCounters>();
	/** Sessions kept in memory at once; each entry is a handful of numbers. */
	const MAX_TRACKED_SESSIONS = 8;

	/**
	 * Serialize dialogs without letting one rejection poison the queue:
	 * the tail always settles, the caller still sees its own outcome.
	 */
	function runExclusive<T>(present: () => Promise<T>): Promise<T> {
		const next = queue.then(present, present);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/**
	 * One summary record per session gives the analysis a denominator without
	 * filling the ring buffer with auto-allowed read/grep calls. It is written on
	 * shutdown (quit / reload / session replacement) and when a stale session is
	 * evicted; a crash loses at most the live sessions' counters.
	 */
	function flushSession(
		key: string,
		reason: string,
		fallback?: ApprovalRecord,
	): void {
		const counters = countersBySession.get(key);
		if (!counters) return;
		countersBySession.delete(key);
		if (!logging) return;
		const base = counters.base ?? fallback;
		const hadWork =
			counters.calls > 0 || counters.asks > 0 || counters.blocks > 0;
		if (base && hadWork) {
			audit?.append({
				...base,
				ts: new Date().toISOString(),
				event: "session",
				reason,
				durationMs: Date.now() - counters.startedAt,
				counts: {
					calls: counters.calls,
					asks: counters.asks,
					blocks: counters.blocks,
					answers: counters.answers,
				},
			});
		}
	}

	/** Counters for this call's session, creating the slot on first use. */
	function countersFor(
		session: string | undefined,
		base: ApprovalRecord,
	): SessionCounters {
		const key = session ?? "";
		let counters = countersBySession.get(key);
		if (!counters) {
			counters = emptyCounters(session, base);
			countersBySession.set(key, counters);
			if (countersBySession.size > MAX_TRACKED_SESSIONS) {
				const oldest = countersBySession.keys().next().value;
				if (oldest !== undefined && oldest !== key) {
					flushSession(oldest, "evicted");
				}
			}
		} else {
			// Keep the newest envelope (cwd / model) for the summary.
			counters.base = base;
		}
		return counters;
	}

	function logBlock(
		gateName: string,
		reason: string,
		base: ApprovalRecord,
		tool: ApprovalRecord,
		payload: ApprovalRecord | undefined,
		counters: SessionCounters | undefined,
	): void {
		if (!logging) return;
		if (counters) counters.blocks++;
		audit?.append({
			...base,
			...tool,
			...(payload ?? {}),
			event: "block",
			gate: gateName,
			reason: clipText(reason, 2048),
		});
	}

	/**
	 * Settle one ask and write its record. `presented: false` means an earlier
	 * gate blocked before this dialog could run — recorded, not silently lost.
	 */
	function logAsk(
		pending: PendingAsk,
		base: ApprovalRecord,
		tool: ApprovalRecord,
		decision: AskDecision | undefined,
		presented: boolean,
		ms: number,
		counters: SessionCounters | undefined,
		queueMs?: number,
		error?: unknown,
	): void {
		if (!logging) return;
		let patch: ApprovalRecord | undefined;
		try {
			patch = pending.request.settle?.(error ? undefined : decision, {
				presented,
				ms,
			});
		} catch {
			// Auditing must never change the verdict.
		}
		const { outcome, key } = answerLabel(decision, presented, error);
		if (counters) counters.answers[key] = (counters.answers[key] ?? 0) + 1;

		const request = pending.request;
		const prompt = Array.isArray(request.audit?.prompt)
			? request.audit.prompt
			: [request.title, ...request.details];
		audit?.append({
			...base,
			...tool,
			...(request.audit ?? {}),
			...(patch ?? {}),
			event: "ask",
			gate: pending.gate,
			title: request.title,
			prompt,
			answer: decision
				? { choice: decision, ms, ...(queueMs === undefined ? {} : { queueMs }) }
				: null,
			outcome,
			...(error === undefined
				? {}
				: { error: clipText(messageOf(error), 1024) }),
		});
	}

	async function handle(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<GateResult> {
		const base = logging ? auditBase(ctx) : {};
		const counters = logging ? countersFor(sessionIdOf(ctx), base) : undefined;
		const tool = logging ? auditTool(event) : {};
		if (counters) counters.calls++;

		const pending: PendingAsk[] = [];
		for (const gate of [...gates].sort((a, b) => a.order - b.order)) {
			let verdict: GateVerdict;
			try {
				verdict = await gate.evaluate(event, ctx);
			} catch (error) {
				const reason = `Permission check failed in "${gate.name}": ${messageOf(error)}. The call was blocked.`;
				logBlock(gate.name, reason, base, tool, {
					verdict: { action: "block", layer: "gate-error" },
				}, counters);
				for (const abandoned of pending) {
					logAsk(abandoned, base, tool, undefined, false, 0, counters);
				}
				return { reason };
			}
			if (!verdict || verdict.kind === "allow") continue;
			if (verdict.kind === "block") {
				logBlock(
					gate.name,
					verdict.reason,
					base,
					tool,
					verdict.audit,
					counters,
				);
				for (const abandoned of pending) {
					logAsk(abandoned, base, tool, undefined, false, 0, counters);
				}
				return { reason: verdict.reason };
			}
			if (counters) counters.asks++;
			pending.push({ gate: gate.name, request: verdict.request });
		}

		for (const current of pending) {
			const request = current.request;
			const started = Date.now();
			let presentedAt = 0;
			let decision: AskDecision | undefined;
			let error: unknown;
			try {
				decision = await runExclusive(() => {
					presentedAt = Date.now();
					return request.present(ctx);
				});
			} catch (caught) {
				error = caught;
			}
			const ms = Date.now() - started;
			// `ms` is how long the call waited in total; `queueMs` is the part spent
			// behind another dialog in the same assistant message. Analysis needs
			// the split, otherwise a batch looks like a slow operator.
			const queueMs = presentedAt === 0 ? ms : presentedAt - started;
			logAsk(current, base, tool, decision, true, ms, counters, queueMs, error);
			if (error !== undefined) {
				return {
					reason: `Permission dialog "${request.title}" failed: ${messageOf(error)}. The call was blocked.`,
				};
			}
			if (decision === undefined) {
				return {
					reason: `Permission check "${request.title}" was not answered; the call was blocked.`,
				};
			}
			request.apply(decision);
			if (decision === "deny" || decision === "deny-session") {
				return { reason: request.denyReason(decision) };
			}
		}
		return undefined;
	}

	return {
		register(gate) {
			gates.push(gate);
		},
		handle,
		install(pi) {
			pi.on("tool_call", async (event, ctx) => {
				const result = await handle(event, ctx);
				if (!result) return;
				return { block: true, reason: result.reason };
			});
			// `session_shutdown` fires for quit / reload / session replacement;
			// the summary closes the current segment before the runtime goes away.
			pi.on("session_shutdown", (event, ctx) => {
				if (!logging) return;
				// `ctx` is the session being torn down, so this flushes exactly that
				// session's counters. Other tracked sessions stay untouched: an
				// in-process child session ending must not truncate its parent's
				// summary into two halves. Stale slots are reclaimed by eviction.
				flushSession(sessionIdOf(ctx) ?? "", event.reason, auditBase(ctx));
			});
		},
	};
}
