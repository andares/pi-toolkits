/**
 * ask-spec — spec mode with a browser review round.
 *
 * The flow: `/ask-spec` opens a spec-review phase (read tools, questions, markdown
 * writes only), the agent writes a spec and calls `spec_submit`, the review
 * server opens the page in the operator's browser, annotations come back as a
 * message, and the loop repeats until the spec is approved — then the phase ends
 * and the agent implements.
 *
 * Three properties are load-bearing:
 *   - `spec_submit` returns immediately. Waiting for the decision inside the
 *     tool would pin the agent for as long as the operator takes to read; the
 *     decision arrives later as a normal user message instead.
 *   - the decision always carries the annotations. Approve and deny only choose
 *     the next step (implement vs revise); notes written for an approval still
 *     reach the model.
 *   - this feature never touches the model or its configuration:
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
import { getAskControl } from "../../lib/ask-control.js";
import { LEGACY_SPEC_PHASE_TOOL, SPEC_PHASE_TOOL, UAT_PHASE_TOOL } from "../../lib/phases.js";
import { frameworkReadiness } from "../init/parity.js";
import { resolveProjectRoot } from "../uat/state.js";
import { canonicalize, isWithin } from "../permission/paths.js";
import { parseCommandUnits } from "../permission/units.js";
import { buildFeedbackMarkdown } from "./feedback.js";
import { openInBrowser } from "../../lib/opener.js";
import { buildSpecKickoff, buildSpecSystemPrompt } from "./prompt.js";
import { renderBlockHtml } from "../review-page/render.js";
import { buildSpecState, startSpecServer, type SpecServerHandle } from "./server.js";
import {
	appendSpecVersion,
	createSpecSession,
	latestVersion,
	specSlug,
	readVersionText,
	type SpecSession,
} from "./store.js";

export const SPEC_COMMAND = "ask-spec";
export const SPEC_COMMAND_ALIAS = "ask-plan";
export const SPEC_SUBMIT_TOOL = SPEC_PHASE_TOOL;

/** Files the spec-review phase may write: project markdown, nothing else. */
function isMarkdownPath(path: string): boolean {
	return /\.mdx?$/i.test(path);
}

/** Resolve a markdown path inside the workspace; anything else is rejected. */
function specMarkdownPath(path: string, cwd: string): string | undefined {
	if (path === "" || !isMarkdownPath(path)) return undefined;
	const absolute = canonicalize(isAbsolute(path) ? path : resolve(cwd, path));
	if (absolute === cwd || !isWithin(cwd, absolute)) return undefined;
	return absolute;
}

function samePermissionSnapshot(a: PermissionSnapshot, b: PermissionSnapshot): boolean {
	return (
		a.enabled === b.enabled &&
		a.modes.inRead === b.modes.inRead &&
		a.modes.inWrite === b.modes.inWrite &&
		a.modes.outRead === b.modes.outRead &&
		a.modes.outWrite === b.modes.outWrite
	);
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return `pid-${process.pid}`;
	}
}

const SPEC_SUBMIT_PARAMS = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				'Spec file to submit, relative to the workspace root (default: the file chosen when spec mode started, e.g. "specs/ask-spec.md"). Write the file first — spec_submit reads it from disk.',
		}),
	),
});

export interface SpecOptions {
	/** `<agent-dir>`: review history lives at `<agentDir>/ask-spec/` (default: the host's). */
	agentDir?: string;
	/** Opening the browser is injectable so tests never spawn one. */
	openBrowser?: (url: string) => unknown;
	/** Milliseconds between a decision and closing the review server (tests inject 0). */
	closeDelayMs?: number;
	/** Port search starts here; the review server walks upward. */
	portStart?: number;
	/** How many ports the review server may try before giving up (default: the whole 7600–7699 pool). */
	portAttempts?: number;
}

export function registerSpec(pi: ExtensionAPI, gates: GateHub, options: SpecOptions = {}): void {
	const open = options.openBrowser ?? openInBrowser;
	const agentDir = options.agentDir ?? getAgentDir();

	let active = false;
	let session: SpecSession | undefined;
	let server: SpecServerHandle | undefined;
	let permissionBefore: PermissionSnapshot | undefined;
	let permissionDuring: PermissionSnapshot | undefined;
	let specPath: string | undefined;
	let cwd = process.cwd();
	let ctxRef: ExtensionContext | undefined;
	let specSessionId: string | undefined;

	function closeServer(): void {
		if (!server) return;
		const closing = server;
		server = undefined;
		void closing.close();
	}

	/**
	 * Start the review server for the current session.
	 *
	 * Every start gets its own token and walks the port range, so a restarted
	 * review never reuses a dead socket and two sessions cannot share a window.
	 */
	function startReviewServer(current: SpecSession): Promise<SpecServerHandle> {
		return startSpecServer({
			session: current,
			render: renderBlockHtml,
			portStart: options.portStart,
			portAttempts: options.portAttempts,
			closeDelayMs: options.closeDelayMs,
			onDecision: ({ action, version: decidedVersion }) => {
				const ctx = ctxRef;
				if (ctx) void handleDecision({ action, version: decidedVersion }, ctx);
			},
		});
	}

	/**
	 * A live handle, or a freshly started one with its window opened.
	 *
	 * A review server closes itself shortly after a decision. The handle that
	 * produced that decision is dead: broadcasting a revision into it reaches no
	 * page, and printing its URL gives the operator a dead link. Detect that and
	 * start a new server instead — the next window is a new window on purpose.
	 */
	async function ensureReviewServer(): Promise<{ handle: SpecServerHandle; started: boolean }> {
		if (server && server.active()) return { handle: server, started: false };
		if (!session) throw new Error("no spec revision to review yet");
		server = undefined;
		const handle = await startReviewServer(session);
		server = handle;
		open(handle.url);
		return { handle, started: true };
	}

	function toolSetWithSubmit(): string[] {
		const tools = pi
			.getActiveTools()
			.filter((name) => name !== SPEC_SUBMIT_TOOL && name !== LEGACY_SPEC_PHASE_TOOL);
		return [...tools, SPEC_SUBMIT_TOOL];
	}

	function toolSetWithoutSubmit(): string[] {
		return pi
			.getActiveTools()
			.filter((name) => name !== SPEC_SUBMIT_TOOL && name !== LEGACY_SPEC_PHASE_TOOL);
	}

	function leave(ctx: ExtensionContext, reason: string): void {
		if (!active) return;
		active = false;
		closeServer();
		pi.setActiveTools(toolSetWithoutSubmit());
		const control = getPermissionControl();
		const current = control?.snapshot();
		// Restore only if the operator has not changed the policy mid-review. A
		// manual `/ask-perm` during the spec review is newer intent and must win.
		if (
			control &&
			permissionBefore &&
			permissionDuring &&
			current &&
			samePermissionSnapshot(current, permissionDuring)
		) {
			control.restore(ctx, permissionBefore);
		}
		permissionBefore = undefined;
		permissionDuring = undefined;
		specSessionId = undefined;
		ctx.ui.notify(`ask-spec: ${reason}`, "info");
	}

	/** Compose the message the model receives for one decision. */
	function decisionMessage(version: number): string {
		if (!session) return "";
		const current = session.versions.find((candidate) => candidate.n === version);
		if (!current) return "";
		const previous = session.versions.find((candidate) => candidate.n === version - 1);
		const approved = current.decision?.action === "approve";
		return buildFeedbackMarkdown({
			decision: approved ? "approve" : "deny",
			version,
			totalVersions: latestVersion(session).n,
			blocks: current.blocks,
			diff: current.diff,
			previousBlocks: previous?.blocks ?? [],
			global: current.annotations.global,
			perBlock: current.annotations.blocks,
			// Approval quotes the reviewed snapshot, not the file's current bytes:
			// the model may have kept editing after submitting this revision.
			specPath: current.source ?? specPath,
			specText: readApprovedText(version) ?? current.blocks.map((block) => block.text).join("\n\n"),
			// During the review the tool is intentionally inactive. Recommend it on
			// approval only when the project has the framework and the tool exists.
			recordTool:
				pi.getAllTools().some((tool) => tool.name === "record_change") &&
				frameworkReadiness(resolveProjectRoot(cwd)).ready,
		});
	}

	/** Text of one revision, or undefined when the snapshot file is unreadable. */
	function readApprovedText(version: number): string | undefined {
		if (!session) return undefined;
		try {
			return readVersionText(session, version);
		} catch {
			return undefined;
		}
	}

	async function handleDecision(
		decision: { action: "approve" | "deny"; version: number },
		ctx: ExtensionContext,
	): Promise<void> {
		// The operator may leave spec mode, or switch sessions, during the short
		// close delay. A stale decision must not resurrect implementation or send
		// an empty message into the new phase.
		if (!active) return;
		const message = decisionMessage(decision.version);
		if (decision.action === "approve") {
			// Leave the phase before the message goes out: the implementation
			// turn must not run under the spec-review gates.
			leave(ctx, "spec approved — implementing.");
		} else {
			ctx.ui.notify("ask-spec: feedback sent — the agent will revise the spec.", "info");
		}
		pi.sendUserMessage(message);
	}

	// ── Command ────────────────────────────────────────────────────────────

	const specCommand = {
		description:
			"Spec first: research, write a spec, review it in the browser with block annotations, then implement after approval. Run without arguments again, or use `off`, to leave the phase; `open` re-opens the review.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim();
			ctxRef = ctx;
			cwd = canonicalize(ctx.cwd || process.cwd());

			if (arg === "off") {
				if (!active) {
					ctx.ui.notify("ask-spec: not in spec mode.", "info");
					return;
				}
				leave(ctx, specPath ? `spec mode off — draft left at ${specPath}.` : "spec mode off.");
				return;
			}

			if (arg === "open") {
				if (!session) {
					ctx.ui.notify("ask-spec: no review is open — submit a spec first.", "warning");
					return;
				}
				try {
					const ensured = await ensureReviewServer();
					// A fresh server already opened its window; an existing one is
					// simply pointed at again.
					if (!ensured.started) open(ensured.handle.url);
					ctx.ui.notify(`ask-spec: ${ensured.handle.url}`, "info");
				} catch (error) {
					ctx.ui.notify(
						`ask-spec: cannot start the review server — ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				return;
			}

			if (active && arg === "") {
				leave(ctx, specPath ? `spec mode off — draft left at ${specPath}.` : "spec mode off.");
				return;
			}

			if (active) {
				ctx.ui.notify("ask-spec: already reviewing a spec. Use `off` to leave the phase.", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("ask-spec: the agent is still running — finish or abort first.", "warning");
				return;
			}
			if (pi.getActiveTools().includes(UAT_PHASE_TOOL)) {
				ctx.ui.notify("ask-spec: ask-uat is open — /ask-uat off first.", "warning");
				return;
			}

			const readiness = frameworkReadiness(resolveProjectRoot(cwd));
			if (!readiness.ready) {
				ctx.ui.notify(
					`ask-spec: no complete agent framework (missing: ${readiness.missing.join(", ")}). The spec still works, but record_change and /ask-uat stay unavailable until /ask-init.`,
					"info",
				);
			}

			const slug = specSlug(arg || "spec");
			specPath = `specs/${slug}.md`;
			session = undefined;
			specSessionId = sessionIdOf(ctx);
			const permission = getPermissionControl();
			permissionBefore = permission?.snapshot();
			permission?.enableDefaults(ctx);
			permissionDuring = permission?.snapshot();
			// Spec mode is intentionally less restrictive than ask mode. Let ask
			// restore its own tool snapshot before we add spec_submit.
			if (getAskControl()?.isActive()) getAskControl()?.exit(ctx);
			active = true;
			pi.setActiveTools(toolSetWithSubmit());
			ctx.ui.notify(
				`ask-spec: reviewing. Write the spec to ${specPath}, then call ${SPEC_SUBMIT_TOOL}.`,
				"info",
			);
			pi.sendUserMessage(buildSpecKickoff(arg || undefined));
		},
	};

	// `/ask-plan` stays as an alias: the workflow predates the rename, and a
	// half-remembered command must not drop the operator into a plain chat.
	for (const command of [SPEC_COMMAND, SPEC_COMMAND_ALIAS]) {
		pi.registerCommand(command, specCommand);
	}

	// ── Tool ───────────────────────────────────────────────────────────────

	pi.registerTool<typeof SPEC_SUBMIT_PARAMS, { version?: number; url?: string }>({
		name: SPEC_SUBMIT_TOOL,
		label: "Submit spec for review",
		description:
			"Submit the spec file you just wrote so the operator can review and annotate it in the browser. Returns immediately; the decision arrives as a new message.",
		promptSnippet: "Submit the spec for browser review (spec mode only)",
		promptGuidelines: [
			"Call spec_submit only after the spec file on disk is the version you want reviewed.",
			"After submitting, end your turn: the operator's annotations arrive as a new message.",
			"Never submit a file you have not written — spec_submit reads the file from disk.",
		],
		parameters: SPEC_SUBMIT_PARAMS,
		defaultActive: false,
		async execute(_toolCallId: string, params: { path?: string }) {
			if (!active) {
				return {
					content: [{ type: "text" as const, text: "Spec mode is off — use /ask-spec first." }],
					details: {},
				};
			}
			const target = params.path ?? specPath ?? "specs/spec.md";
			const absolute = specMarkdownPath(target, cwd);
			if (!absolute) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Submit only a markdown file inside the workspace (got ${target}).`,
						},
					],
					details: {},
				};
			}
			let text: string;
			try {
				text = readFileSync(absolute, "utf8");
			} catch {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot read ${target}. Write the spec file first, then call spec_submit again.`,
						},
					],
					details: {},
				};
			}
			const source = relative(cwd, absolute) || target;
			if (!session) {
				session = createSpecSession({
					agentDir,
					slug: specSlug(source.replace(/\.mdx?$/i, "").replace(/^specs\//, "")),
					text,
					source,
				});
			} else {
				appendSpecVersion(session, { text, source });
			}
			const version = latestVersion(session);
			let handle: SpecServerHandle;
			try {
				const ensured = await ensureReviewServer();
				handle = ensured.handle;
				if (!ensured.started) handle.broadcast("revision", { version: version.n });
				if (ensured.started) {
					ctxRef?.ui.notify(`ask-spec: review open at ${handle.url}`, "info");
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot open the review page: ${error instanceof Error ? error.message : String(error)}. The spec is saved; retry spec_submit.`,
						},
					],
					details: {},
				};
			}
			const changed = buildSpecState(session, version.n).items.filter(
				(item) => item.status !== "unchanged",
			).length;
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Submitted v${version.n} of ${session.versions.length} (${changed} changed blocks). ` +
							`Review: ${handle.url}\nEnd your turn now — the decision arrives as a new message.`,
					},
				],
				details: { version: version.n, url: handle.url },
			};
		},
	});

	// ── Gate: the spec-review phase writes markdown only ──────────────────────

	gates.register({
		name: "spec",
		order: 5,
		evaluate(event: ToolCallEvent) {
			if (!active) return undefined;
			if (event.toolName === "bash") {
				// The promise is "spec mode does not implement", and a redirect is
				// implementation just as much as `write` is. Temp paths outside the
				// workspace stay allowed; opaque units are left to the permission gate,
				// which already fails closed on them (no double prompt here).
				const command = typeof event.input.command === "string" ? event.input.command : "";
				if (command === "") return undefined;
				for (const unit of parseCommandUnits(command, cwd)) {
					if (unit.opaque) continue;
					for (const target of unit.targets) {
						if (target.effect !== "write") continue;
						const absolute = canonicalize(target.path);
						if (absolute === cwd || !isWithin(cwd, absolute)) continue;
						if (/\.mdx?$/i.test(absolute)) continue;
						return {
							kind: "block" as const,
							reason:
								`Spec mode only writes markdown while the spec is under review (blocked bash write to ${target.path}). ` +
								"Implement the change after the spec is approved; write the spec file instead.",
						};
					}
				}
				return undefined;
			}
			if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
			const path = typeof event.input.path === "string" ? event.input.path : "";
			if (specMarkdownPath(path, cwd) !== undefined) return undefined;
			return {
				kind: "block" as const,
				reason:
					"Spec mode only writes markdown (.md/.mdx) while the spec is under review. " +
					"Implement the change after the spec is approved, or write the spec file instead.",
			};
		},
	});

	// ── System prompt while reviewing ──────────────────────────────────────

	pi.on("before_agent_start", (event) => {
		if (!active) return undefined;
		pi.setActiveTools(toolSetWithSubmit());
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildSpecSystemPrompt({
				questionTool: pi.getActiveTools().includes("ask_user_question"),
			})}`,
		};
	});

	pi.on("session_shutdown", () => {
		closeServer();
	});

	pi.on("session_start", (_event, ctx) => {
		const nextSessionId = sessionIdOf(ctx);
		if (nextSessionId === specSessionId) return;
		// A different session must not inherit this session's gates, review server
		// or permission snapshot. Permission's own session_start has already reset
		// its state, so do not restore the old snapshot here.
		active = false;
		session = undefined;
		permissionBefore = undefined;
		permissionDuring = undefined;
		specSessionId = undefined;
		specPath = undefined;
		ctxRef = ctx;
		closeServer();
		pi.setActiveTools(toolSetWithoutSubmit());
	});
}
