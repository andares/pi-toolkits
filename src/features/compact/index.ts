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
 *  - prompts, message assembly, split-turn handling, output budgets, and the
 *    summary file-list tail are verbatim pi 0.87.1 built-in behavior — only
 *    the executing model differs
 *  - lossless fallback: unset config, unavailable model, empty/failed
 *    summary, or user abort → return undefined and pi's default compaction
 *    (session model) runs untouched. The extension can never make
 *    compaction worse than stock.
 *
 * Config lives in `<agent-dir>/pi-toolkits-compact.json` ("provider/id",
 * see store.ts). /compact-model views/changes/clears it; auto-compact paths
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
	maxTokens: number,
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
			maxTokens,
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
 * pi's output-budget formula (0.87.1 compaction.js): a fraction of
 * reserveTokens clamped by the model's own output cap.
 */
function summarizationBudget(
	fraction: number,
	reserveTokens: number,
	modelMaxTokens: number,
): number {
	return Math.min(
		Math.floor(fraction * reserveTokens),
		modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY,
	);
}

/**
 * Run the full compaction summarization with the configured model,
 * replicating pi 0.87.1's compact(): history summary (first-connection or
 * iterative-update prompt, custom focus appended), plus a separate
 * turn-prefix checkpoint when the cut point splits a turn, merged into one
 * summary with the file-list tail. Returns undefined on any failure after
 * notifying (pi default compaction then takes over).
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
		settings,
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
					summarizationBudget(
						0.8,
						settings.reserveTokens,
						model.maxTokens,
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
				),
				summarizationBudget(0.5, settings.reserveTokens, model.maxTokens),
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
				summarizationBudget(0.8, settings.reserveTokens, model.maxTokens),
				signal,
			);
			summaryText = history.text;
			usage = history.usage;
		}

		if (!summaryText.trim()) {
			if (!signal.aborted) {
				ctx.ui.notify(
					"compact-model: 压缩摘要为空，已回落 pi 默认压缩。",
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
			`compact-model: 压缩摘要失败（${message}），已回落 pi 默认压缩。`,
			"error",
		);
		return undefined;
	}
}

/**
 * Let the user pick a compact model (or clear the config) and persist the
 * choice. Mirrors review's pickReviewModel, plus a leading clear option.
 */
export async function pickCompactModel(
	ctx: ExtensionContext,
	store: CompactStore,
): Promise<AvailableModel | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"compact-model: 当前环境不支持模型选择对话框，请编辑 <agent-dir>/pi-toolkits-compact.json 手动配置。",
			"error",
		);
		return undefined;
	}
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify(
			"compact-model: 当前没有可用模型，请先在 pi 中配置模型。",
			"error",
		);
		return undefined;
	}
	const configured = store.getModel();
	const clearLabel = "✕ 清除配置（用 pi 默认压缩）";
	const options = [
		clearLabel,
		...available.map(
			(m: AvailableModel) => `${m.name} (${m.provider}/${m.id})`,
		),
	];
	const choice = await ctx.ui.select(
		configured
			? `选择压缩模型 (当前: ${configured})`
			: "选择压缩模型 (compact-model)",
		options,
	);
	if (choice === undefined) {
		ctx.ui.notify("compact-model: 已取消，压缩模型配置未变更。", "info");
		return undefined;
	}
	if (choice === clearLabel) {
		store.setModel(undefined);
		ctx.ui.notify(
			"compact-model: 已清除配置，压缩恢复 pi 默认（当前会话模型）。",
			"info",
		);
		return undefined;
	}
	const model = available[options.indexOf(choice) - 1];
	if (!model) return undefined;
	store.setModel(modelKey(model));
	ctx.ui.notify(
		`compact-model: 已设置压缩模型「${model.name}」，后续压缩总结将由它执行。`,
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
					`compact-model: 配置的压缩模型 ${configured} 不存在或不可用，已回落 pi 默认压缩。`,
					"warning",
				);
				return undefined;
			}
			return runCompactModelCompaction(ctx, event, model);
		},
	);

	// Config entry point: view, change, or clear the compact model.
	pi.registerCommand("compact-model", {
		description:
			"Set, change, or clear the dedicated model used for /compact summaries",
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
