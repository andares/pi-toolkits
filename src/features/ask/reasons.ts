/**
 * ask feature — actionable rejection messages.
 *
 * The `tool_call` hook's `reason` is delivered to the model as the tool result
 * (verified against pi 1.4.0: `extensions/runner.js` returns the `{block,
 * reason}` result unchanged and pi-agent-core's `agent-loop.js` turns it into
 * `createErrorToolResult(reason)`; both paths are byte-identical to 1.2.0), so
 * it is the best place to name the nearest allowed alternative and stop the model
 * from retrying variants of a blocked command. That is also why the mode banner
 * does not carry the allowlist: this path costs tokens only when it runs.
 *
 * When the session has no scratch space (degraded mode), the reasons must not
 * point at `scratchpad` — the tool is inactive then, and sending the model to
 * it would cost one wasted call per discovery.
 */
import { classifyBlockedCommand } from "./bash-sandbox.js";

export interface ReasonOptions {
	/**
	 * Whether the scratch tool is available. Default true: only the degraded
	 * no-temp-dir mode passes false, and only then is the scratch hint omitted.
	 */
	readonly scratch?: boolean;
}

function scratchClause(options: ReasonOptions, fallback: string): string {
	return options.scratch === false
		? `${fallback} This session has no scratch space, so notes cannot be saved either.`
		: `${fallback} For throwaway planning notes use \`scratchpad\`.`;
}

/** Reason for a hard-blocked tool call (write / edit / powershell). */
export function blockedToolReason(
	toolName: string,
	options: ReasonOptions = {},
): string {
	if (toolName === "powershell") {
		return (
			"Ask mode: powershell is disabled — ask mode does not change project " +
			"files. Inspect files with the read/grep/find/ls tools or the read-only " +
			"bash allowlist. " +
			scratchClause(options, "") +
			" If a real change is needed, tell the operator and ask them to exit ask " +
			"mode with /ask."
		);
	}
	return (
		`Ask mode: ${toolName} is disabled — ask mode does not change project ` +
		"files. " +
		scratchClause(options, "") +
		" If the answer needs a real change, explain what to change and ask the " +
		"operator to exit ask mode with /ask."
	);
}

/** Reason for a rejected bash command, classified by intent. */
export function blockedBashReason(
	command: string,
	options: ReasonOptions = {},
): string {
	const suffix = `\nCommand: ${command}`;
	switch (classifyBlockedCommand(command)) {
		case "substitution":
			return "Ask mode: command substitution — $(...) and backticks — is " +
				"blocked because it can run arbitrary commands. Run the inner " +
				"command directly instead." + suffix;
		case "redirect":
			return "Ask mode: output redirection is blocked — ask mode does not " +
				"write project files. " +
				(options.scratch === false
					? "This session has no scratch space either; inspect files with the read/grep/find/ls tools."
					: "Keep throwaway output as a note with `scratchpad` instead, and inspect files with the read/grep/find/ls tools.") +
				suffix;
		case "exec":
			return "Ask mode: this command can run another program (git grep -O, " +
				"git --ext-diff, find -exec/-ok, fd -x, rg --pre, env CMD). Only " +
				"read-only operations are allowed; run the underlying read-only " +
				"command directly instead." + suffix;
		case "write":
			return "Ask mode: this command writes to disk (curl -o/-O, wget -O, " +
				"dd of=, tee, sed -i, git --output, ...). " +
				(options.scratch === false
					? "There is no writable place in this session."
					: "The only writable place is `scratchpad`, and it is written by the tool, not by bash.") +
				" To read a URL without saving it use `curl -s <url>`; to read files " +
				"use the `read` tool." +
				suffix;
		case "download":
			return "Ask mode: downloads to disk are blocked. Use `curl -s <url>` " +
				"or `wget -O - <url>` to read a URL to stdout instead" +
				(options.scratch === false ? "." : ", and keep notes with `scratchpad`.") +
				suffix;
		case "git":
			return "Ask mode: only read-only git commands are allowed (status, " +
				"log, diff, show, blame, grep, rev-parse, describe, shortlog, " +
				"reflog show, stash list, tag -l, cat-file). To change the " +
				"repository, ask the operator to exit ask mode with /ask." + suffix;
		case "install":
			return "Ask mode: install/build commands are blocked. Read-only " +
				"package queries (npm view, pnpm view, pip show/list) are allowed; " +
				"to actually install or build, ask the operator to exit ask mode with " +
				"/ask." + suffix;
		default:
			return "Ask mode: this command is not on the read-only allowlist " +
				"(or is classified as destructive), so it was not executed — it may " +
				"itself be read-only. Do not retry variants: use the " +
				"read/grep/find/ls tools" +
				(options.scratch === false
					? ", a recognised read-only bash command, or tell the operator the command is blocked."
					: ", `scratchpad` for notes, a recognised read-only bash command, or tell the operator the command is blocked.") +
				suffix;
	}
}
