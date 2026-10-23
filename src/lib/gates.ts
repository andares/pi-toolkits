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
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

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
	present(ctx: ExtensionContext): Promise<AskDecision | undefined>;
	apply(decision: AskDecision): void;
	/** Model-facing reason when the operator answers deny/deny-session. */
	denyReason(decision: AskDecision): string;
}

/** A gate's opinion about one tool call. */
export type GateVerdict =
	| undefined
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly reason: string }
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

export interface GateHub {
	register(gate: ToolGate): void;
	/** Compose every gate for one call (also the unit-test entry point). */
	handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<GateResult>;
	/** Install the single `tool_call` handler that owns the gates. */
	install(pi: ExtensionAPI): void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createGateHub(): GateHub {
	const gates: ToolGate[] = [];
	let queue: Promise<void> = Promise.resolve();

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

	async function handle(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<GateResult> {
		const pending: AskRequest[] = [];
		for (const gate of [...gates].sort((a, b) => a.order - b.order)) {
			let verdict: GateVerdict;
			try {
				verdict = await gate.evaluate(event, ctx);
			} catch (error) {
				return {
					reason: `Permission check failed in "${gate.name}": ${messageOf(error)}. The call was blocked.`,
				};
			}
			if (!verdict || verdict.kind === "allow") continue;
			if (verdict.kind === "block") return { reason: verdict.reason };
			pending.push(verdict.request);
		}

		for (const request of pending) {
			const decision = await runExclusive(() => request.present(ctx));
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
		},
	};
}
