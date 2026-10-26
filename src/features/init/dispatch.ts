/**
 * init feature — work order handed to the model after the deterministic half.
 *
 * The work order is deliberately small: the tasks, their acceptance criteria and
 * the invariants that keep a migration from losing content. Project detail is
 * *not* inlined here — the model reads the project. This keeps the prompt cheap
 * and keeps the contract in `memory/README.md` (one home, one fact).
 */
import type { ApplyResult, Plan } from "./types.js";

export interface WorkOrderInput {
	readonly plan: Plan;
	readonly applied?: ApplyResult;
	/** Absolute path to the plan JSON the model should read. */
	readonly planPath?: string;
}

const MODE_LABEL: Record<Plan["mode"], string> = {
	fresh: "fresh install",
	adopt: "adoption (existing project)",
	reconcile: "reconcile (layout drift)",
	upgrade: "framework upgrade",
	"audit-only": "audit only",
	unsupported: "refused",
};

export function buildWorkOrder(input: WorkOrderInput): string {
	const { plan, applied } = input;
	const language = plan.language === "zh" ? "Chinese" : "English";

	const done: string[] = [];
	if (applied) {
		for (const move of applied.moved) {
			done.push(`moved ${move.from}/ → ${move.to}/ (${move.files} files)`);
		}
		if (applied.rewrites) {
			done.push(
				`rewrote ${applied.rewrites.hits} path references in ${applied.rewrites.files} files (report: ${applied.rewrites.report})`,
			);
		}
		if (applied.created.length > 0) {
			done.push(`created ${applied.created.length} files (${applied.created.join(", ")})`);
		}
		if (applied.snapshot) {
			done.push(`snapshotted ${applied.snapshot.files} files to ${applied.snapshot.dir}`);
		}
		for (const skipped of applied.skipped) {
			done.push(`skipped ${skipped.path} (${skipped.reason})`);
		}
	}

	const tasks = plan.tasks
		.map((task, index) => {
			const targets = task.targets && task.targets.length > 0 ? ` [${task.targets.join(", ")}]` : "";
			return [
				`### ${index + 1}. ${task.id}${targets}`,
				task.detail,
				"Acceptance:",
				...task.acceptance.map((item) => `- ${item}`),
			].join("\n");
		})
		.join("\n\n");

	const lines = [
		`AGENT FRAMEWORK v${plan.frameworkVersion} — ${MODE_LABEL[plan.mode]}`,
		"",
		`Repository: ${plan.root}`,
		`Prose language for anything you write: ${language}.`,
		`Plan (machine-readable): ${input.planPath ?? plan.artifacts.plan ?? "(see the plan task)"}`,
		"",
		"The deterministic half has already run. Do not repeat it, and do not move, rename or scaffold directories yourself unless a task says so.",
		...(done.length > 0 ? ["Already done:", ...done.map((line) => `- ${line}`)] : []),
		"",
		"Read first, in this order:",
		`1. .agents/memory/README.md — the contract (roles, write rules, budgets, compaction).`,
		`2. ${input.planPath ?? plan.artifacts.plan ?? "the plan"}`,
		"3. AGENTS.md and the memory files it indexes (they exist now; read before editing).",
		"",
		"Rules that decide whether this run is acceptable:",
		"- Evidence only. Every command, version and number comes from a file or a command you ran.",
		"  Write `TBD` for what the repository does not say. Never present an inference as a fact.",
		"- One fact, one home. When you move a fact, leave a pointer at the old place — do not",
		"  keep two copies.",
		"- Conservative pass: fix mechanical drift, install the index and the contract, produce the",
		"  coverage table. Do not rewrite prose that is not part of a task; budget overruns are",
		"  recorded as debt in specs/PLAN.md, not paid in this pass.",
		"- Change records are immutable except for path strings, and every such edit is listed in",
		"  the rewrite report.",
		"- Never delete a source file or section before its coverage row says where the content went.",
		"- Anything outside the repository (added roots) is written with normal tools and is",
		"  therefore subject to the permission gate; keep such writes to the scope cards.",
		"- If a task cannot be completed, say so in the report and record it in specs/PLAN.md;",
		"  never leave a silent gap.",
		"",
		"Tasks, in order:",
		"",
		tasks.length > 0 ? tasks : "_No model tasks for this run._",
		"",
		"Finish:",
		`1. Run the \`framework_audit\` tool. Fix every \`E-*\` finding and every \`OPEN\` coverage row.`,
		"   Warnings you intentionally defer go into specs/PLAN.md with a one-line reason.",
		"2. Report in at most 10 lines: what changed, what is deferred, what needs the operator.",
	];
	return lines.join("\n");
}

/** Machine-readable companion to the prompt (written next to plans/reports). */
export function serializeWorkOrder(plan: Plan, applied?: ApplyResult): string {
	return `${JSON.stringify(
		{
			framework: "agent-framework",
			version: plan.frameworkVersion,
			mode: plan.mode,
			root: plan.root,
			language: plan.language,
			createdAt: plan.createdAt,
			tool: plan.toolVersion,
			artifacts: plan.artifacts,
			applied: applied
				? {
						moved: applied.moved,
						rewrites: applied.rewrites,
						created: applied.created,
						skipped: applied.skipped,
						snapshot: applied.snapshot,
					}
				: undefined,
			tasks: plan.tasks,
			summary: plan.summary,
			warnings: plan.warnings,
		},
		null,
		2,
	)}\n`;
}
