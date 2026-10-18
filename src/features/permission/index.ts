/**
 * permission feature — `/ask-perm`: session-scoped boundary permission.
 *
 * Design notes:
 *  - Off by default and never persisted. The mode, the modes, and every session
 *    grant live in this closure; `session_start` resets them and
 *    `session_shutdown` clears them. A forgotten toggle cannot follow the
 *    operator into the next session.
 *  - Toggling: no arguments flips on→off, off→panel. Arguments configure and
 *    enable in one step (`/ask-perm allow allow allow ask`), which is also the
 *    autostart path and never opens a dialog.
 *  - Enforcement is a gate on the shared bus, so it composes with `/ask`
 *    instead of replacing it: ask answers "does this mutate?", permission
 *    answers "does this cross the project boundary?", and either can block.
 *  - The boundary is the working directory plus directories added through
 *    pi-add-dir (read from its session entry).
 */
import { isAbsolute, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { AskRequest, GateHub } from "../../lib/gates.js";
import {
	DEFAULT_MODES,
	type PermissionModes,
	PERMISSION_STATUS_KEY,
	type Effect,
} from "./constants.js";
import {
	formatModes,
	parsePermissionArgs,
	sameModes,
	shortMode,
} from "./modes.js";
import { openPermissionPanel } from "./panel.js";
import {
	canonicalize,
	expandHome,
	readAddedDirectories,
	sessionRoots,
} from "./paths.js";
import {
	decideProgram,
	decisionEffect,
	decisionGrantRoot,
	formatDenial,
	type PolicyDecision,
	programKey,
} from "./policy.js";
import { askPermission } from "./prompt.js";
import { SessionRules } from "./session-rules.js";
import { parseCommandUnits, type CommandUnit } from "./units.js";

/** Tools that read one path. */
const READ_PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Tools that write one path. */
const WRITE_PATH_TOOLS = new Set(["write", "edit"]);

function inputPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const value = (input as { path?: unknown }).path;
	return typeof value === "string" ? value : undefined;
}

/** One synthetic unit for a non-bash tool call. */
function toolUnit(
	command: string,
	effect: Effect,
	pathValue: string | undefined,
	cwd: string,
): CommandUnit {
	const base = canonicalize(cwd);
	return {
		raw: command,
		headWord: command,
		command,
		args: [],
		effect,
		opaque: WRITE_PATH_TOOLS.has(command) && pathValue === undefined,
		base,
		targets:
			pathValue === undefined
				? []
				: [
						{
							path: isAbsolute(expandHome(pathValue))
								? expandHome(pathValue)
								: join(base, pathValue),
							effect,
							source: "operand",
						},
					],
		note: pathValue === undefined ? "the tool call names no path" : undefined,
	};
}

export function registerPermission(pi: ExtensionAPI, gates: GateHub): void {
	let enabled = false;
	let modes: PermissionModes = { ...DEFAULT_MODES };
	// Session this state belongs to. A runtime rebind can emit `session_start`
	// again for the same session; resetting then would wipe a mode that the
	// autostart replay had just enabled, so only a different session resets.
	let currentSessionId: string | undefined;
	const rules = new SessionRules();
	let rootsCache:
		| { cwd: string; branchLength: number; roots: string[] }
		| undefined;

	function reset(): void {
		enabled = false;
		modes = { ...DEFAULT_MODES };
		rules.clear();
		rootsCache = undefined;
	}

	/** Session id, or `undefined` when the host exposes none. */
	function sessionIdOf(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}

	function syncStatus(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(PERMISSION_STATUS_KEY, undefined);
			return;
		}
		const color = (mode: string, label: string): string => {
			if (mode === "allow") return ctx.ui.theme.fg("success", label);
			if (mode === "ask") return ctx.ui.theme.fg("warning", label);
			return ctx.ui.theme.fg("error", label);
		};
		const part = (inProject: string, outside: string): string =>
			`${color(inProject, shortMode(inProject as "allow"))}/${color(outside, shortMode(outside as "allow"))}`;
		ctx.ui.setStatus(
			PERMISSION_STATUS_KEY,
			`${ctx.ui.theme.fg("muted", "perm")} i:${part(modes.inRead, modes.inWrite)} o:${part(modes.outRead, modes.outWrite)}`,
		);
	}

	/** Session roots, refreshed only when the branch grew. */
	function rootsFor(ctx: ExtensionContext): string[] {
		try {
			const branch = ctx.sessionManager.getBranch();
			if (
				!rootsCache ||
				rootsCache.cwd !== ctx.cwd ||
				rootsCache.branchLength !== branch.length
			) {
				rootsCache = {
					cwd: ctx.cwd,
					branchLength: branch.length,
					roots: sessionRoots(ctx.cwd, readAddedDirectories(branch)),
				};
			}
			return rootsCache.roots;
		} catch {
			// No session manager (unexpected context): fail closed on the cwd only.
			return [canonicalize(ctx.cwd)];
		}
	}

	function unitsFor(event: ToolCallEvent, cwd: string): CommandUnit[] {
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			return parseCommandUnits(typeof command === "string" ? command : "", cwd);
		}
		if (event.toolName === "powershell") {
			// PowerShell is not decomposed: a script's writes and exec targets stay
			// invisible, so the call is asked about instead of judged by its cwd.
			return [
				{
					raw: "powershell",
					headWord: "powershell",
					command: "powershell",
					args: [],
					effect: "write",
					opaque: true,
					base: canonicalize(cwd),
					targets: [],
					note: "PowerShell commands are not analysed",
				},
			];
		}
		if (READ_PATH_TOOLS.has(event.toolName)) {
			return [toolUnit(event.toolName, "read", inputPath(event.input), cwd)];
		}
		if (WRITE_PATH_TOOLS.has(event.toolName)) {
			return [toolUnit(event.toolName, "write", inputPath(event.input), cwd)];
		}
		// Every other tool (MCP, subagent, …) has no path to judge: it is
		// treated as an exec and answered by the working directory's scope.
		return [toolUnit(event.toolName, "write", undefined, cwd)];
	}

	function askRequest(
		decision: PolicyDecision,
		fallbackCwd: string,
		units: readonly CommandUnit[],
	): AskRequest {
		const root = decisionGrantRoot(decision, () => fallbackCwd);
		const effect = decisionEffect(decision);
		const scope =
			decision.target?.scope === "out" ? "outside project" : "inside project";
		const details = [
			`Command: ${decision.unit.raw || decision.unit.command}`,
			...(decision.target
				? [`Target: ${decision.target.path} (${scope}, ${effect})`]
				: []),
			...(decision.reason ? [`Reason: ${decision.reason}`] : []),
			decision.unit.opaque
				? "Session grant would cover: this exact command"
				: `Session grant would cover: ${root}`,
		];
		return {
			title: "Permission required",
			details,
			root,
			present: (ctx) =>
				askPermission(ctx, { title: "Permission required", details }),
			apply: (choice) => {
				if (choice === "allow-session") {
					if (decision.unit.opaque) rules.allowCommand(programKey(units));
					else rules.allow({ effect, root });
				}
				if (choice === "deny-session") {
					if (decision.unit.opaque) rules.denyCommand(programKey(units));
					else rules.deny({ effect, root });
				}
			},
			denyReason: (choice) =>
				formatDenial({
					...decision,
					reason:
						choice === "deny-session"
							? `${decision.reason ?? "operation"} — denied for this session`
							: (decision.reason ?? "denied by the operator"),
				}),
		};
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		const sessionId = sessionIdOf(ctx);
		// Same session, repeated emission (a startup rebind): keep the state.
		if (sessionId !== undefined && sessionId === currentSessionId) {
			syncStatus(ctx);
			return;
		}
		currentSessionId = sessionId;
		reset();
		syncStatus(ctx);
	});

	// ── Command ────────────────────────────────────────────────────────────

	pi.registerCommand("ask-perm", {
		description:
			"Toggle permission checks; with arguments: /ask-perm [in-read] [in-write] [out-read] [out-write]",
		handler: async (args, ctx) => {
			const raw = args.trim();

			if (raw !== "") {
				const parsed = parsePermissionArgs(raw);
				if ("error" in parsed) {
					ctx.ui.notify(`ask-perm: ${parsed.error}`, "error");
					return;
				}
				// Idempotent: the same command may arrive twice in one session start
				// (both autostart sources declaring it, a duplicated config line, …).
				// Re-applying an unchanged policy is a no-op — no second "ON" notice,
				// and no loss of the session grants collected so far.
				if (enabled && sameModes(modes, parsed.modes)) return;

				const changed = !sameModes(modes, parsed.modes);
				modes = parsed.modes;
				// A changed policy invalidates grants made under the old one.
				if (changed) rules.clear();
				enabled = true;
				syncStatus(ctx);
				ctx.ui.notify(
					`Permission ON — ${formatModes(modes)}. /ask-perm to turn off.`,
					"info",
				);
				return;
			}

			if (enabled) {
				enabled = false;
				rules.clear();
				syncStatus(ctx);
				ctx.ui.notify(
					"Permission OFF — no boundary checks in this session.",
					"info",
				);
				return;
			}

			const chosen = await openPermissionPanel(ctx, modes);
			if (!chosen) {
				ctx.ui.notify(
					"ask-perm: cancelled. Use /ask-perm allow allow allow ask to enable from the argument form.",
					"info",
				);
				return;
			}
			// The panel only opens while off, so this always transitions on.
			modes = chosen;
			rules.clear();
			enabled = true;
			syncStatus(ctx);
			ctx.ui.notify(
				`Permission ON — ${formatModes(modes)}. /ask-perm to turn off.`,
				"info",
			);
		},
	});

	// ── Gate ───────────────────────────────────────────────────────────────

	gates.register({
		name: "permission",
		order: 20,
		evaluate(event, ctx) {
			if (!enabled) return undefined;
			const units = unitsFor(event, ctx.cwd);
			if (units.length === 0) return undefined;
			const decision = decideProgram(units, {
				modes,
				roots: rootsFor(ctx),
				rules,
			});
			if (decision.action === "allow") return undefined;
			if (decision.action === "deny") {
				return { kind: "block", reason: formatDenial(decision) };
			}
			return { kind: "ask", request: askRequest(decision, ctx.cwd, units) };
		},
	});

	// ── Model-facing banner ────────────────────────────────────────────────

	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		const banner = [
			"",
			"## Permission mode",
			`Boundary checks are ON: ${formatModes(modes)}.`,
			"Operations outside the project, destructive commands, and credential paths may require operator confirmation.",
			"A denial is a policy decision — do not retry the same operation through an equivalent command.",
			"",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}${banner}` };
	});
}
