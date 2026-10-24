/**
 * permission feature — the audit payload.
 *
 * The gate bus owns the record envelope (session, tool call, answer, outcome);
 * this module contributes the part only the permission layer knows: the four
 * modes and session roots in force, the bash decomposition, and which rule
 * produced the verdict.
 *
 * The payload is deliberately lossless for *policy analysis* — every unit and
 * every target survives, including the parser's `opaque` note — while being
 * bounded: units, targets, args and long strings are capped, and the final
 * serializer drops detail with a visible `truncated` marker rather than
 * silently cutting a field. File contents never enter this payload.
 */
import { createHash } from "node:crypto";
import type { ApprovalRecord } from "../../lib/approval-log.js";
import { clipText } from "../../lib/approval-log.js";
import type { PermissionModes } from "./constants.js";
import { canonicalize, insideAnyRoot } from "./paths.js";
import {
	decisionGrantRoot,
	type PolicyDecision,
} from "./policy.js";
import type { CommandUnit } from "./units.js";

const MAX_UNITS = 32;
const MAX_TARGETS = 32;
const MAX_ARGS = 64;
const ARG_CHARS = 512;
const RAW_CHARS = 8192;
const PATH_CHARS = 1024;
const NOTE_CHARS = 512;
const REASON_CHARS = 2048;

export interface PermissionAuditInput {
	readonly cwd: string;
	readonly modes: PermissionModes;
	/** Canonical session roots (working directory plus added directories). */
	readonly roots: readonly string[];
	readonly units: readonly CommandUnit[];
	/** Verdict for each unit, in the same order as {@link units}. */
	readonly unitDecisions: readonly PolicyDecision[];
	/** Aggregate verdict (the strictest unit wins). */
	readonly decision: PolicyDecision;
	/** Exact dialog lines, when this payload belongs to an ask. */
	readonly prompt?: readonly string[];
}

/** Short digest of the command text, for grouping opaque grants. */
export function commandDigest(units: readonly CommandUnit[]): string {
	return createHash("sha256")
		.update(units.map((unit) => unit.raw).join(" ; "))
		.digest("hex")
		.slice(0, 16);
}

function serializeUnit(
	unit: CommandUnit,
	decision: PolicyDecision | undefined,
	roots: readonly string[],
): ApprovalRecord {
	const targets = unit.targets.slice(0, MAX_TARGETS).map((target) => {
		const canonical = canonicalize(target.path);
		return {
			path: clipText(target.path, PATH_CHARS),
			canonical: clipText(canonical, PATH_CHARS),
			effect: target.effect,
			source: target.source,
			scope: insideAnyRoot(roots, canonical) ? "in" : "out",
		};
	});
	return {
		raw: clipText(unit.raw, RAW_CHARS),
		head: unit.headWord,
		command: unit.command,
		args: unit.args.slice(0, MAX_ARGS).map((arg) => clipText(arg, ARG_CHARS)),
		base: unit.base === null ? null : clipText(canonicalize(unit.base), PATH_CHARS),
		effect: unit.effect,
		opaque: unit.opaque,
		...(unit.note === undefined ? {} : { note: clipText(unit.note, NOTE_CHARS) }),
		...(decision === undefined
			? {}
			: { action: decision.action, layer: decision.layer }),
		targets,
	};
}

function serializeVerdict(
	input: PermissionAuditInput,
): ApprovalRecord {
	const decision = input.decision;
	const unitIndex = input.units.indexOf(decision.unit);
	const target = decision.target;
	const grantScope = decision.unit.opaque ? "command" : "root";
	return {
		action: decision.action,
		layer: decision.layer,
		...(unitIndex < 0 ? {} : { unit: unitIndex }),
		...(target === undefined
			? {}
			: {
					target: clipText(target.path, PATH_CHARS),
					effect: target.effect,
					scope: target.scope,
				}),
		grantScope,
		...(grantScope === "root"
			? {
					grantRoot: clipText(
						decisionGrantRoot(decision, () => input.cwd),
						PATH_CHARS,
					),
				}
			: { grantDigest: commandDigest(input.units) }),
		...(decision.reason === undefined
			? {}
			: { reason: clipText(decision.reason, REASON_CHARS) }),
	};
}

/** Structured audit fields for one permission decision. */
export function buildPermissionAudit(
	input: PermissionAuditInput,
): ApprovalRecord {
	const unitDecisions = input.unitDecisions;
	return {
		modes: {
			inRead: input.modes.inRead,
			inWrite: input.modes.inWrite,
			outRead: input.modes.outRead,
			outWrite: input.modes.outWrite,
		},
		roots: input.roots
			.slice(0, 16)
			.map((root) => clipText(root, PATH_CHARS)),
		units: input.units
			.slice(0, MAX_UNITS)
			.map((unit, index) => serializeUnit(unit, unitDecisions[index], input.roots)),
		...(input.units.length > MAX_UNITS
			? { unitsOmitted: input.units.length - MAX_UNITS }
			: {}),
		verdict: serializeVerdict(input),
		...(input.prompt === undefined ? {} : { prompt: [...input.prompt] }),
	};
}
