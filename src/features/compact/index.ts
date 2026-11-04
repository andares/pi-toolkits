/**
 * compact-model feature — dedicated model for context compaction.
 *
 * pi's /compact, auto-compact (threshold), and overflow-recovery compaction
 * all summarize with the CURRENT session model by default. This feature lets
 * a cheaper/faster model take over every summarization while the session
 * model stays focused on the conversation:
 *
 *  - takeover point: the `session_before_compact` extension event, which pi
 *    emits for ALL three trigger reasons (manual / threshold / overflow)
 *    before running its own compaction
 *  - prompts, message assembly, split-turn handling, summary budgets, and
 *    the summary file-list tail are verbatim pi built-in behavior (copied
 *    from 0.87.1; `core/compaction/compaction.js` stayed byte-identical
 *    1.0.0 → 1.3.0, 1.4.0 changed only the summary output budget and
 *    the split-turn focus handling mirrored below, and 1.5.0 left it
 *    untouched; the only mirrored helper that moved after that span is
 *    `combineUsage`, see prompt.ts) — only the executing
 *    model differs. The one exception is `serializeConversation`, which is
 *    imported from the host instead of mirrored, so it tracks whatever the
 *    running host does (1.2.0 stopped feeding assistant thinking into the
 *    request).
 *  - lossless fallback: unset config, unavailable model, empty/failed
 *    summary, or user abort → return undefined and pi's default compaction
 *    (session model) runs untouched. The extension can never make
 *    compaction worse than stock.
 *
 * Config lives in `<agent-dir>/pi-toolkits-compact.json` ("provider/id",
 * see store.ts). /compact-model opens the /model-style picker (configured
 * model preselected; picking persists); auto-compact paths
 * never open dialogs (handler only uses notify).
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	modelKey,
	resolveConfiguredModel,
	type AvailableModel,
} from "../../lib/model-config.js";
import { openModelPicker } from "../../lib/model-picker.js";
import { COMPACT_STATUS_KEY } from "./constants.js";
import {
	buildHistoryPromptText,
	buildTurnPrefixPromptText,
	combineUsage,
	computeFileLists,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	type UsageLike,
} from "./prompt.js";
import { getCompactStore, type CompactStore } from "./store.js";

/** Usage record type returned by ModelRegistry.complete(). */
type CompleteUsage = NonNullable<
	Awaited<ReturnType<ModelRegistry["complete"]>>["usage"]
>;

/** Thrown when a summarization response cannot safely become a checkpoint. */
class SummarizationFailureError extends Error {}

/**
 * One-shot summarization call through the configured compact model,
 * mirroring pi's completeSummarization options: signal honored, no prompt
 * cache writes, fresh routing session id.
 */
async function completeSummary(
	ctx: ExtensionContext,
	model: AvailableModel,
	promptText: string,
	signal: AbortSignal,
): Promise<{ text: string; usage: CompleteUsage }> {
	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				},
			],
		},
		{
			// No `maxTokens`: since pi 1.4.0 (#9512) the built-in compaction asks
			// for the model's own output limit instead of a fixed fraction of
			// reserveTokens, so a long reasoning block can no longer eat the cap
			// and fail the summary with "generation hit the token cap".
			signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
		},
	);
	// Same safety gates as the built-in compaction: an errored or
	// length-capped response is not a usable checkpoint, and a summarizer
	// that tries to call tools has gone off the rails.
	if (response.stopReason === "error" || response.stopReason === "length") {
		throw new SummarizationFailureError(
			response.stopReason === "error"
				? `Summarization failed: ${response.errorMessage ?? "unknown error"}`
				: "Summarization failed: generation hit the token cap and the summary is incomplete",
		);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new SummarizationFailureError(
			"Summarization attempted to call a tool",
		);
	}
	const text = response.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
	return { text, usage: response.usage };
}

/**
 * Run the full compaction summarization with the configured model,
 * replicating pi's compact() as of 1.4.0 (byte-identical to 0.87.1's shape
 * apart from the two 1.4.0 fixes adopted for the whole window, see below):
 * history summary (first-connection or iterative-update prompt, custom
 * focus appended), plus a separate turn-prefix checkpoint when the cut point
 * splits a turn, merged into one summary with the file-list tail. Returns
 * undefined on any failure after notifying (pi default compaction then takes
 * over).
 *
 * 1.4.0 changed two things this mirror covers, and we follow 1.4.0 for every
 * host in the supported window (1.2.0 → 1.5.0) because both are bug fixes
 * rather than behavior we could sensibly keep per version:
 *  - summaries no longer cap maxTokens at 0.8/0.5 × reserveTokens; the
 *    request omits maxTokens so the provider uses the model's output limit
 *    (#9512 — long reasoning made summaries fail with "generation hit the
 *    token cap"). `reserveTokens` now only decides when compaction starts.
 *  - `/compact <instructions>` also reaches the split-turn prefix summary
 *    (#11058; before 1.4.0 the focus was dropped when the split turn was the
 *    only new content).
 */
async function runCompactModelCompaction(
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
	model: AvailableModel,
): Promise<SessionBeforeCompactResult | undefined> {
	const { preparation, signal, customInstructions } = event;
	const {
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		firstKeptEntryId,
		previousSummary,
		fileOps,
	} = preparation;

	try {
		let summaryText: string;
		let usage: CompleteUsage | undefined;

		if (isSplitTurn && turnPrefixMessages.length > 0) {
			// Split turn: summarize history (if any) and the turn prefix
			// separately, then merge — exactly like the built-in compact().
			let historyText = previousSummary ?? "No prior history.";
			if (messagesToSummarize.length > 0) {
				const history = await completeSummary(
					ctx,
					model,
					buildHistoryPromptText(
						serializeConversation(convertToLlm(messagesToSummarize)),
						previousSummary,
						customInstructions,
					),
					signal,
				);
				historyText = history.text;
				usage = history.usage;
			}
			const turnPrefix = await completeSummary(
				ctx,
				model,
				buildTurnPrefixPromptText(
					serializeConversation(convertToLlm(turnPrefixMessages)),
					customInstructions,
				),
				signal,
			);
			summaryText = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix.text}`;
			usage = usage
				? combineUsage(
						usage as UsageLike,
						turnPrefix.usage as UsageLike,
					) as CompleteUsage
				: turnPrefix.usage;
		} else {
			const history = await completeSummary(
				ctx,
				model,
				buildHistoryPromptText(
					serializeConversation(convertToLlm(messagesToSummarize)),
					previousSummary,
					customInstructions,
				),
				signal,
			);
			summaryText = history.text;
			usage = history.usage;
		}

		if (!summaryText.trim()) {
			if (!signal.aborted) {
				ctx.ui.notify(
					"compact-model: the summary came back empty — falling back to pi's default compaction.",
					"warning",
				);
			}
			return undefined;
		}

		// File-list tail + details carry (pi does not auto-carry for
		// fromHook compactions — see plan), matching CompactionDetails shape.
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		summaryText += formatFileOperations(readFiles, modifiedFiles);

		return {
			compaction: {
				summary: summaryText,
				firstKeptEntryId,
				tokensBefore,
				usage,
				details: { readFiles, modifiedFiles },
			},
		};
	} catch (error) {
		// User abort is a clean cancel — pi handles the abort messaging.
		if (signal.aborted) return undefined;
		const message =
			error instanceof Error ? error.message : String(error);
		ctx.ui.notify(
			`compact-model: summarization failed (${message}) — falling back to pi's default compaction.`,
			"error",
		);
		return undefined;
	}
}

/**
 * Let the user pick a compact model with the /model-style picker and persist
 * the choice. Mirrors review's pickReviewModel.
 */
export async function pickCompactModel(
	ctx: ExtensionContext,
	store: CompactStore,
): Promise<AvailableModel | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"compact-model: this environment has no model picker dialog — edit <agent-dir>/pi-toolkits-compact.json to configure it manually.",
			"error",
		);
		return undefined;
	}
	const configured = store.getModel();
	const configuredModel = resolveConfiguredModel(ctx, configured);
	if (!configuredModel && configured) {
		ctx.ui.notify(
			`compact-model: the configured compact model ${configured} does not exist or is unavailable — pick another one.`,
			"warning",
		);
	}
	const model = await openModelPicker(ctx, configuredModel, {
		selectTitle:
			"Select the compaction model (first entry is the current default; press Enter to use it)",
	});
	if (!model) {
		ctx.ui.notify(
			"compact-model: cancelled — the compact model is unchanged. To clear the setting, edit <agent-dir>/pi-toolkits-compact.json and set model to null.",
			"info",
		);
		return undefined;
	}
	const key = modelKey(model);
	if (key !== configured) {
		// Persist immediately (disk + in-memory + footer) — next compaction uses it.
		store.setModel(key);
	}
	ctx.ui.notify(
		`compact-model: compact model set to "${model.name}" — it will run the next compaction summary.`,
		"info",
	);
	return model;
}

export function registerCompact(pi: ExtensionAPI): void {
	// Take over every compaction trigger (manual / threshold / overflow)
	// when a compact model is configured; otherwise stay invisible.
	pi.on(
		"session_before_compact",
		async (
			event: SessionBeforeCompactEvent,
			ctx: ExtensionContext,
		): Promise<SessionBeforeCompactResult | undefined> => {
			const configured = getCompactStore().getModel();
			if (!configured) return undefined;
			const model = resolveConfiguredModel(ctx, configured);
			if (!model) {
				ctx.ui.notify(
					`compact-model: the configured compact model ${configured} does not exist or is unavailable — falling back to pi's default compaction.`,
					"warning",
				);
				return undefined;
			}
			return runCompactModelCompaction(ctx, event, model);
		},
	);

	// Config entry point: view and change the compact model.
	pi.registerCommand("compact-model", {
		description:
			"Set or change the dedicated model used for /compact summaries",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await pickCompactModel(ctx, getCompactStore());
		},
	});

	// Footer indicator: muted "compact" while a compact model is configured.
	let theme: Theme | undefined;
	let latestCtx: ExtensionContext | undefined;

	const updateFooterStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(
			COMPACT_STATUS_KEY,
			getCompactStore().getModel() && theme
				? theme.fg("muted", "compact")
				: undefined,
		);
	};

	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		latestCtx = ctx;
		try {
			const t = ctx.ui.theme;
			if (t) {
				theme = t;
			}
		} catch {
			// No theme in this mode — footer indicator stays off.
		}
		updateFooterStatus(ctx);
	});

	getCompactStore().subscribe(() => {
		if (latestCtx) updateFooterStatus(latestCtx);
	});
}
