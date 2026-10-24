/**
 * @andares/pi-toolkits — integrated pi extension entry point.
 *
 * Registers every feature module. Add new features by creating
 * src/features/<name>/ with a registerXxx(pi) export and calling it here.
 *
 * Current features:
 *  - ask — read-only Q&A mode (/ask)
 *  - favorites — model favorites (ctrl+A/ctrl+J in /model, favorites-only cycling)
 *  - stash — prompt stash (ctrl+alt+y swap / double-press stash-and-clear)
 *  - review — third-party code review with a configured review model (third-review)
 *  - compact — dedicated compact model for /compact + auto-compact summaries
 *  - autostart — replay project-declared slash commands at session start (/add-dir persistence)
 *  - permission — session-scoped boundary permission checks (/ask-perm)
 *
 * `ask` and `permission` are independent gates on one bus: each answers its own
 * question and the strictest answer wins, so they compose rather than replace
 * each other. The bus is installed once, after every gate is registered.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApprovalLog } from "./lib/approval-log.js";
import { createGateHub } from "./lib/gates.js";
import { registerAsk } from "./features/ask/index.js";
import { registerAutostart } from "./features/autostart/index.js";
import { registerCompact } from "./features/compact/index.js";
import { registerFavorites } from "./features/favorites/index.js";
import { registerPermission } from "./features/permission/index.js";
import { registerReview } from "./features/review/index.js";
import { registerStash } from "./features/stash/index.js";

export default function piToolkits(pi: ExtensionAPI): void {
	// One rolling audit sink for every gate. Creation is lazy and side-effect
	// free: the directory is only touched when the first record is written.
	const audit = createApprovalLog();
	const gates = createGateHub({ audit });

	registerAsk(pi, gates);
	// Permission registers its session_start reset before autostart, so a
	// project-declared `/ask-perm ...` runs against a freshly reset mode.
	registerPermission(pi, gates, { audit });
	registerAutostart(pi);
	registerCompact(pi);
	registerFavorites(pi);
	registerReview(pi);
	registerStash(pi);

	gates.install(pi);
}
