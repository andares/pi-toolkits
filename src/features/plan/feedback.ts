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
		sections.push(["### Global", ...globalLines].join("\n"));
	}

	const blockSections: string[] = [];
	for (const group of input.perBlock) {
		const block = byId.get(group.blockId);
		if (!block) continue;
		const lines = annotationLines(group.annotations);
		if (lines.length === 0) continue;
		const status = diffById.get(block.id)?.status ?? "unchanged";
		const heading = `### Block: ${blockLabel(block)} (${STATUS_LABEL[status] ?? status})`;
		const previousId = diffById.get(block.id)?.prevId;
		const previous = previousId ? prevById.get(previousId) : undefined;
		const quote =
			status === "modified" && previous
				? [`> Previous first line: ${blockLabel(previous, 120)}`]
				: [];
		blockSections.push([heading, ...quote, ...lines].join("\n"));
	}
	if (blockSections.length > 0) sections.push(...blockSections);

	const body =
		sections.length > 0
			? sections.join("\n\n")
			: input.decision === "deny"
				? "No specific annotations were left — ask what should change before resubmitting."
				: "No notes were attached.";

	const instruction =
		input.decision === "approve"
			? "The plan is approved. Start implementing it now."
			: "Update the plan file to address every annotation above, then submit it again with plan_submit.";

	return [header, "", body, "", instruction].join("\n");
}
