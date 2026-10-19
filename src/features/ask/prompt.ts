/**
 * ask feature — system prompt banner.
 *
 * Appended to the system prompt (chained append, not replacement) while ask
 * mode is active. It is deliberately short: the system prompt is part of every
 * request in a run, so the mode line is kept to a few sentences that stay
 * byte-identical for the whole session (no paths, no timestamps, nothing that
 * changes per turn) and therefore remains a stable, cacheable prefix. Details
 * live where they are cheaper and more timely:
 *
 *  - the scratchpad tool's own declaration and `promptGuidelines` carry the
 *    "notes, not deliverables" rule, and only while the tool is active;
 *  - rejected calls carry the allowed alternative (see reasons.ts), so a model
 *    that guesses wrong pays for the detail only on the turn it needs it;
 *  - the read-only bash allowlist is *not* spelled out here. That list used to
 *    be ~300 tokens per request restating what the sandbox already enforces.
 *
 * Do NOT use the removed `systemPromptAppend` field or wholesale systemPrompt
 * replacement (see PLAN.md).
 */

export interface AskBannerOptions {
	/** Whether the session has a usable scratch directory (tool active). */
	readonly scratch?: boolean;
}

const BANNER_HEADER = `[ASK MODE] Consult only — read, answer, plan; do not implement.`;

const SCRATCH_LINE = `Throwaway notes go through the \`scratchpad\` tool (a temp directory outside the project); nothing written there is a deliverable.`;

const BANNER_FOOTER = `Any other write is blocked, and a blocked call comes back with the allowed alternative — do not retry variants.
Exit: the operator runs /ask.`;

/** Build the banner, dropping the scratch line when no scratch space exists. */
export function buildAskBanner(options: AskBannerOptions = {}): string {
	const lines = [BANNER_HEADER];
	if (options.scratch === true) lines.push(SCRATCH_LINE);
	lines.push(BANNER_FOOTER);
	return lines.join("\n");
}

/** Append the ask-mode banner to an existing system prompt. */
export function appendAskBanner(
	systemPrompt: string,
	options: AskBannerOptions = {},
): string {
	return `${systemPrompt}\n\n${buildAskBanner(options)}`;
}
