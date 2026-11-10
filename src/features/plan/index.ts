/**
 * ask-plan — plan mode with a browser review round.
 *
 * The flow: `/ask-plan` opens a planning phase (read tools, questions, markdown
 * writes only), the agent writes a spec and calls `plan_submit`, the review
 * server opens the page in the operator's browser, annotations come back as a
 * message, and the loop repeats until the plan is approved — then the phase ends
 * and the agent implements.
 *
 * Three properties are load-bearing:
 *   - `plan_submit` returns immediately. Waiting for the decision inside the
 *     tool would pin the agent for as long as the operator takes to read; the
 *     decision arrives later as a normal user message instead.
 *   - the decision always carries the annotations. Approve and deny only choose
 *     the next step (implement vs revise); notes written for an approval still
 *     reach the model.
 *   - this feature never touches the model. No `setModel`, no model config:
 *     plannotator's habit of switching models silently is the reason this one
 *     is written from scratch.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GateHub } from "../../lib/gates.js";
import { getPermissionControl, type PermissionSnapshot } from "../../lib/permission-control.js";
import { buildFeedbackMarkdown } from "./feedback.js";
import { openInBrowser } from "./opener.js";
import { buildPlanKickoff, buildPlanSystemPrompt } from "./prompt.js";
import { renderBlockHtml } from "./render.js";
import { buildPlanState, startPlanServer, type PlanServerHandle } from "./server.js";
import {
	appendPlanVersion,
	createPlanSession,
	latestVersion,
	planSlug,
	type PlanSession,
} from "./store.js";

export const PLAN_COMMAND = "ask-plan";
export const PLAN_SUBMIT_TOOL = "plan_submit";

/** Files the planning phase may write: markdown, nothing else. */
function isMarkdownPath(path: string): boolean {
	return /\.mdx?$/i.test(path);
}

const PLAN_SUBMIT_PARAMS = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				'Spec file to submit, relative to the workspace root (default: the file chosen when plan mode started, e.g. "specs/ask-plan.md"). Write the file first — plan_submit reads it from disk.',
		}),
	),
});

export interface PlanOptions {
	/** `<agent-dir>`: review history lives at `<agentDir>/ask-plan/` (default: the host's). */
	agentDir?: string;
	/** Opening the browser is injectable so tests never spawn one. */
	openBrowser?: (url: string) => unknown;
	/** Port search starts here; the review server walks upward. */
	portStart?: number;
}

export function registerPlan(pi: ExtensionAPI, gates: GateHub, options: PlanOptions = {}): void {
	const open = options.openBrowser ?? openInBrowser;
	const agentDir = options.agentDir ?? getAgentDir();

	let active = false;
	let session: PlanSession | undefined;
	let server: PlanServerHandle | undefined;
	let permissionBefore: PermissionSnapshot | undefined;
	let specPath: string | undefined;
	let cwd = process.cwd();
	let ctxRef: ExtensionContext | undefined;

	function closeServer(): void {
		if (!server) return;
		void server.close();
		server = undefined;
	}

	function toolSetWithSubmit(): string[] {
		const tools = pi.getActiveTools().filter((name) => name !== PLAN_SUBMIT_TOOL);
		return [...tools, PLAN_SUBMIT_TOOL];
	}

	function toolSetWithoutSubmit(): string[] {
		return pi.getActiveTools().filter((name) => name !== PLAN_SUBMIT_TOOL);
	}

	function leave(ctx: ExtensionContext, reason: string): void {
		if (!active) return;
		active = false;
		closeServer();
		pi.setActiveTools(toolSetWithoutSubmit());
		const control = getPermissionControl();
		if (permissionBefore) control?.restore(ctx, permissionBefore);
		else control?.disable(ctx);
		permissionBefore = undefined;
		ctx.ui.notify(`ask-plan: ${reason}`, "info");
	}

	/** Compose the message the model receives for one decision. */
	function decisionMessage(version: number): string {
		if (!session) return "";
		const current = session.versions.find((candidate) => candidate.n === version);
		if (!current) return "";
		const previous = session.versions.find((candidate) => candidate.n === version - 1);
		return buildFeedbackMarkdown({
			decision: current.decision?.action === "approve" ? "approve" : "deny",
			version,
			totalVersions: session.versions.length,
			blocks: current.blocks,
			diff: current.diff,
			previousBlocks: previous?.blocks ?? [],
			global: current.annotations.global,
			perBlock: current.annotations.blocks,
		});
	}

	async function handleDecision(
		decision: { action: "approve" | "deny"; version: number },
		ctx: ExtensionContext,
	): Promise<void> {
		const message = decisionMessage(decision.version);
		if (decision.action === "approve") {
			// Leave the phase before the message goes out: the implementation
			// turn must not run under the planning gates.
			leave(ctx, "plan approved — implementing.");
		} else {
			ctx.ui.notify("ask-plan: feedback sent — the agent will revise the plan.", "info");
		}
		pi.sendUserMessage(message);
	}

	// ── Command ────────────────────────────────────────────────────────────

	pi.registerCommand(PLAN_COMMAND, {
		description:
			"Plan first: research, write a spec, review it in the browser with block annotations, then implement after approval. `off` leaves the phase, `open` re-opens the review.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim();
			ctxRef = ctx;
			cwd = ctx.cwd || process.cwd();

			if (arg === "off") {
				if (!active) {
					ctx.ui.notify("ask-plan: not in plan mode.", "info");
					return;
				}
				leave(ctx, specPath ? `plan mode off — draft left at ${specPath}.` : "plan mode off.");
				return;
			}

			if (arg === "open") {
				if (!server) {
					ctx.ui.notify("ask-plan: no review is open — submit a plan first.", "warning");
					return;
				}
				open(server.url);
				ctx.ui.notify(`ask-plan: ${server.url}`, "info");
				return;
			}

			if (active) {
				ctx.ui.notify("ask-plan: already planning. Use `off` to leave the phase.", "warning");
				return;
			}

			const slug = planSlug(arg || "plan");
			specPath = `specs/${slug}.md`;
			permissionBefore = getPermissionControl()?.snapshot();
			getPermissionControl()?.enableDefaults(ctx);
			active = true;
			pi.setActiveTools(toolSetWithSubmit());
			ctx.ui.notify(
				`ask-plan: planning. Write the spec to ${specPath}, then call ${PLAN_SUBMIT_TOOL}.`,
				"info",
			);
			pi.sendUserMessage(buildPlanKickoff(arg || undefined));
		},
	});

	// ── Tool ───────────────────────────────────────────────────────────────

	pi.registerTool<typeof PLAN_SUBMIT_PARAMS, { version?: number; url?: string }>({
		name: PLAN_SUBMIT_TOOL,
		label: "Submit plan for review",
		description:
			"Submit the spec file you just wrote so the operator can review and annotate it in the browser. Returns immediately; the decision arrives as a new message.",
		promptSnippet: "Submit the plan for browser review (plan mode only)",
		promptGuidelines: [
			"Call plan_submit only after the spec file on disk is the version you want reviewed.",
			"After submitting, end your turn: the operator's annotations arrive as a new message.",
			"Never submit a file you have not written — plan_submit reads the file from disk.",
		],
		parameters: PLAN_SUBMIT_PARAMS,
		defaultActive: false,
		async execute(_toolCallId: string, params: { path?: string }) {
			if (!active) {
				return {
					content: [{ type: "text" as const, text: "Plan mode is off — use /ask-plan first." }],
					details: {},
				};
			}
			const target = params.path ?? specPath ?? "specs/plan.md";
			const absolute = isAbsolute(target) ? target : resolve(cwd, target);
			let text: string;
			try {
				text = readFileSync(absolute, "utf8");
			} catch {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot read ${target}. Write the spec file first, then call plan_submit again.`,
						},
					],
					details: {},
				};
			}
			const source = relative(cwd, absolute) || target;
			if (!session) {
				session = createPlanSession({
					agentDir,
					slug: planSlug(source.replace(/\.mdx?$/i, "").replace(/^specs\//, "")),
					text,
					source,
				});
			} else {
				appendPlanVersion(session, { text, source });
			}
			const version = latestVersion(session);
			if (!server) {
				server = await startPlanServer({
					session,
					render: renderBlockHtml,
					portStart: options.portStart,
					onDecision: ({ action, version: decidedVersion }) => {
						const ctx = ctxRef;
						if (ctx) void handleDecision({ action, version: decidedVersion }, ctx);
					},
				});
				open(server.url);
				ctxRef?.ui.notify(`ask-plan: review open at ${server.url}`, "info");
			} else {
				server.broadcast("revision", { version: version.n });
			}
			const changed = buildPlanState(session, version.n).items.filter(
				(item) => item.status !== "unchanged",
			).length;
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Submitted v${version.n} of ${session.versions.length} (${changed} changed blocks). ` +
							`Review: ${server.url}\nEnd your turn now — the decision arrives as a new message.`,
					},
				],
				details: { version: version.n, url: server.url },
			};
		},
	});

	// ── Gate: the planning phase writes markdown only ──────────────────────

	gates.register({
		name: "plan",
		order: 5,
		evaluate(event: ToolCallEvent) {
			if (!active) return undefined;
			if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
			const path = typeof event.input.path === "string" ? event.input.path : "";
			if (path !== "" && isMarkdownPath(path)) return undefined;
			return {
				kind: "block" as const,
				reason:
					"Plan mode only writes markdown (.md/.mdx) while the plan is under review. " +
					"Implement the change after the plan is approved, or write the spec file instead.",
			};
		},
	});

	// ── System prompt while planning ───────────────────────────────────────

	pi.on("before_agent_start", (event) => {
		if (!active) return undefined;
		pi.setActiveTools(toolSetWithSubmit());
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanSystemPrompt()}` };
	});

	pi.on("session_shutdown", () => {
		closeServer();
	});
}
