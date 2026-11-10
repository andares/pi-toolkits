/**
 * review feature — the /ask-review command.
 *
 * After a development task finishes, "summon another model" to review the
 * just-completed work: the configured review model takes over the session
 * (full tool access — this is check AND fix, not a read-only audit), runs a
 * review turn, and the session then stays on that model (no auto-restore).
 *
 * Trigger: the /ask-review slash command. `/third-review` stays registered as
 * a compatibility alias (same handler, same state, no separate behaviour).
 * Bare-message keyword matching was deliberately removed — a plain
 * "ask-review" message goes to the model as ordinary text, so an accidental
 * send can never start a review.
 *
 * Review-model config lives in `<agent-dir>/pi-toolkits-review.json`
 * ("provider/id", see store.ts) and doubles as the picker default. Every
 * /ask-review run opens the /model-style picker (the REAL built-in
 * ModelSelectorComponent — height-limited scrolling list + fuzzy search)
 * with the configured model preselected and ✓-marked: one Enter accepts it
 * and starts the review. Picking a different model persists it immediately
 * (disk + in-memory) as the new default for next time; cancelling aborts
 * the review without changing anything. When the configured model is
 * gone/unavailable (e.g. deleted from pi's models.json) the user is warned
 * and the picker opens without a preselection.
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
import { openModelPicker } from "../../lib/model-picker.js";
import { REVIEW_STATUS_KEY } from "./constants.js";
import { REVIEW_PROMPT } from "./prompt.js";
import { getReviewStore, type ReviewStore } from "./store.js";

/**
 * Canonical command name. Renamed from `third-review` when the `/ask-*` family
 * started taking shape (ask, ask-perm, ask-init, ask-review): new entry points
 * group under one prefix instead of scattering. Every user-visible notice,
 * dialog and doc says this name, so using the alias still teaches the new one.
 */
export const REVIEW_COMMAND = "ask-review";

/**
 * Compatibility alias, registered on purpose and delegating to the same
 * runner. Why it exists: older session notes, muscle memory and autostart
 * configs (`/third-review` in `.pi/autostart.toml`) keep working across the
 * rename — a renamed command that silently disappears would turn those config
 * entries into plain chat messages sent to the model. Delete this block once
 * the old spelling has been unused for a release or two.
 */
export const REVIEW_COMMAND_ALIAS = "third-review";

/**
 * Let the user pick a review model with the /model-style picker and persist
 * the choice. Returns the picked model, or undefined when cancelled.
 *
 * The configured model is the picker's default (preselected + ✓-marked +
 * first), so one Enter accepts it. Picking any other model persists it
 * (disk + in-memory) as the new default. /review-model doubles as a
 * view-and-change entry point; cancelling leaves the config untouched.
 */
export async function pickReviewModel(
	ctx: ExtensionContext,
	store: ReviewStore,
): Promise<AvailableModel | undefined> {
	// Dialog-capable UI exists in TUI and RPC modes (hasUI); json/print and
	// headless contexts have no dialogs, so fall back to a manual-config hint.
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`${REVIEW_COMMAND}: this environment has no model picker dialog — edit <agent-dir>/pi-toolkits-review.json to configure it manually.`,
			"error",
		);
		return undefined;
	}
	const configured = store.getModel();
	const configuredModel = resolveConfiguredModel(ctx, configured);
	if (!configuredModel && configured) {
		ctx.ui.notify(
			`${REVIEW_COMMAND}: the configured review model ${configured} does not exist or is unavailable — pick another one.`,
			"warning",
		);
	}
	const model = await openModelPicker(ctx, configuredModel, {
		selectTitle:
			"Select the review model (first entry is the current default; press Enter to use it)",
	});
	if (!model) {
		ctx.ui.notify(`${REVIEW_COMMAND}: cancelled — the review model is unchanged.`, "info");
		return undefined;
	}
	const key = modelKey(model);
	if (key !== configured) {
		// Persist immediately (disk + in-memory + footer) — next run defaults here.
		store.setModel(key);
		ctx.ui.notify(
			`${REVIEW_COMMAND}: review model saved as "${model.name}" — it will be the default next time.`,
			"info",
		);
	}
	return model;
}

/**
 * Create the /ask-review runner bound to a pi instance.
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
			ctx.ui.notify(`${REVIEW_COMMAND}: a review is already running — please wait.`, "warning");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify(
				`${REVIEW_COMMAND}: the current task is still running — wait for it to finish before starting a review.`,
				"warning",
			);
			return;
		}
		running = true;
		try {
			const store = getReviewStore();
			let model: AvailableModel | undefined;
			if (ctx.hasUI) {
				// Always show the /model-style picker: the configured model is
				// preselected (one Enter accepts it); picking another persists it.
				// (The unavailable-config warning lives inside pickReviewModel.)
				model = await pickReviewModel(ctx, store);
				if (!model) return;
			} else {
				// No dialogs (json/print/headless): the configured-model path keeps
				// working; without one, point at the config file.
				model = resolveConfiguredModel(ctx, store.getModel());
				if (!model) {
					ctx.ui.notify(
						`${REVIEW_COMMAND}: this environment has no model picker dialog — edit <agent-dir>/pi-toolkits-review.json to configure it manually.`,
						"error",
					);
					return;
				}
			}
			const switched = await pi.setModel(model);
			if (!switched) {
				ctx.ui.notify(
					`${REVIEW_COMMAND}: cannot switch to the review model "${model.name}" (missing API key or auth not configured).`,
					"error",
				);
				return;
			}
			ctx.ui.notify(
				`${REVIEW_COMMAND}: switched to the review model "${model.name}" for this review (check + fix); the session stays on it afterwards.`,
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

	// Slash-command triggers. The handler awaits the runner, which may block on
	// the model picker and the review turn. `ask-review` is canonical;
	// `third-review` is registered only as a compatibility alias (see the
	// constant's comment) — both reach the same runner and the same guards.
	pi.registerCommand(REVIEW_COMMAND, {
		description:
			"Pick the review model (defaults to the configured one) and review the just-completed work (check + fix)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await runReview(ctx);
		},
	});

	pi.registerCommand(REVIEW_COMMAND_ALIAS, {
		description: "Same as /ask-review (compatibility alias)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await runReview(ctx);
		},
	});

	// Manual config entry point: view and change the review model. Always
	// opens the /model-style picker (configured model preselected); cancelling
	// keeps the existing config, so it is also safe as a view-only command.
	pi.registerCommand("review-model", {
		description:
			"Set or change the review model used by /ask-review (picker preselects the current one)",
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
