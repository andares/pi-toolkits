/**
 * prompt stash — pure state machine.
 *
 * One cache slot for one prompt. The hotkey (ctrl+alt+y — chosen for
 * compatibility across pi, Linux terminals, Windows Terminal and Windows OS,
 * see README) swaps the editor text with the stashed prompt:
 *
 *   press                    → stash current text, fill editor with old stash
 *   press again (later)      → toggles back (swap again)
 *   press twice quickly      → stash current text AND clear the editor
 *                              (the just-swapped-out prompt is discarded)
 *
 * With an empty stash, a single press already stashes the current text and
 * clears the editor (there is nothing to swap in).
 *
 * The double-press window is short (400ms) so two deliberate presses toggle
 * normally, while a quick double-tap performs the stash-and-clear action.
 */
import type { KeyId } from "@earendil-works/pi-tui";

/**
 * Stash hotkey.
 *
 * Compatibility rationale (verified against pi 0.84 keybindings, live
 * matchesKey probes and terminal/OS behavior):
 *  - pi: no default binding for ctrl+alt+<letter> (only ctrl+alt+] is taken);
 *    extension shortcuts dispatch first while the editor is focused
 *  - terminals: alt encodes as ESC-prefix, so ctrl+alt+y arrives as "\x1b\x19"
 *    and is distinguishable from ctrl+y WITHOUT kitty keyboard protocol
 *    (verified via matchesKey). ctrl+shift+<letter> was rejected because on
 *    terminals without kitty protocol it collapses to ctrl+<letter> — for m
 *    that is Enter, which would submit the prompt. Plain ctrl+<letter> is
 *    fully occupied by pi defaults or terminal control chars (ctrl+q is the
 *    only free one but carries XON flow-control baggage).
 *  - Windows Terminal: no default ctrl+alt+letter binding
 *  - Windows OS: only ctrl+alt+del is reserved at the system level
 *  - Linux desktops: ctrl+alt+t/l/d/arrows and F-keys (TTY) are taken; y is free
 */
export const STASH_KEY: KeyId = "ctrl+alt+y";

/** Two presses within this window count as the "stash and clear" action. */
export const STASH_DOUBLE_PRESS_MS = 400;

export interface StashPressResult {
	/** Text to place in the editor. */
	text: string;
	/** What this press did. */
	kind: "swap" | "stash-clear";
	/** Stash content after this press (for status/logging). */
	stashed: string;
}

export class PromptStash {
	private cache = "";
	private lastPressAt = 0;

	constructor(private readonly doublePressMs = STASH_DOUBLE_PRESS_MS) {}

	/**
	 * Handle one hotkey press with the given current editor text.
	 * `now` is injectable for deterministic tests.
	 */
	press(current: string, now = Date.now()): StashPressResult {
		if (this.lastPressAt !== 0 && now - this.lastPressAt <= this.doublePressMs) {
			// Double press: keep the just-stashed prompt in the cache and clear
			// the editor (discard the prompt that was momentarily swapped in).
			this.lastPressAt = 0;
			return { text: "", kind: "stash-clear", stashed: this.cache };
		}
		this.lastPressAt = now;
		const previous = this.cache;
		this.cache = current;
		return { text: previous, kind: "swap", stashed: current };
	}

	/** Current stash content without touching state. */
	peek(): string {
		return this.cache;
	}
}
