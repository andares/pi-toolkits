/**
 * stash feature — prompt stash.
 *
 * One hotkey (ctrl+alt+y) swaps the editor text with a single stashed
 * prompt; a quick double-press stashes the current prompt and clears the
 * editor (see stash.ts for the state machine and keybinding rationale).
 *
 * The shortcut is registered via pi.registerShortcut, which pi dispatches
 * FIRST while the editor is focused (CustomEditor.handleInput →
 * onExtensionShortcut) — exactly the prompt-input scenario. Selectors take
 * focus away from the editor, so the key is inert while a selector is open,
 * and it does not collide with any pi default binding.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PromptStash, STASH_KEY } from "./stash.js";

export function registerStash(pi: ExtensionAPI): void {
	const stash = new PromptStash();

	pi.registerShortcut(STASH_KEY, {
		description:
			"Stash prompt: swap editor text with the stashed prompt; press twice quickly to stash and clear the editor",
		handler: (ctx) => {
			const current = ctx.ui.getEditorText();
			const result = stash.press(current);
			ctx.ui.setEditorText(result.text);
		},
	});
}
