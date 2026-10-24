/**
 * permission feature — per-call decisions.
 *
 * The policy is evaluated per command unit: every touched path is canonicalized,
 * classified as inside or outside the session roots, and answered by, in order:
 *
 *  1. the fixed secrets table (deny in every mode),
 *  2. the fixed danger table (ask in every mode),
 *  3. session grants (deny wins over allow),
 *  4. the four modes.
 *
 * The strictest unit of a compound command wins (`deny > ask > allow`), so
 * `cd safe && rm -rf /` cannot ride on the first segment's verdict.
 */
import type { PermissionModes } from "./constants.js";
import { dangerReason, secretReason, type Effect } from "./constants.js";
import { canonicalize, grantRoot, insideAnyRoot } from "./paths.js";
import type { SessionRules } from "./session-rules.js";
import type { CommandUnit } from "./units.js";

export type PolicyAction = "allow" | "ask" | "deny";

/** One resolved access a decision was made about. */
export interface PolicyTarget {
	/** Canonical absolute path. */
	readonly path: string;
	readonly effect: Effect;
	readonly scope: "in" | "out";
}

export interface PolicyDecision {
	readonly action: PolicyAction;
	/** Machine-readable reason class, for the audit log and tests. */
	readonly layer: PolicyLayer;
	readonly unit: CommandUnit;
	readonly target?: PolicyTarget;
	/** Human/model-facing explanation for ask and deny. */
	readonly reason?: string;
}

/**
 * Which rule decided a unit: the four modes, one of the fixed tables, a session
 * grant, or a parser fallback. Kept separate from the human-facing reason so
 * the audit log can group decisions without parsing English.
 */
export type PolicyLayer =
	| "mode"
	| "secret"
	| "session-allow"
	| "session-deny"
	| "session-command"
	| "danger"
	| "privileged"
	| "opaque"
	| "unresolved"
	| "empty";

export interface PolicyContext {
	readonly modes: PermissionModes;
	/** Canonical session roots (working directory plus added directories). */
	readonly roots: readonly string[];
	readonly rules: SessionRules;
}

const SEVERITY: Record<PolicyAction, number> = { allow: 0, ask: 1, deny: 2 };

/** What the session grants alone say about one access. */
function decideSession(
	effect: Effect,
	pathValue: string,
	ctx: PolicyContext,
): "allow" | "deny" | undefined {
	if (ctx.rules.denies(effect, pathValue)) return "deny";
	if (ctx.rules.allows(effect, pathValue)) return "allow";
	return undefined;
}

function worse(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
	return SEVERITY[b.action] > SEVERITY[a.action] ? b : a;
}

function modeFor(
	modes: PermissionModes,
	effect: Effect,
	scope: "in" | "out",
): "ask" | "allow" | "deny" {
	if (effect === "read") return scope === "in" ? modes.inRead : modes.outRead;
	return scope === "in" ? modes.inWrite : modes.outWrite;
}

/** Scope and session-grant answer for one already-canonical path. */
function decidePath(
	unit: CommandUnit,
	pathValue: string,
	effect: Effect,
	ctx: PolicyContext,
): PolicyDecision {
	const scope = insideAnyRoot(ctx.roots, pathValue) ? "in" : "out";
	const secret = secretReason(pathValue);
	if (secret !== undefined) {
		return {
			action: "deny",
			layer: "secret",
			unit,
			target: { path: pathValue, effect, scope },
			reason: `${secret} — denied by the fixed safety table`,
		};
	}
	const target: PolicyTarget = { path: pathValue, effect, scope };
	if (ctx.rules.denies(effect, pathValue)) {
		return {
			action: "deny",
			layer: "session-deny",
			unit,
			target,
			reason: `${effect} under ${pathValue} was denied for this session`,
		};
	}
	if (ctx.rules.allows(effect, pathValue)) {
		return { action: "allow", layer: "session-allow", unit, target };
	}
	const mode = modeFor(ctx.modes, effect, scope);
	if (mode === "allow") {
		return { action: "allow", layer: "mode", unit, target };
	}
	if (mode === "deny") {
		return {
			action: "deny",
			layer: "mode",
			unit,
			target,
			reason: `${scope === "out" ? "outside-project" : "in-project"} ${effect} is set to deny`,
		};
	}
	return {
		action: "ask",
		layer: "mode",
		unit,
		target,
		reason:
			scope === "out"
				? `outside-project ${effect} requires confirmation`
				: `in-project ${effect} requires confirmation`,
	};
}

/** Decide one command unit. */
export function decideUnit(
	unit: CommandUnit,
	ctx: PolicyContext,
): PolicyDecision {
	if (unit.opaque) {
		// Session grants for an opaque program are keyed on the whole command
		// text and checked in {@link decideProgram}; a single unit has no path
		// to grant.
		return {
			action: "ask",
			layer: "opaque",
			unit,
			reason: unit.note ?? "this command could not be analysed",
		};
	}

	const resolvedTargets = unit.targets.map((target) => ({
		...target,
		path: canonicalize(target.path),
	}));
	const canonicalBase = unit.base === null ? null : canonicalize(unit.base);

	// The secrets table is absolute: it outranks both the danger table and the
	// modes, so `sudo cat ~/.ssh/id_rsa` denies instead of asking.
	const secret = resolvedTargets
		.map((target) => ({ target, reason: secretReason(target.path) }))
		.find((entry) => entry.reason !== undefined);
	if (secret?.reason !== undefined) {
		return {
			action: "deny",
			layer: "secret",
			unit,
			target: {
				path: secret.target.path,
				effect: secret.target.effect,
				scope: insideAnyRoot(ctx.roots, secret.target.path) ? "in" : "out",
			},
			reason: `${secret.reason} — denied by the fixed safety table`,
		};
	}
	if (resolvedTargets.length === 0 && canonicalBase !== null) {
		const baseSecret = secretReason(canonicalBase);
		if (baseSecret !== undefined) {
			return {
				action: "deny",
				layer: "secret",
				unit,
				target: {
					path: canonicalBase,
					effect: unit.effect,
					scope: insideAnyRoot(ctx.roots, canonicalBase) ? "in" : "out",
				},
				reason: `${baseSecret} — denied by the fixed safety table`,
			};
		}
	}

	// Session grants are the operator's explicit decision and outrank the danger
	// table: once an operation is allowed for the session, repeating it must not
	// ask again. A deny likewise turns a dangerous command into a denial instead
	// of a prompt.
	let sessionVerdict: "allow" | "deny" | undefined;
	if (resolvedTargets.length === 0) {
		sessionVerdict =
			canonicalBase === null
				? undefined
				: decideSession(unit.effect, canonicalBase, ctx);
	} else {
		const verdicts = resolvedTargets.map((target) =>
			decideSession(target.effect, target.path, ctx),
		);
		if (verdicts.includes("deny")) {
			const denied = resolvedTargets[verdicts.indexOf("deny")];
			return decidePath(unit, denied.path, denied.effect, ctx);
		}
		sessionVerdict = verdicts.every((verdict) => verdict === "allow")
			? "allow"
			: undefined;
	}
	if (sessionVerdict === "deny" && canonicalBase !== null) {
		return decidePath(unit, canonicalBase, unit.effect, ctx);
	}

	// The fixed danger table asks regardless of mode: `rm -rf .` inside the
	// project is still destructive, and scope alone cannot express that.
	const danger = dangerReason(
		unit.command,
		unit.args,
		resolvedTargets.map((target) => target.path),
		canonicalBase,
	);
	const privileged = unit.headWord === "sudo" || unit.headWord === "doas";
	if (sessionVerdict !== "allow" && (danger !== undefined || privileged)) {
		const first = resolvedTargets[0];
		let target: PolicyTarget | undefined;
		if (first !== undefined) {
			target = {
				path: first.path,
				effect: first.effect,
				scope: insideAnyRoot(ctx.roots, first.path) ? "in" : "out",
			};
		}
		return {
			action: "ask",
			layer: danger !== undefined ? "danger" : "privileged",
			unit,
			target,
			reason: danger ?? "privileged command",
		};
	}

	if (resolvedTargets.length === 0) {
		if (canonicalBase === null) {
			return {
				action: "ask",
				layer: "unresolved",
				unit,
				reason: "the working directory could not be resolved",
			};
		}
		return decidePath(unit, canonicalBase, unit.effect, ctx);
	}

	let decision = decidePath(
		unit,
		resolvedTargets[0].path,
		resolvedTargets[0].effect,
		ctx,
	);
	for (const target of resolvedTargets.slice(1)) {
		decision = worse(decision, decidePath(unit, target.path, target.effect, ctx));
	}
	return decision;
}

/** Decide a whole bash program (or the single unit of a path-bearing tool). */
/** Stable key for a session grant on an opaque program. */
export function programKey(units: readonly CommandUnit[]): string {
	return units.map((unit) => unit.raw).join(" ; ");
}

export function decideProgram(
	units: readonly CommandUnit[],
	ctx: PolicyContext,
): PolicyDecision {
	if (units.length === 0) {
		return {
			action: "allow",
			layer: "empty",
			unit: {
				raw: "",
				headWord: "",
				command: "",
				args: [],
				effect: "read",
				opaque: false,
				base: null,
				targets: [],
			},
		};
	}
	// A program the parser could not fully resolve has no path-level grant;
	// the operator's "allow this session" covers the exact command text, so a
	// repeat of the same opaque program does not ask again.
	const opaqueUnit = units.find((unit) => unit.opaque);
	if (opaqueUnit) {
		const key = programKey(units);
		if (ctx.rules.deniesCommand(key)) {
			return {
				action: "deny",
				layer: "session-command",
				unit: opaqueUnit,
				reason: "this command was denied for this session",
			};
		}
		if (ctx.rules.allowsCommand(key)) {
			return {
				action: "allow",
				layer: "session-command",
				unit: opaqueUnit,
			};
		}
	}

	let decision = decideUnit(units[0], ctx);
	for (const unit of units.slice(1)) {
		decision = worse(decision, decideUnit(unit, ctx));
	}
	return decision;
}

/** Root a session grant for this decision should cover. */
export function decisionGrantRoot(
	decision: PolicyDecision,
	getCwd: () => string,
): string {
	if (decision.target) return grantRoot(decision.target.path);
	if (decision.unit.base !== null) return grantRoot(canonicalize(decision.unit.base));
	return grantRoot(canonicalize(getCwd()));
}

/** Effect a session grant for this decision should cover. */
export function decisionEffect(decision: PolicyDecision): Effect {
	return decision.target?.effect ?? decision.unit.effect;
}

/**
 * Model-facing denial. The model receives this as the tool result, so it names
 * the offending segment, the resolved target, and the policy that denied it —
 * and tells the model not to retry an equivalent command.
 */
export function formatDenial(decision: PolicyDecision): string {
	const lines = [`Permission denied: ${decision.unit.raw || "(empty command)"}`];
	if (decision.target) {
		const scope = decision.target.scope === "out" ? "outside project" : "inside project";
		lines.push(
			`Target: ${decision.target.path} (${scope}, ${decision.target.effect})`,
		);
	}
	if (decision.reason) lines.push(`Reason: ${decision.reason}`);
	lines.push(
		decision.reason?.includes("fixed safety table") === true
			? "This is a fixed safety rule; /ask-perm cannot override it. Do not retry an equivalent command."
			: "The operator controls this with /ask-perm. Do not retry the same operation through an equivalent command.",
	);
	return lines.join("\n");
}
