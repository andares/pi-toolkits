/**
 * /model-style model picker for extension features (review, compact-model).
 *
 * Reuses pi's REAL built-in ModelSelectorComponent via ctx.ui.custom instead
 * of ctx.ui.select: the extension select dialog (ExtensionSelectorComponent)
 * renders every option unbounded — with many models it overflows the
 * terminal — while ModelSelectorComponent is the actual /model experience:
 * height-limited scrolling list, fuzzy search, current-model marker.
 *
 * The component is driven through a small ModelRuntime facade backed by
 * ctx.modelRegistry (pi's extension-facing wrapper). SAFETY: verified
 * against pi 0.87.1 dist (modes/interactive/components/model-selector.js +
 * model-catalog-refresh.js) — the component only calls getAvailableSnapshot,
 * getModel, getError and refresh on modelRuntime, and ModelRegistry provides
 * exactly those (getAvailable/find/getError/refresh).
 *
 * `current` is passed as the component's currentModel: the built-in selector
 * preselects, ✓-marks and sorts-first its currentModel, so one Enter accepts
 * it. Enter resolves with the chosen model; Esc resolves undefined.
 */
import {
	ModelRuntime,
	ModelSelectorComponent,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AvailableModel } from "./model-config.js";

/** ModelRuntime facade backed by the extension-facing ModelRegistry. */
function modelRuntimeFacade(ctx: ExtensionContext): ModelRuntime {
	const facade = {
		getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
		getModel: (providerId: string, modelId: string) =>
			ctx.modelRegistry.find(providerId, modelId),
		getError: () => ctx.modelRegistry.getError(),
		refresh: (options?: { signal?: AbortSignal }) =>
			ctx.modelRegistry.refresh(options),
	};
	// SAFETY: the selector only touches the four members above (pi 0.87.1
	// model-selector.js); everything else on ModelRuntime is never reached
	// from this component.
	return facade as unknown as ModelRuntime;
}

/**
 * Open the /model-style picker. `current` (the preselected/default model) is
 * highlighted, ✓-marked and sorted first — one Enter accepts it. Resolves
 * with the picked model, or undefined when the user cancels. Requires a
 * dialog-capable UI (hasUI); resolves undefined otherwise.
 */
export async function openModelPicker(
	ctx: ExtensionContext,
	current?: AvailableModel,
): Promise<AvailableModel | undefined> {
	if (!ctx.hasUI) return undefined;
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify(
			"当前没有可用模型，请先在 pi 中配置模型。",
			"error",
		);
		return undefined;
	}
	return ctx.ui.custom<AvailableModel | undefined>(
		(tui, _theme, _keybindings, done) =>
			new ModelSelectorComponent(
				tui,
				current ?? ctx.model,
				modelRuntimeFacade(ctx),
				[],
				(model) => done(model),
				() => done(undefined),
			),
	);
}
