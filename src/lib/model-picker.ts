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
 *
 * Non-TUI dialog modes (rpc) cannot host custom components — pi's rpc
 * ui.custom() resolves undefined immediately — so the host-rendered
 * ctx.ui.select is used there with the default as the first option
 * (ExtensionContext.mode docs: "Use 'tui' to guard terminal-only UI such as
 * custom components").
 */
import {
	ModelRuntime,
	ModelSelectorComponent,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { modelKey, type AvailableModel } from "./model-config.js";

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
 * Open the picker. `current` (the preselected/default model) is highlighted
 * and ✓-marked in TUI mode — one Enter accepts it. In dialog-capable modes
 * without custom-component support (rpc), the host renders a plain selector
 * instead, with `current` as the first option (Enter accepts it too).
 * Resolves with the picked model, or undefined when the user cancels.
 */
export async function openModelPicker(
	ctx: ExtensionContext,
	current?: AvailableModel,
	options?: { selectTitle?: string },
): Promise<AvailableModel | undefined> {
	if (!ctx.hasUI) return undefined;
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("当前没有可用模型，请先在 pi 中配置模型。", "error");
		return undefined;
	}
	if (ctx.mode === "tui") {
		// The real built-in /model component: height-limited scrolling list +
		// fuzzy search (ctx.ui.select renders every option unbounded).
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
	// rpc and other dialog-capable modes: custom components are TUI-only
	// (rpc's ui.custom() resolves undefined immediately), but the host
	// renders select dialogs itself — default first so Enter accepts it.
	const ordered: AvailableModel[] = current
		? [
				current,
				...available.filter((m) => modelKey(m) !== modelKey(current)),
			]
		: available;
	const labels = ordered.map(
		(m: AvailableModel) => `${m.name} (${m.provider}/${m.id})`,
	);
	const choice = await ctx.ui.select(
		options?.selectTitle ?? "选择模型（首项为当前默认，回车使用）",
		labels,
	);
	if (choice === undefined) return undefined;
	return ordered[labels.indexOf(choice)];
}
