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
 * Verified against pi 0.87.0 / 0.99.0 / 1.0.4 / 1.1.0 keybinding
 * tables + pi-tui input dispatch on WSL2 + Windows Terminal; re-run
 * `pnpm check:keybindings` after every host upgrade before trusting this.
 */
export const FAVORITES_STATUS_KEY = "favorites";

/** State file, written next to the auto-naming-session config convention. */
export const FAVORITES_FILE = "pi-toolkits-favorites.json";

/**
 * Selector-scoped keybindings (only honored while the model selector is open).
 *
 * Toggle key history: ctrl+f (through v0.6.0) → ctrl+alt+f (discarded before
 * release) → ctrl+a (current). Each step is a real layer the previous pick
 * missed — audit trail below; re-run `pnpm check:keybindings` on upgrades.
 *
 * Why ctrl+f is dead: fullscreen became pi's default `tuiMode` in 1.0
 * (0.87–0.99 defaulted to `regular`, where the binding is inert). On
 * Windows/WSL `tui.altScreen.search` resolves to ctrl+f, and
 * `TuiAltScreen.handleViewportInput()` checks it before
 * `shouldDeferViewportInputToOverlay()`, so the keystroke opens transcript
 * search and the selector never sees it (verified in pi-tui 1.1.0
 * `dist/tui-alt-screen.js`: the search check is the first key branch and
 * returns `{ consume: true }` unconditionally).
 *
 * Why ctrl+alt+f was discarded: clean at the pi layer across 0.87–1.1 (only
 * ctrl+alt+] is taken from that family) and byte-distinguishable without
 * kitty — but grabbed at the OS/app layer on the author's machine by a
 * Windows screenshot tool, so it never reached the terminal. Lesson: a key
 * that is free in the host table is not necessarily free on the machine.
 *
 * Why ctrl+a (letter taken from "favorite", audited with the host's own
 * matchesKey on WSL2 + Windows Terminal):
 *  - f: consumed upstream by `tui.altScreen.search` in fullscreen (above).
 *  - v: free at the pi layer on WSL (`app.clipboard.pasteImage` is alt+v
 *    there) but Windows Terminal binds ctrl+v to paste — and pasting a model
 *    name into the search box is a feature, not a slot to steal.
 *  - o / r / t: host-owned at the app layer (`app.tools.expand`,
 *    `app.session.rename`, `app.thinking.toggle`).
 *  - i: byte-identical to Tab on non-kitty terminals ("\t"), and Tab is the
 *    selector's built-in scope toggle — a guaranteed fight.
 *  - e: viable (shadows only `tui.editor.cursorLineEnd` inside the selector)
 *    but carries no mnemonic; a was preferred.
 *  - a: shadows only `tui.editor.cursorLineStart` (readline home) inside the
 *    selector — our patch consumes it before the search box, exactly like
 *    ctrl+j shadows newLine. No upstream consumer, nothing bound at the
 *    Windows Terminal / Windows OS layer, no other loaded extension claims
 *    it, and "a" reads as *add favorite*.
 *  (Rejected elsewhere: alt+f = cursorWordRight + tree unfold; shift+f is
 *  the literal character "F" without kitty, stealing typed search text;
 *  ctrl+shift+f collapses to ctrl+f on Windows/WSL and is Windows Terminal's
 *  own Find.)
 *
 * ctrl+j is kept: no host layer consumes it before the selector, so it only
 * shadows `tui.input.newLine` inside the search box.
 */
export const FAVORITE_TOGGLE_KEY = "ctrl+a";
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
