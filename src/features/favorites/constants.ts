/**
 * favorites feature — constants.
 *
 * Keybindings are only active INSIDE the /model model selector (the
 * ModelSelectorComponent consumes input before the search box, see
 * patch-selector.ts). Outside the selector the default pi bindings are
 * untouched: ctrl+j stays "new line". ctrl+p/ctrl+shift+p keep their
 * bindings — only the cycle semantics change (patch-cycle.ts), so no
 * keybinding conflicts arise.
 *
 * Verified against pi 0.86.0 / 0.87.0 / 0.99.0 / 1.0.2 / 1.0.4 keybinding
 * tables + pi-tui input dispatch on WSL2 + Windows Terminal; re-run
 * `pnpm check:keybindings` after every host upgrade before trusting this.
 */
export const FAVORITES_STATUS_KEY = "favorites";

/** State file, written next to the auto-naming-session config convention. */
export const FAVORITES_FILE = "pi-toolkits-favorites.json";

/**
 * Selector-scoped keybindings (only honored while the model selector is open).
 *
 * Why ctrl+alt+f for the toggle (was ctrl+f through v0.6.0):
 *  - ctrl+f is consumed by the host in fullscreen mode, which became pi's
 *    default `tuiMode` in 1.0 (0.86–0.99 defaulted to `regular`, where the
 *    binding is inert). On Windows/WSL `tui.altScreen.search` resolves to
 *    ctrl+f, and `TuiAltScreen.handleViewportInput()` checks it before
 *    `shouldDeferViewportInputToOverlay()`, so the keystroke opens transcript
 *    search and the selector never sees it. Verified in pi-tui 1.0.4
 *    `dist/tui-alt-screen.js` (search check is the first key branch and
 *    returns `{ consume: true }` unconditionally).
 *  - alt+f is taken by `tui.editor.cursorWordRight` and `app.tree.unfoldOrDown`.
 *  - shift+f arrives as the literal character "F" without the kitty keyboard
 *    protocol, i.e. it would steal a typed character from the selector's
 *    search box.
 *  - ctrl+shift+f collapses to ctrl+f on Windows/WSL terminals (the reason
 *    pi itself binds search to ctrl+f there instead) and Windows Terminal
 *    binds it to its own Find action.
 *  - ctrl+alt+f is unclaimed across the whole 0.86–1.0 window (only
 *    `ctrl+alt+]` is taken from that family) and is byte-distinguishable from
 *    ctrl+f/alt+f without kitty (ESC + ctrl-f). Same family as the shipped
 *    stash key ctrl+alt+y, which is proven to reach pi on this terminal.
 *
 * ctrl+j is kept: no host layer consumes it before the selector, so it only
 * shadows `tui.input.newLine` inside the search box.
 */
export const FAVORITE_TOGGLE_KEY = "ctrl+alt+f";
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
