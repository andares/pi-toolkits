/**
 * favorites feature — constants.
 *
 * Keybindings are only active INSIDE the /model model selector (the
 * ModelSelectorComponent consumes input before the search box, see
 * patch-selector.ts). Outside the selector the default pi bindings are
 * untouched: ctrl+f stays "cursor right" in the editor, ctrl+j stays
 * "new line". ctrl+p/ctrl+shift+p keep their bindings — only the cycle
 * semantics change (patch-cycle.ts), so no keybinding conflicts arise.
 */
export const FAVORITES_STATUS_KEY = "favorites";

/** State file, written next to the auto-naming-session config convention. */
export const FAVORITES_FILE = "pi-toolkits-favorites.json";

/** Selector-scoped keybindings (only honored while the model selector is open). */
export const FAVORITE_TOGGLE_KEY = "ctrl+f";
export const FAVORITES_ONLY_KEY = "ctrl+j";

/**
 * Bold bright yellow — ANSI 16-color bright yellow (93) + bold (1).
 * Standard escape sequences that render in any terminal color mode
 * (16/256/truecolor), independent of the active pi theme.
 */
export const FAVORITE_STYLE_OPEN = "\x1b[1;93m";
export const STYLE_RESET = "\x1b[0m";

/** Wrap model id text in the bold-bright-yellow favorite style. */
export function styleFavorite(text: string): string {
	return `${FAVORITE_STYLE_OPEN}${text}${STYLE_RESET}`;
}
