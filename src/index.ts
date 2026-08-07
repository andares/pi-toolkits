/**
 * @andares/pi-toolkits — integrated pi extension entry point.
 *
 * Registers every feature module. Add new features by creating
 * src/features/<name>/ with a registerXxx(pi) export and calling it here.
 *
 * Current features:
 *  - ask — read-only Q&A mode (/ask)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAsk } from "./features/ask/index.js";

export default function piToolkits(pi: ExtensionAPI): void {
  registerAsk(pi);
  // registerXxx(pi); // future features
}
