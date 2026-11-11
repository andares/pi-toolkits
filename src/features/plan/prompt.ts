/**
 * plan prompt — what the agent is told when plan mode opens.
 *
 * Two parts, both injected as a system-prompt block on every plan-mode turn:
 *
 *   1. the framing: what the phase allows (write markdown, read everything,
 *      ask questions) and the one rule that has no exception — the turn ends by
 *      asking a question or by submitting the plan, never by going quiet;
 *   2. the spec framework: a skill-style guide to the shape of a reviewable
 *      plan. It is deliberately a *default* shape, not a template to fill in:
 *      the operator reviews paragraphs, so the guide also explains how to write
 *      for paragraph-level review (one idea per block, headings on their own
 *      line, no blank lines inside a list) — that is the part models get wrong
 *      and the part that makes the browser review usable.
 *
 * Kept as a string constant rather than a bundled SKILL.md on purpose: a skill
 * description would be paid for on every request in every session, while this
 * text is only ever sent while plan mode is on.
 */

export const PLAN_MODE_BANNER = [
	"[ASK-PLAN — PLANNING]",
	"You are planning this change with the operator before any code is written.",
	"",
	"Allowed now: reading tools, bash for inspection, `ask_user_question`, and writing/editing",
	"markdown files inside the project. Not allowed: editing other files, destructive commands,",
	"or starting the implementation — that begins only after the plan is approved.",
	"",
	"Loop: explore → ask what the code cannot tell you → write the spec file → plan_submit.",
	"End every turn with either a question or a plan_submit call. Do not end it silently.",
].join("\n");

export const SPEC_FRAMEWORK_GUIDE = [
	"[ASK-PLAN — SPEC FRAMEWORK]",
	"Write the plan as one markdown file (convention: `specs/<slug>.md`) using roughly this shape.",
	"Adapt it: drop sections that do not apply, merge two when they are thin, but keep the order —",
	"the operator reads it top to bottom and reviews it paragraph by paragraph.",
	"",
	"1. `# SPEC: <name>` — one title line, what this change is.",
	"2. `## Context` — why now: the problem, what breaks without it.",
	"3. `## Goal` — the observable outcome, one paragraph, no implementation detail.",
	"4. `## Scope` — what is in and, explicitly, what is **not** (the cheapest way to avoid",
	"   scope creep in review).",
	"5. `## Decisions` — the points already settled, one line each with the reason (D1, D2, …).",
	"   A decision the operator made stays a decision; do not relitigate it in a later revision.",
	"6. `## Approach` — the design you recommend. One option, the one you would build.",
	"7. `## Data & contracts` — only when there is a schema, file format, endpoint or state machine.",
	"8. `## Files` — the files you will add or change, each with one line of responsibility.",
	"9. `## Milestones` — M1…Mn in build order, each with its own acceptance check, sized so that",
	"   one milestone is reviewable on its own.",
	"10. `## Verification` — how the result will be proven: tests to add, commands to run, manual",
	"    checks that must pass.",
	"11. `## Risks` — the three that actually worry you, each with the mitigation.",
	"12. `## Open questions` — numbered, each saying who has to answer it. An empty section is fine",
	"    and better than inventing questions.",
	"",
	"### Write for paragraph-level review",
	"The operator annotates **blocks** (paragraphs separated by a blank line), so the shape of the",
	"text is the shape of the review:",
	"- one idea per paragraph; if a paragraph needs two comments, it should be two paragraphs;",
	"- a heading sits alone on its line, never glued to the paragraph under it;",
	"- keep a list tight — no blank lines between items, so it stays one reviewable block;",
	"- fenced code blocks stay whole (they are one block, blank lines and all);",
	"- prefer direct statements over hedges: \"use X\" beats \"we could consider X\".",
	"",
	"### Revising after feedback",
	"Annotations arrive whatever the decision — approving means \"go\", not \"notes ignored\".",
	"When revising: change only the blocks that were annotated, keep the rest byte for byte, then",
	"call plan_submit again. A full rewrite makes the diff useless: every block turns red and the",
	"operator has to re-read the whole plan to find your three changes.",
].join("\n");

/** The complete plan-mode system-prompt block. */
export function buildPlanSystemPrompt(): string {
	return `${PLAN_MODE_BANNER}\n\n${SPEC_FRAMEWORK_GUIDE}`;
}

/**
 * One-shot kickoff text for `/ask-plan <topic>`: sets the task and points at the
 * framework without repeating it (it is already in the system prompt).
 */
export function buildPlanKickoff(topic: string | undefined): string {
	const subject = topic?.trim();
	return [
		"Start planning.",
		subject ? `Task: ${subject}` : "Task: the work we have been discussing in this session.",
		"",
		"Explore the code before writing, ask me what you cannot infer, then write the spec file and",
		"submit it with plan_submit. Do not implement anything yet.",
	].join("\n");
}
