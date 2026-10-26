/**
 * init feature — the `framework_audit` tool.
 *
 * Registered inactive and activated for the duration of an init run, so the
 * model can close its own loop: edit → audit → fix the `E-*` findings and the
 * open coverage rows before reporting. Outside such a run it stays out of the
 * tool list; the human entry point is `/ask-init check`.
 *
 * Read-only: it never writes, so it is safe to call at any point.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detect } from "./detect.js";
import { audit, countFindings, renderFindings } from "./audit.js";
import { FRAMEWORK_VERSION } from "./spec.js";

export const FRAMEWORK_AUDIT_TOOL = "framework_audit";

const PARAMS = Type.Object({});

const DESCRIPTION = `Audit this repository's agent-memory framework (read-only).

Checks the layout under .agents/ and specs/, budgets, duplicated section headings,
appendix ordering, bare path references, plan/spec drift, stale zero-byte files and
the migration coverage table. Findings carry stable codes: E-* must be fixed, W-* are
warnings that should either be fixed or recorded in specs/PLAN.md, I-* are informational.

Use it after writing or moving memory files, and before reporting an init/migration
run as complete.`;

const GUIDELINES = [
	"After any init or migration edit, run `framework_audit` and fix every E-* finding and every OPEN coverage row before reporting completion.",
];

export function registerAuditTool(pi: ExtensionAPI): void {
	pi.registerTool<typeof PARAMS, { errors: number; warnings: number; infos: number }>({
		name: FRAMEWORK_AUDIT_TOOL,
		label: "Framework audit",
		description: DESCRIPTION,
		promptSnippet: "Audit the agent-memory framework layout (read-only)",
		promptGuidelines: GUIDELINES,
		parameters: PARAMS,
		defaultActive: false,
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const facts = detect(ctx.cwd);
				const findings = audit(facts);
				const counts = countFindings(findings);
				return {
					content: [
						{
							type: "text" as const,
							text: renderFindings(findings, {
								root: ctx.cwd,
								frameworkVersion: FRAMEWORK_VERSION,
							}),
						},
					],
					details: counts,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `framework_audit: ${message}` }],
					details: { errors: 1, warnings: 0, infos: 0 },
					isError: true,
				};
			}
		},
	});
}
