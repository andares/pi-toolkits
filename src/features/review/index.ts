/**
 * review feature — third-review command.
 *
 * After a development task finishes, "summon another model" to review the
 * just-completed work: the configured review model takes over the session
 * (full tool access — this is check AND fix, not a read-only audit), runs a
 * review turn, and the session then stays on that model (no auto-restore).
 *
 * Trigger: the /third-review slash command. (Bare-message keyword matching
 * was deliberately removed — a plain "third-review" message goes to the
 * model as ordinary text, so an accidental send can never start a review.)
 *
 * Review-model config lives in `<agent-dir>/pi-toolkits-review.json`
 * ("provider/id", see store.ts) and doubles as the picker default. Every
 * /third-review run opens the model picker (ctx.ui.select, same
 * getAvailable() source as /model) with the configured model as the FIRST
 * row — one Enter accepts it and starts the review. Picking a different
 * model persists it immediately (disk + in-memory) as the new default for
 * next time; cancelling aborts the review without changing anything. When
 * the configured model is gone/unavailable (e.g. deleted from pi's
 * models.json) the user is warned and the picker opens on the plain list.
 *
 * Guards: never fires while the agent is streaming (the review needs the
 * just-finished work as context) and never runs two reviews concurrently.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	modelKey,
	resolveConfiguredModel,
	type AvailableModel,
} from "../../lib/model-config.js";
import { REVIEW_STATUS_KEY } from "./constants.js";
import { REVIEW_PROMPT } from "./prompt.js";
import { getReviewStore, type ReviewStore } from "./store.js";

/**
 * Let the user pick a review model from the available list and persist the
 * choice. Returns the picked model, or undefined when cancelled/unavailable.
 *
 * The configured model is placed FIRST: the select dialog always highlights
 * its first row, so one Enter accepts the current default. Picking any other
 * model persists it (disk + in-memory) as the new default. The title shows
 * the current config, so /review-model doubles as a view-and-change entry
 * point; cancelling leaves the config untouched.
 */
export async function pickReviewModel(
	ctx: ExtensionContext,
	store: ReviewStore,
): Promise<AvailableModel | undefined> {
	// Dialog-capable UI exists in TUI and RPC modes (hasUI); json/print and
	// headless contexts have no dialogs, so fall back to a manual-config hint.
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"third-review: 当前环境不支持模型选择对话框，请编辑 <agent-dir>/pi-toolkits-review.json 手动配置。",
			"error",
		);
		return undefined;
	}
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify(
			"third-review: 当前没有可用模型，请先在 pi 中配置模型。",
			"error",
		);
		return undefined;
	}
	const configured = store.getModel();
	const configuredModel = resolveConfiguredModel(ctx, configured);
	// Configured model first → highlighted by default (Enter accepts it);
	// the rest keep the registry order.
	const ordered: AvailableModel[] = configuredModel
		? [
				configuredModel,
				...available.filter(
					(m) => modelKey(m) !== modelKey(configuredModel),
				),
			]
		: available;
	// Same display source as the /model selector: name + [provider]/id.
	const options = ordered.map(
		(m: AvailableModel) => `${m.name} (${m.provider}/${m.id})`,
	);
	const choice = await ctx.ui.select(
		configured
			? `选择评审模型 (当前: ${configured}，回车使用)`
			: "选择评审模型 (third-review)",
		options,
	);
	if (choice === undefined) {
		ctx.ui.notify("third-review: 已取消，评审模型配置未变更。", "info");
		return undefined;
	}
	const model = ordered[options.indexOf(choice)];
	if (!model) return undefined;
	const key = modelKey(model);
	if (key !== configured) {
		// Persist immediately (disk + in-memory + footer) — next run defaults here.
		store.setModel(key);
		ctx.ui.notify(
			`third-review: 评审模型已保存为「${model.name}」，下次默认使用。`,
			"info",
		);
	}
	return model;
}

/**
 * Create the third-review runner bound to a pi instance.
 *
 * Exported separately from registerReview so tests can drive the flow with
 * fake pi/ctx objects. The returned runner serializes concurrent triggers
 * (one review at a time).
 */
export function createReviewRunner(
	pi: ExtensionAPI,
): (ctx: ExtensionContext) => Promise<void> {
	let running = false;

	return async (ctx) => {
		if (running) {
			ctx.ui.notify("third-review: 评审已在执行中，请稍候。", "warning");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify(
				"third-review: 当前任务仍在进行中，请等待完成后再触发。",
				"warning",
			);
			return;
		}
		running = true;
		try {
			const store = getReviewStore();
			const configured = store.getModel();
			let model = resolveConfiguredModel(ctx, configured);
			if (!model) {
				ctx.ui.notify(
					configured
						? `third-review: 配置的评审模型 ${configured} 不存在或不可用，请重新选择。`
						: "third-review: 尚未配置评审模型，请选择。",
					"warning",
				);
			}
			if (ctx.hasUI) {
				// Always show the picker: the configured model is the first row
				// (one Enter accepts it); picking another persists it as default.
				model = await pickReviewModel(ctx, store);
				if (!model) return;
			} else if (!model) {
				// No dialogs (json/print/headless): the configured-model path keeps
				// working; without one, point at the config file.
				ctx.ui.notify(
					"third-review: 当前环境不支持模型选择对话框，请编辑 <agent-dir>/pi-toolkits-review.json 手动配置。",
					"error",
				);
				return;
			}
			const switched = await pi.setModel(model);
			if (!switched) {
				ctx.ui.notify(
					`third-review: 无法切换到评审模型「${model.name}」（缺少 API key 或鉴权未配置）。`,
					"error",
				);
				return;
			}
			ctx.ui.notify(
				`third-review: 已切换到评审模型「${model.name}」执行评审（查+修）；评审完成后会话保持该模型。`,
				"info",
			);
			pi.sendUserMessage(REVIEW_PROMPT);
		} finally {
			running = false;
		}
	};
}

export function registerReview(pi: ExtensionAPI): void {
	const runReview = createReviewRunner(pi);

	// Slash-command trigger — the only entry point (bare-message keyword
	// matching was removed to avoid accidental triggers). The handler awaits
	// the runner, which may block on the model picker and the review turn.
	pi.registerCommand("third-review", {
		description:
			"Summon the configured review model to review the just-completed work (check + fix)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await runReview(ctx);
		},
	});

	// Manual config entry point: view and change the review model. Always
	// opens the picker (title shows the current config); cancelling keeps
	// the existing config, so it is also safe as a view-only command.
	pi.registerCommand("review-model", {
		description:
			"Set or change the review model used by third-review (picker shows the current one)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await pickReviewModel(ctx, getReviewStore());
		},
	});

	// Footer indicator: muted "review" while a review model is configured.
	let theme: Theme | undefined;
	let latestCtx: ExtensionContext | undefined;

	const updateFooterStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(
			REVIEW_STATUS_KEY,
			getReviewStore().getModel() && theme
				? theme.fg("muted", "review")
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

	getReviewStore().subscribe(() => {
		if (latestCtx) updateFooterStatus(latestCtx);
	});
}
