/**
 * init feature — the one framework-owned region inside `AGENTS.md`.
 *
 * The workflow block is delimited by HTML comments. Matching must be strict:
 * documentation often *shows* these markers as inline code, and a plain
 * `indexOf` would treat such an example as the real block and replace the
 * surrounding prose. Markers therefore have to occupy a whole line, sit outside
 * a fenced code block, and come in exactly one matching pair.
 */
import { WORKFLOW_BLOCK_BEGIN, WORKFLOW_BLOCK_END } from "./spec.js";

export type BlockStatus =
	| "current"
	| "updated"
	| "inserted"
	| "malformed"
	| "hand-written"
	| "missing-agents";

/** What an existing file looks like; `missing-agents` is a file-level fact. */
export type WorkflowStatus =
	| "current"
	| "stale"
	| "missing"
	| "malformed"
	| "hand-written"
	| "missing-agents";

interface LineSpan {
	readonly start: number;
	/** Offset just after the line's newline (or the end of the text). */
	readonly end: number;
	readonly text: string;
}

const BEGIN_RE = /^<!--\s*ask-init:begin workflow\b[^\n]*-->\s*$/;
const END_RE = /^<!--\s*ask-init:end workflow\s*-->\s*$/;
const FENCE_RE = /^\s*(```+|~~~+)/;

/**
 * Lines outside fenced code blocks, with their byte offsets. The fence lines
 * themselves are skipped; a marker cannot share a line with them.
 */
function linesOutsideFences(text: string): LineSpan[] {
	const out: LineSpan[] = [];
	const raw = text.split("\n");
	let offset = 0;
	let fence: string | undefined;
	for (let index = 0; index < raw.length; index += 1) {
		const line = raw[index];
		const start = offset;
		const hasNewline = index < raw.length - 1;
		const end = start + line.length + (hasNewline ? 1 : 0);
		offset = end;
		const visible = line.endsWith("\r") ? line.slice(0, -1) : line;
		const fenceMatch = FENCE_RE.exec(visible);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (fence) continue;
		out.push({ start, end, text: visible });
	}
	return out;
}

type Located =
	| { kind: "none" }
	| { kind: "malformed"; reason: string }
	| { kind: "found"; begin: LineSpan; end: LineSpan };

/** Locate exactly one marker pair; anything ambiguous is malformed. */
export function locateWorkflowBlock(text: string): Located {
	const lines = linesOutsideFences(text);
	const begins = lines.filter((line) => BEGIN_RE.test(line.text));
	const ends = lines.filter((line) => END_RE.test(line.text));
	if (begins.length === 0 && ends.length === 0) return { kind: "none" };
	if (begins.length === 0 || ends.length === 0) {
		return {
			kind: "malformed",
			reason: begins.length === 0 ? "end marker without begin marker" : "begin marker without end marker",
		};
	}
	if (begins.length > 1 || ends.length > 1) {
		return { kind: "malformed", reason: "more than one workflow marker pair" };
	}
	const begin = begins[0];
	const end = ends[0];
	if (end.start < begin.start) {
		return { kind: "malformed", reason: "end marker appears before the begin marker" };
	}
	return { kind: "found", begin, end };
}

/**
 * Replace the block between a valid marker pair, or insert it. Any malformed
 * marker layout returns the input untouched so prose can never be damaged.
 */
export function applyWorkflowBlock(
	text: string,
	block: string,
): { text: string; status: Exclude<BlockStatus, "missing-agents"> } {
	const located = locateWorkflowBlock(text);
	if (located.kind === "malformed") return { text, status: "malformed" };
	if (located.kind === "found") {
		const suffix = text.slice(located.end.end);
		// Keep the final newline when the block is the last content: dropping it
		// makes every second refresh look like an update.
		const next = `${text.slice(0, located.begin.start)}${block.trimEnd()}${
			suffix.length === 0 && text.endsWith("\n") ? "\n" : suffix
		}`;
		return { text: next, status: next === text ? "current" : "updated" };
	}

	const appendix = linesOutsideFences(text).find((line) =>
		/^##[ \t]+(?:附录|appendix)(?:[ \t]|$)/i.test(line.text),
	);
	// A project may have written its own workflow section. Do not append a
	// second one: report it and let the operator add markers or remove it.
	const handWritten = linesOutsideFences(text).some((line) =>
		/^##[ \t]+Ask workflow\b/i.test(line.text),
	);
	if (handWritten) return { text, status: "hand-written" };
	if (appendix) {
		return {
			text: `${text.slice(0, appendix.start)}${block.trimEnd()}\n\n${text.slice(appendix.start)}`,
			status: "inserted",
		};
	}
	if (text.trim() === "") return { text: `${block.trimEnd()}\n`, status: "inserted" };
	return { text: `${text.trimEnd()}\n\n${block.trimEnd()}\n`, status: "inserted" };
}

/** Inspect a present AGENTS.md without changing it. */
export function inspectWorkflowBlock(
	text: string,
	expected: string,
): { status: Exclude<WorkflowStatus, "missing-agents">; reason?: string } {
	const located = locateWorkflowBlock(text);
	if (located.kind === "malformed") return { status: "malformed", reason: located.reason };
	if (located.kind === "found") {
		const actual = text.slice(located.begin.start, located.end.end).trimEnd();
		return { status: actual === expected.trimEnd() ? "current" : "stale" };
	}
	const handWritten = linesOutsideFences(text).some((line) =>
		/^##[ \t]+Ask workflow\b/i.test(line.text),
	);
	if (handWritten) {
		return {
			status: "hand-written",
			reason: "a hand-written 'Ask workflow' section exists without the managed markers",
		};
	}
	return { status: "missing" };
}

export { WORKFLOW_BLOCK_BEGIN, WORKFLOW_BLOCK_END };
