/**
 * @andares/pi-toolkits — integrated pi extension entry point.
 *
 * Registers every feature module. Add new features by creating
 * src/features/<name>/ with a registerXxx(pi) export and calling it here.
 *
 * Current features:
 *  - ask — read-only Q&A mode (/ask)
 *  - favorites — model favorites (ctrl+F/ctrl+J in /model, favorites-only cycling)
 *  - stash — prompt stash (ctrl+alt+y swap / double-press stash-and-clear)
 *  - review — third-party code review with a configured review model (third-review)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsk } from "./features/ask/index.js";
import { registerFavorites } from "./features/favorites/index.js";
import { registerReview } from "./features/review/index.js";
import { registerStash } from "./features/stash/index.js";

export default function piToolkits(pi: ExtensionAPI): void {
	registerAsk(pi);
	registerFavorites(pi);
	registerReview(pi);
	registerStash(pi);
	// registerXxx(pi); // future features
}
