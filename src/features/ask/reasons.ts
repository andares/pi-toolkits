/**
 * ask feature — actionable rejection messages.
 *
 * The `tool_call` hook's `reason` is delivered to the model as the tool result
 * (verified against pi 1.1.0: the blocked call returns the reason text), so it
 * is the best place to name the nearest allowed alternative and stop the model
 * from retrying variants of a blocked command.
 */
import { classifyBlockedCommand } from "./bash-sandbox.js";

/** Reason for a hard-blocked tool call (write / edit / powershell). */
export function blockedToolReason(toolName: string): string {
	if (toolName === "powershell") {
		return "Ask mode: powershell is disabled — ask mode is read-only. " +
			"Inspect files with the read/grep/find/ls tools or the read-only bash " +
			"allowlist; if a command must change something, tell the user and ask " +
			"them to exit ask mode with /ask.";
	}
	return `Ask mode: ${toolName} is disabled — ask mode is read-only. ` +
		"If a change is needed, explain what to change and ask the user to exit " +
		"ask mode with /ask.";
}

/** Reason for a rejected bash command, classified by intent. */
export function blockedBashReason(command: string): string {
	const suffix = `\nCommand: ${command}`;
	switch (classifyBlockedCommand(command)) {
		case "substitution":
			return "Ask mode: command substitution — $(...) and backticks — is " +
				"blocked because it can run arbitrary commands. Run the inner " +
				"command directly instead." + suffix;
		case "redirect":
			return "Ask mode: output redirection is blocked — ask mode cannot " +
				"write files, not even temporary ones. Use the read/grep/find/ls " +
				"tools to inspect files instead." + suffix;
		case "exec":
			return "Ask mode: this command can run another program (git grep -O, " +
				"git --ext-diff, find -exec/-ok, fd -x, rg --pre, env CMD). Only " +
				"read-only operations are allowed; run the underlying read-only " +
				"command directly instead." + suffix;
		case "write":
			return "Ask mode: this command writes to disk (curl -o/-O, wget -O, " +
				"dd of=, tee, sed -i, git --output, ...). Nothing can be written in " +
				"ask mode. To read a URL without saving it use `curl -s <url>`; to " +
				"read files use the `read` tool." + suffix;
		case "download":
			return "Ask mode: downloads to disk are blocked. Use `curl -s <url>` " +
				"or `wget -O - <url>` to read a URL to stdout instead." + suffix;
		case "git":
			return "Ask mode: only read-only git commands are allowed (status, " +
				"log, diff, show, blame, grep, rev-parse, describe, shortlog, " +
				"reflog show, stash list, tag -l, cat-file). To change the " +
				"repository, ask the user to exit ask mode with /ask." + suffix;
		case "install":
			return "Ask mode: install/build commands are blocked. Read-only " +
				"package queries (npm view, pnpm view, pip show/list) are allowed; " +
				"to actually install or build, ask the user to exit ask mode with " +
				"/ask." + suffix;
		default:
			return "Ask mode: this command is not on the read-only allowlist " +
				"(or is classified as destructive), so it was not executed — it may " +
				"itself be read-only. Do not retry variants: use the " +
				"read/grep/find/ls tools, a recognised read-only bash command, or " +
				"tell the user the command is blocked." + suffix;
	}
}
