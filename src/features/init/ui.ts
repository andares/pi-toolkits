/**
 * init feature — the plan preview and confirmation.
 *
 * Migration moves files, so the operator must see what will happen before it
 * happens. Three paths:
 *
 *  - **TUI**: a bounded preview panel (summary, warnings, task ids) with one
 *    keystroke answers — `y`/Enter applies, `d` writes nothing (dry run),
 *    Esc cancels.
 *  - **dialog-capable non-TUI** (RPC): the host's selector.
 *  - **no UI** (print/json): fail closed — report only, never write.
 *
 * The preview is bounded on purpose: a plan can list hundreds of tasks, and a
 * panel that scrolls off the screen is worse than a summary plus the full plan
 * written to `.agents/framework/plans/` on the next step.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, Text } from "@earendil-works/pi-tui";
import type { Plan } from "./types.js";

export type PlanDecision = "proceed" | "dry-run" | "cancel";

const MAX_PREVIEW_LINES = 16;

function previewLines(plan: Plan): string[] {
	const lines: string[] = [`/ask-init — ${plan.mode}`, ""];
	lines.push(...plan.summary);
	if (plan.warnings.length > 0) {
		lines.push("", "warnings:");
		for (const warning of plan.warnings.slice(0, 4)) lines.push(`  ! ${warning}`);
		if (plan.warnings.length > 4) lines.push(`  … ${plan.warnings.length - 4} more`);
	}
	if (plan.tasks.length > 0) {
		lines.push("", `model tasks: ${plan.tasks.map((task) => task.id).join(", ")}`);
	}
	if (lines.length > MAX_PREVIEW_LINES) {
		lines.splice(MAX_PREVIEW_LINES);
		lines.push("…");
	}
	return lines;
}

class PlanPanel implements Component {
	constructor(
		private readonly body: Text,
		private readonly footer: Text,
		private readonly done: (decision: PlanDecision) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("cancel");
			return;
		}
		if (matchesKey(data, "enter") || data === "y" || data === "Y") {
			this.done("proceed");
			return;
		}
		if (data === "d" || data === "D") {
			this.done("dry-run");
			return;
		}
	}

	render(width: number): string[] {
		return [...this.body.render(width), ...this.footer.render(width)];
	}

	invalidate(): void {
		this.body.invalidate();
		this.footer.invalidate();
	}
}

/** Ask the operator what to do with this plan. */
export async function confirmPlan(
	ctx: ExtensionContext,
	plan: Plan,
): Promise<PlanDecision> {
	if (!ctx.hasUI) return "dry-run";

	if (ctx.mode !== "tui") {
		const choice = await ctx.ui.select(
			`/ask-init ${plan.mode}: ${plan.summary[0] ?? ""}`,
			["Proceed", "Report only (no writes)", "Cancel"],
		);
		if (choice === "Proceed") return "proceed";
		if (choice === "Report only (no writes)") return "dry-run";
		return "cancel";
	}

	return ctx.ui.custom<PlanDecision>((_tui, _theme, _keybindings, done) => {
		const body = new Text(previewLines(plan).join("\n"));
		const footer = new Text(
			"[Enter/y] apply   [d] report only, write nothing   [Esc] cancel",
		);
		return new PlanPanel(body, footer, done);
	});
}

/* -------------------------------------------------------------------------- */
/* Read-only report panel                                                      */
/* -------------------------------------------------------------------------- */

const MAX_REPORT_LINES = 22;

class ReportPanel implements Component {
	constructor(
		private readonly body: Text,
		private readonly footer: Text,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "ctrl+c") ||
			data === "q"
		) {
			this.done();
		}
	}

	render(width: number): string[] {
		return [...this.body.render(width), ...this.footer.render(width)];
	}

	invalidate(): void {
		this.body.invalidate();
		this.footer.invalidate();
	}
}

/**
 * Show a report (plan or audit) without writing anything. In TUI it opens a
 * bounded panel; elsewhere the first lines go through `notify`, which is the
 * only output channel print/json modes have.
 */
export async function showReport(
	ctx: ExtensionContext,
	title: string,
	text: string,
	options: { path?: string } = {},
): Promise<void> {
	const lines = text.split("\n");
	if (!ctx.hasUI || ctx.mode !== "tui") {
		const head = lines.filter((line) => line.trim().length > 0).slice(0, 6).join("\n");
		ctx.ui.notify(`${title}\n${head}${options.path ? `\n→ ${options.path}` : ""}`, "info");
		return;
	}
	const clipped = lines.slice(0, MAX_REPORT_LINES);
	if (lines.length > MAX_REPORT_LINES) clipped.push(`… ${lines.length - MAX_REPORT_LINES} more lines`);
	if (options.path) clipped.push("", `full report: ${options.path}`);
	await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
		const body = new Text(clipped.join("\n"));
		const footer = new Text("[Enter/Esc] close");
		return new ReportPanel(body, footer, () => done(undefined));
	});
}
