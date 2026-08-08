/**
 * favorites feature — model favorites for pi.
 *
 * What it does:
 *  - Inside the /model selector (opened via /model or ctrl+l):
 *      * a hint row at the top shows the keys and the favorites-only state
 *      * ctrl+f toggles favorite on the currently selected model
 *      * ctrl+j toggles the "only favorites" filter
 *      * favorited model ids render in bold bright yellow
 *    The keys are consumed by the selector component only, so pi's editor
 *    bindings (ctrl+f cursor-right, ctrl+j newline) are untouched elsewhere.
 *  - ctrl+p / ctrl+shift+p keep their bindings but, once favorites exist
 *    (and cycleOnlyFavorites is not false), cycle only among favorited
 *    models instead of all models. ctrl+l / /model remain the escape hatch
 *    to pick any model.
 *  - Favorites persist to <agent-dir>/pi-toolkits-favorites.json (global
 *    across projects and sessions).
 *
 * Implementation: pi's extension API has no hook to render inside the
 * built-in model selector and cannot rebind the reserved ctrl+p actions, so
 * the feature patches two built-in prototypes at runtime:
 *  - ModelSelectorComponent (hint row, ctrl+f/ctrl+j, styling, filter)
 *  - AgentSession.cycleModel (favorites-only cycling)
 * Both patches are version-guarded (skip + warn if the API changed) and
 * idempotent across /reload.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { FAVORITES_STATUS_KEY } from "./constants.js";
import { applyCyclePatch } from "./patch-cycle.js";
import {
	applyModelSelectorPatches,
	setSelectorThemeProvider,
} from "./patch-selector.js";
import { getFavoritesStore } from "./store.js";

export function registerFavorites(pi: ExtensionAPI): void {
	// Live theme proxy shared with the built-in components (see theme.ts:
	// `theme` is a Proxy reading the current theme off globalThis). Captured
	// lazily from the first context; unavailable in non-TUI modes.
	let theme: Theme | undefined;

	const captureTheme = (ctx: ExtensionContext): void => {
		if (theme) return;
		try {
			const t = ctx.ui.theme;
			if (t) {
				theme = t;
				setSelectorThemeProvider(() => theme);
			}
		} catch {
			// No theme in this mode — selector styling degrades to stock.
		}
	};

	const updateFooterStatus = (ctx: ExtensionContext): void => {
		const count = getFavoritesStore().count();
		ctx.ui.setStatus(
			FAVORITES_STATUS_KEY,
			count > 0 && theme ? theme.fg("accent", `★ ${count}`) : undefined,
		);
	};

	// Latest context for live footer updates when favorites change in the
	// selector. setStatus is idempotent and re-synced on every session_start.
	let latestCtx: ExtensionContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		captureTheme(ctx);
		updateFooterStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		captureTheme(ctx);
		updateFooterStatus(ctx);
	});

	getFavoritesStore().subscribe(() => {
		if (latestCtx) updateFooterStatus(latestCtx);
	});

	// Patch built-in prototypes (each is internally version-guarded and
	// idempotent). Order doesn't matter — they touch different classes.
	applyModelSelectorPatches();
	applyCyclePatch();

	pi.registerCommand("favorites", {
		description: "List favorited models (add/remove with ctrl+F in /model)",
		handler: async (_args, ctx) => {
			captureTheme(ctx);
			const list = getFavoritesStore().list();
			if (list.length === 0) {
				ctx.ui.notify(
					"No favorited models. Open /model and press ctrl+F on a model to favorite it.",
					"info",
				);
				return;
			}
			const cycle = getFavoritesStore().getConfig().cycleOnlyFavorites
				? "on"
				: "off";
			ctx.ui.notify(
				`Favorites (${list.length}): ${list.join(", ")} — ctrl+p cycling: ${cycle}`,
				"info",
			);
		},
	});
}
