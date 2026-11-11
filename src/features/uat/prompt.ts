/**
 * UAT prompt — the clustering work order and the phase banner.
 *
 * English on purpose: everything the model and the operator see at runtime is
 * English (see AGENTS.md). The text never asks for a particular language in the
 * items it produces; the model follows the project's own documentation.
 *
 * The work order is a *contract about shape*, not a template to fill in. The
 * number that matters is the ratio: many change records collapse into few
 * acceptance items, because the operator verifies behaviour, not commits.
 */
import type { PendingCandidate, UatItemView, UatState } from "./ledger.js";

export interface KickoffInput {
	pending: readonly PendingCandidate[];
	openItems: readonly UatItemView[];
	maxCandidates: number;
	maxItems: number;
}

function describeCandidate(candidate: PendingCandidate): string {
	const parts = [
		`- ${candidate.id}`,
		`| ${candidate.title}`,
		candidate.behavior ? `| ${candidate.behavior}` : "| (no behaviour sentence — read the record)",
		candidate.hint ? `| hint: ${candidate.hint}` : "",
		candidate.area ? `| area: ${candidate.area}` : "",
	];
	return parts.filter((part) => part !== "").join(" ");
}

export function buildUatKickoff(input: KickoffInput): string {
	const shown = input.pending.slice(0, input.maxCandidates);
	const hidden = input.pending.length - shown.length;
	const existing =
		input.openItems.length === 0
			? "- (none)"
			: input.openItems
					.slice(0, 20)
					.map((item) => `- ${item.id} | ${item.title} | ${item.summary}`)
					.join("\n");

	return [
		"UAT clustering run.",
		"",
		"The operator is about to accept user-visible behaviour in the browser page that is now open.",
		"Turn the pending change records into a small number of acceptance items — not one item per record.",
		"",
		`Pending change records (${input.pending.length}, showing ${shown.length}${hidden > 0 ? `, ${hidden} left for the next run` : ""}):`,
		...shown.map(describeCandidate),
		"",
		"Already open acceptance items (link new evidence here instead of duplicating):",
		existing,
		"",
		"Rules:",
		`- One item is one behaviour a person can verify by hand. If two records land on the same screen or the same command, they are one item unless the operator must test them separately.`,
		"- summary: 2-3 sentences, user-facing. What can the operator now do, see, or stop worrying about. No file names, no function names, no implementation detail.",
		"- steps: 3-6 concrete steps (what to open, click, type, run) and the expected result of each.",
		"- edge: optional corner cases worth one quick try (empty input, wrong order, offline, permission denied).",
		"- skip: what NOT to test this round (internal refactors, renames, dependency bumps) — one short line.",
		"- Prefer `uat_item` op=\"link\" onto an existing open item over creating a near-duplicate.",
		`- Create at most ${input.maxItems} new items in this run; leftovers stay pending and show up next time.`,
		"- Call `uat_item` once per item (or per link). Do not edit the ledger by hand, and do not change code in this phase.",
		"- When you are done, reply with one line: how many items and links you recorded.",
	].join("\n");
}

export const UAT_MODE_BANNER = [
	"[ASK-UAT — ACCEPTANCE]",
	"The operator is accepting behaviour on the page that is open in their browser.",
	"`uat_item` is active: create, link, amend, merge or drop acceptance items when asked.",
	"Do not write the ledger or edit code by hand — the page writes check events itself.",
].join("\n");

/** One-line status for the command notice. */
export function describeCounts(state: UatState): string {
	return `${state.counts.open} open · ${state.counts.checked} accepted · ${state.counts.pending} pending`;
}
