/**
 * plan feedback — annotations → the message the agent receives.
 *
 * The template is deliberately fixed (and tested byte for byte): the agent
 * reads it, not a human, so a stable shape is what lets the planning prompt say
 * "address every block marked (modified)" and have that mean something. It is
 * English like every other runtime string.
 *
 * Two levels only, by design: global notes (about the plan as a whole) and
 * block notes (about one paragraph). There is no inline/range annotation, which
 * is what keeps the block model from needing re-anchoring after an edit.
 */
import { blockLabel, type Block } from "./blocks.js";
import type { DiffEntry } from "./diff.js";

export type AnnotationVerdict = "change" | "suggest" | "question";

export interface Annotation {
	verdict: AnnotationVerdict;
	comment: string;
}

export interface BlockAnnotations {
	blockId: string;
	annotations: Annotation[];
}

export interface FeedbackInput {
	decision: "approve" | "deny";
	version: number;
	totalVersions: number;
	/** Blocks of the annotated version. */
	blocks: readonly Block[];
	/** Diff of that version against its predecessor (empty for v1). */
	diff: readonly DiffEntry[];
	/** Blocks of the predecessor, for the "previous first line" quote. */
	previousBlocks?: readonly Block[];
	global: readonly Annotation[];
	perBlock: readonly BlockAnnotations[];
	/** The spec file the operator approved (path shown to the model). */
	planPath?: string;
	/** Approved revision text, quoted back so the model implements exactly this. */
	planText?: string;
}

const VERDICT_LABEL: Record<AnnotationVerdict, string> = {
	change: "change",
	suggest: "suggest",
	question: "question",
};

const STATUS_LABEL: Record<string, string> = {
	unchanged: "unchanged",
	moved: "moved",
	modified: "modified",
	added: "added",
	removed: "removed",
};

function countChanged(diff: readonly DiffEntry[]): number {
	return diff.filter((entry) => entry.status !== "unchanged").length;
}

function summarizeChanged(count: number): string {
	if (count === 0) return "no block changes";
	return `${count} block${count === 1 ? "" : "s"} changed`;
}

function annotationLines(annotations: readonly Annotation[]): string[] {
	return annotations
		.filter((annotation) => annotation.comment.trim() !== "")
		.map(
			(annotation) =>
				`- [${VERDICT_LABEL[annotation.verdict]}] ${annotation.comment.trim().replace(/\n+/g, " ")}`,
		);
}

/** Longest block excerpt quoted back — enough to locate it, not a second copy of the plan. */
const QUOTE_LIMIT = 600;

function quoteBlock(text: string): string {
	const trimmed = text.trim();
	const clipped =
		trimmed.length > QUOTE_LIMIT ? `${trimmed.slice(0, QUOTE_LIMIT)}…` : trimmed;
	// Every line of a blockquote needs the marker, otherwise the tail of a
	// multi-line paragraph escapes the quote and reads like instructions.
	return clipped
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

/**
 * Build the message for one decision. Approval without notes gets a short
 * instruction to start; approval with notes keeps the notes; denial always
 * carries at least one line telling the agent what to do next.
 */
export function buildFeedbackMarkdown(input: FeedbackInput): string {
	const changed = countChanged(input.diff);
	const header = `## Plan ${input.decision === "approve" ? "approved" : "feedback"} — v${input.version} of ${input.totalVersions} (${summarizeChanged(changed)})`;
	const byId = new Map(input.blocks.map((block) => [block.id, block]));
	const prevById = new Map((input.previousBlocks ?? []).map((block) => [block.id, block]));
	const diffById = new Map(input.diff.map((entry) => [entry.id, entry]));

	const sections: string[] = [];
	const globalLines = annotationLines(input.global);
	if (globalLines.length > 0) {
		sections.push(["### Global notes (apply to the whole plan)", ...globalLines].join("\n"));
	}

	// An annotation may arrive keyed by the block's PREVIOUS id (a tab that has
	// not refreshed, a block that was edited between review and submit). Resolve
	// through `prevId` instead of dropping the operator's note on the floor.
	const entryByPrevId = new Map(
		input.diff.flatMap((entry) => (entry.prevId ? [[entry.prevId, entry] as const] : [])),
	);

	const blockSections: string[] = [];
	for (const group of input.perBlock) {
		const viaPrevious = entryByPrevId.get(group.blockId);
		const blockId = byId.has(group.blockId) ? group.blockId : (viaPrevious?.id ?? group.blockId);
		const block = byId.get(blockId);
		const status = diffById.get(blockId)?.status ?? "unchanged";
		// Removed blocks stay visible in the review and remain annotatable; their
		// text comes from the previous revision. A genuinely unknown id is still
		// ignored (it cannot be rendered or meaningfully addressed).
		const source = block ?? (status === "removed" ? prevById.get(blockId) : undefined);
		if (!source) continue;
		const lines = annotationLines(group.annotations);
		if (lines.length === 0) continue;
		const anchor = status === "removed" ? "was in the previous revision" : `line ${source.line}`;
		const blockHeading = `#### ${anchor} · ${blockLabel(source, 100)} (${STATUS_LABEL[status] ?? status})`;
		// Quote the block itself, not its first line: two similar list items are
		// indistinguishable from a label alone, and the model edits files, so it
		// needs text it can search for. Removed blocks quote the old text.
		blockSections.push([blockHeading, quoteBlock(source.text), ...lines].join("\n"));
	}
	if (blockSections.length > 0) sections.push(["### Block notes (apply to the quoted block only)", ...blockSections].join("\n\n"));

	const body =
		sections.length > 0
			? sections.join("\n\n")
			: input.decision === "deny"
				? "No specific annotations were left — ask what should change before resubmitting."
				: "No notes were attached.";

	const instruction =
		input.decision === "approve"
			? [
				"The plan is approved: start implementing it now.",
				"Approval only means \"go\" — every annotation above still applies while you build.",
				"Record the implementation work in the todo list (`todo` tool) as you go, and update each entry",
				"as it starts, finishes or gets blocked, so progress stays traceable.",
			]
				.join("\n")
			: "Update the plan file to address every annotation above, then submit it again with plan_submit.";

	// On approval the model must implement the plan it was shown, not a stale
	// recollection of it: the file may have been edited after the last submit, so
	// quote the approved bytes back and name the path explicitly.
	const approvedPlan =
		input.decision === "approve" && input.planText !== undefined
			? [
					`### Approved plan (${input.planPath ?? "the plan file"})`,
					"",
					input.planText.trimEnd(),
				]
				.join("\n")
			: undefined;

	const parts = [header, "", body, "", instruction];
	if (approvedPlan) parts.push("", approvedPlan);
	return parts.join("\n");
}
