/**
 * UAT feature — the `record_change` tool.
 *
 * One call does two things that must not drift apart:
 *
 *   1. writes the prose change record with a canonical file name and a first
 *      line precise to the minute (the frame the operator asked for);
 *   2. appends a `candidate` event to the acceptance ledger — one sentence of
 *      user-visible behaviour, plus a 1-3 line test hint.
 *
 * The prose stays free-form: it is the agent's own reading material. The ledger
 * line is the bridge to UAT, and it is written *at implementation time*, when
 * the diff is still in context and describing "what can the operator now do"
 * costs one sentence. Reconstructing that weeks later, from a diff, is the
 * expensive and lossy path.
 *
 * Registered inactive; the feature activates it only in a project that
 * installed the framework (`.agents/framework/state.toml`).
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RECORD_CHANGE_TOOL } from "./constants.js";
import { appendEvent, ledgerPath, newEventId } from "./ledger.js";
import { createRecord } from "./records.js";
import { frameworkInstalled, frameworkMissing, resolveProjectRoot } from "./state.js";

const PARAMS = Type.Object({
	title: Type.String({
		description: "One line: what changed. Becomes the record's header.",
	}),
	body: Type.String({
		description:
			"The prose record: what was done, why, and the evidence (tests run, commands, files). Free-form Markdown; do not repeat the title as a heading.",
	}),
	behavior: Type.String({
		description:
			"One sentence describing the change as the operator experiences it: who does what and what they now see. No file names, function names or implementation detail.",
	}),
	hint: Type.Optional(
		Type.String({
			description:
				'How to verify it by hand, 1-3 lines. Write "none: <reason>" when the change has no user-visible effect (docs, refactor, dependency bump).',
		}),
	),
	area: Type.Optional(
		Type.String({ description: 'Short area label used for clustering, e.g. "ask-plan", "auth".' }),
	),
	files: Type.Optional(
		Type.Array(Type.String({ description: "File touched by this change." }), {
			description: "Main files touched. Used to spot records that overlap.",
		}),
	),
	spec: Type.Optional(
		Type.String({ description: "Spec this change implements, e.g. specs/ask-uat.md." }),
	),
	slug: Type.Optional(
		Type.String({ description: "ASCII slug for the file name. Defaults to the title." }),
	),
});

const DESCRIPTION = `Write the change record for the work just done, and register it for acceptance.

Creates .agents/implementations/YYYY-MM-DD_HHMM_<slug>.md (first line precise to the minute)
and appends one candidate entry to the acceptance ledger (.agents/uat/ledger.jsonl).

Call it once per completed change round, after the code is written and tested — not per file,
not per commit. The prose body is for later readers; the \`behavior\` sentence is what the
operator will see in the acceptance page.`;

const GUIDELINES = [
	"After finishing a change round in a project that has an agent framework, call `record_change` before reporting the work as done.",
	'Write `behavior` as one user-facing sentence — "the operator does X and now sees Y" — never as a code description; UAT clusters these sentences into acceptance items.',
	'When the change has no user-visible effect, say so: `hint: "none: <reason>"`. That is a recorded decision, not a missing field.',
	"Do not call `record_change` for exploratory work that was reverted; write it for what actually shipped.",
];

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

export interface RecordToolOptions {
	now?: () => Date;
	/** Resolve the project root (main worktree). Injectable for tests. */
	root?: (cwd: string) => string;
	/**
	 * Phase guard, not just a registration guard: read-only consult and planning
	 * must not acquire a project-writing tool merely because the framework exists.
	 */
	canRecord?: () => boolean;
}

export function registerRecordTool(pi: ExtensionAPI, options: RecordToolOptions = {}): void {
	const now = options.now ?? (() => new Date());
	const rootOf = options.root ?? resolveProjectRoot;

	pi.registerTool<typeof PARAMS, { id?: string; path?: string }>({
		name: RECORD_CHANGE_TOOL,
		label: "Record change",
		description: DESCRIPTION,
		promptSnippet: "Write the change record and register it for acceptance (framework projects only)",
		promptGuidelines: GUIDELINES,
		parameters: PARAMS,
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (options.canRecord && !options.canRecord()) {
				return errorResult(
					"record_change: disabled during read-only consult or planning — exit /ask, or approve the plan and finish the implementation first.",
				);
			}
			const root = rootOf(ctx.cwd || process.cwd());
			if (!frameworkInstalled(root)) {
				const missing = frameworkMissing(root);
				return errorResult(
					`record_change: the agent framework is incomplete (missing: ${missing.join(", ")}). Run /ask-init first, or write the record by hand.`,
				);
			}
			const title = params.title.trim();
			const behavior = params.behavior.trim();
			if (title === "") return errorResult("record_change: `title` is required.");
			if (behavior === "") {
				return errorResult(
					'record_change: `behavior` is required — one user-facing sentence, or say why there is none.',
				);
			}

			const at = now();
			let created;
			try {
				created = createRecord(root, {
					title,
					body: params.body,
					now: at,
					slug: params.slug,
				});
			} catch (error) {
				return errorResult(
					`record_change: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			appendEvent(ledgerPath(root), {
				v: 1,
				id: newEventId(at),
				// Ledger events order acceptance decisions; keep full precision even
				// though the human-facing record header is minute-precision.
				ts: at.toISOString(),
				type: "candidate",
				report: created.entry.id,
				title: created.entry.title,
				behavior,
				hint: params.hint?.trim() || undefined,
				area: params.area?.trim() || undefined,
				files: params.files?.filter((file) => file.trim() !== ""),
				spec: params.spec?.trim() || undefined,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${created.entry.path} (record ${created.entry.id}) and registered it for acceptance. It is pending until /ask-uat clusters it.`,
					},
				],
				details: { id: created.entry.id, path: created.entry.path },
			};
		},
	});
}
