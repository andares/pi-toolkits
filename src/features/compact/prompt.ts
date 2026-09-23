/**
 * compact-model feature — summarization prompts.
 *
 * Every prompt below is copied VERBATIM from pi 0.87.1's built-in
 * compaction (dist/core/compaction/compaction.js and utils.js) so that
 * summaries produced by the configured compact model are formatted exactly
 * like pi's own compaction output. Only the executing model differs.
 *
 * Update these strings whenever pi changes its built-in prompts (diff
 * dist/core/compaction/compaction.js between versions).
 */

/** System prompt for every summarization call (pi 0.87.1 utils.js). */
export const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

/** First-connection history summary prompt (pi 0.87.1 compaction.js). */
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Iterative-update rules, used when a previous summary exists
 * (pi 0.87.1 compaction.js).
 */
export const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Full iterative-update prompt (leading sentence + rules, pi 0.87.1). */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/** Split-turn prefix checkpoint prompt (pi 0.87.1 compaction.js). */
export const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/**
 * Build the history-summary prompt text (pi 0.87.1 generateSummaryWithUsage):
 * conversation wrapped in tags, optional previous summary, then the base
 * prompt with the custom focus appended (`Additional focus: ...` — the exact
 * phrase pi's built-in compaction uses for /compact <instructions>).
 */
export function buildHistoryPromptText(
	conversationText: string,
	previousSummary: string | undefined,
	customInstructions: string | undefined,
): string {
	let basePrompt = previousSummary
		? UPDATE_SUMMARIZATION_PROMPT
		: SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;
	return promptText;
}

/**
 * Build the split-turn prefix prompt text (pi 0.87.1
 * generateTurnPrefixSummary): `# Conversation` block followed by
 * `# Instructions`.
 */
export function buildTurnPrefixPromptText(conversationText: string): string {
	return `# Conversation\n${conversationText}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}

/** File-operation sets extracted by pi's prepareCompaction. */
export interface FileOpsLike {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/**
 * Compute read/modified file lists from compaction file operations
 * (pi 0.87.1 utils.js computeFileLists): modified = written ∪ edited,
 * read-only = read minus modified, both sorted.
 */
export function computeFileLists(fileOps: FileOpsLike): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read]
		.filter((f) => !modified.has(f))
		.sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file lists as XML tags appended to the summary (pi 0.87.1 utils.js
 * formatFileOperations): sections joined by a blank line, prefixed by one.
 */
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(
			`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
		);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

/**
 * Combine two provider usage records field-wise (pi 0.87.1 compaction.js
 * combineUsage): used when a split turn produces two summarization calls.
 */
export function combineUsage<T extends UsageLike>(first: T, second: T): T {
	return {
		...first,
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? {
					cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0),
				}
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	} as T;
}

/** Structural view of pi's Usage record (the fields combineUsage touches). */
export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}
