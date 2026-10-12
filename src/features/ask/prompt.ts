/**
 * ask feature — system prompt banner.
 *
 * Appended to the system prompt (chained append, not replacement) while ask
 * mode is active so the model knows the current mode, what it may still use,
 * and — for everything blocked — what to use instead. Do NOT use the removed
 * `systemPromptAppend` field or wholesale systemPrompt replacement (see
 * PLAN.md).
 */

export interface AskBannerOptions {
	/** Read-only helper tools active in this session (subset of grep/find/ls). */
	readonly helperTools?: readonly string[];
}

const BANNER_HEADER = `[ASK MODE — read-only]
You are in ask mode: answer questions and read code; nothing may be modified.

Hard-blocked (calls fail — no workaround): write, edit, powershell.
If fulfilling a request needs a change, say exactly what to change and tell the
user to exit ask mode with /ask first.

bash runs under a read-only allowlist. Working examples:
- files:    ls, cat, head, tail, sed -n, wc, file, stat, diff, tree
- search:   grep, rg, fd, find (without -exec), jq
- git:      status, log, diff, show, branch, remote, blame, grep, rev-parse,
            describe, shortlog, reflog show, stash list, tag -l, cat-file
- network:  curl -s <url>, wget -O - <url>
- packages: npm view, pnpm view, pip show/list, python3 -m json.tool

Blocked without exception: redirection (> >>), tee, dd, rm/mv/cp/mkdir, sed -i,
installs/builds, git mutations (add/commit/checkout/reset/stash drop/...), and
command substitution $(...) / backticks.`;

const BANNER_FOOTER = `Never write a file, not even a temporary one.`;

/** Build the banner, adapting the search hint to the active helper tools. */
export function buildAskBanner(options: AskBannerOptions = {}): string {
	const helpers = options.helperTools ?? [];
	const helperLabel = helpers.map((name) => `\`${name}\``).join("/");
	const helperLine =
		helpers.length > 0
			? `\n- search with the ${helperLabel} tools (active during ask mode)`
			: "";
	return `${BANNER_HEADER}

If a bash command is rejected, do not retry variants or invent workarounds:
- read file contents with the \`read\` tool instead of cat/sed tricks${helperLine}
- fetch a URL with \`curl -s <url>\` instead of wget
- otherwise tell the user which command is blocked and why

${BANNER_FOOTER}`;
}

/** Append the ask-mode banner to an existing system prompt. */
export function appendAskBanner(
	systemPrompt: string,
	options: AskBannerOptions = {},
): string {
	return `${systemPrompt}\n\n${buildAskBanner(options)}`;
}
