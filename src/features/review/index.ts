/**
 * review feature — third-review command.
 *
 * After a development task finishes, "summon another model" to review the
 * just-completed work: the configured review model takes over the session
 * (full tool access — this is check AND fix, not a read-only audit), runs a
 * review turn, and the session then stays on that model (no auto-restore).
 *
 * Trigger paths (both share createReviewRunner()):
 *  - bare message: typing exactly "third-review" / "third review" in the
 *    input box (pi.on("input") interception, swallowed with "handled")
 *  - slash command: /third-review
 *
 * Review-model config lives in `<agent-dir>/pi-toolkits-review.json`
 * ("provider/id", see store.ts). When no model is configured, or the
 * configured model is gone/unavailable (e.g. deleted from pi's models.json),
 * the user is told the review model doesn't exist and is shown the available
 * model list (ctx.ui.select, same getAvailable() source as /model); the pick
 * is written back to the config and the review runs immediately.
 *
 * Guards: never fires while the agent is streaming (the review needs the
 * just-finished work as context) and never runs two reviews concurrently.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { REVIEW_STATUS_KEY } from "./constants.js";
import { REVIEW_PROMPT, isReviewTrigger } from "./prompt.js";
import { getReviewStore, modelKey, type ReviewStore } from "./store.js";

/** Resolve the configured review model against the available model list. */
export function resolveConfiguredModel(
	ctx: ExtensionContext,
	key: string | undefined,
): Model<Api> | undefined {
	if (!key) return undefined;
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return undefined;
	const provider = key.slice(0, slash);
	const id = key.slice(slash + 1);
	return ctx.modelRegistry
		.getAvailable()
		.find((m) => m.provider === provider && m.id === id);
}

/**
 * Let the user pick a review model from the available list and persist the
 * choice. Returns the picked model, or undefined when cancelled/unavailable.
 *
 * The picker title shows the current config so /review-model doubles as a
 * view-and-change entry point; cancelling leaves the config untouched.
 */
export async function pickReviewModel(
	ctx: ExtensionContext,
	store: ReviewStore,
): Promise<Model<Api> | undefined> {
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
	// Same display source as the /model selector: name + [provider]/id.
	const options = available.map((m) => `${m.name} (${m.provider}/${m.id})`);
	const choice = await ctx.ui.select(
		configured
			? `选择评审模型 (当前: ${configured})`
			: "选择评审模型 (third-review)",
		options,
	);
	if (choice === undefined) {
		ctx.ui.notify("third-review: 已取消，评审模型配置未变更。", "info");
		return undefined;
	}
	const model = available[options.indexOf(choice)];
	if (!model) return undefined;
	store.setModel(modelKey(model));
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
				model = await pickReviewModel(ctx, store);
				if (!model) return;
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

	// Bare-message trigger: "third-review" / "third review" in the input box.
	// Extension-injected messages are ignored so the runner's own prompts
	// never re-trigger this path.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}
		if (isReviewTrigger(event.text)) {
			// Fire-and-forget: the runner uses the live ctx proxy, so it is safe
			// after this handler returns. A session switch mid-dialog can make
			// the context assert-inactive; swallow that instead of leaking an
			// unhandled rejection (a fresh extension instance owns the new
			// session anyway).
			void runReview(ctx).catch((error) => {
				// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
				console.warn(
					"[pi-toolkits/review] third-review aborted:",
					error instanceof Error ? error.message : String(error),
				);
			});
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	// Slash-command trigger (pi resolves commands before the input event, so
	// the two paths never double-fire).
	pi.registerCommand("third-review", {
		description:
			"Summon the configured review model to review the just-completed work (check + fix)",
		handler: async (_args, ctx) => {
			await runReview(ctx);
		},
	});

	// Manual config entry point: view and change the review model. Always
	// opens the picker (title shows the current config); cancelling keeps
	// the existing config, so it is also safe as a view-only command.
	pi.registerCommand("review-model", {
		description:
			"Set or change the review model used by third-review (picker shows the current one)",
		handler: async (_args, ctx) => {
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

	pi.on("session_start", (_event, ctx) => {
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
