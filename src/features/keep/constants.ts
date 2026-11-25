/**
 * keep feature — constants shared by the ledger, the commands and the picker.
 *
 * Two custom entry types are written into the session file itself:
 *   - `keep:unfinished` is the breadcrumb appended by `/keep-quit` (display
 *     only, out of the model context) and the marker `rebuild` looks for in a
 *     session tail;
 *   - `keep:notice` carries the one-line startup notice, rendered through
 *     `registerEntryRenderer` so `ui.invalidate()` cannot wipe it.
 *
 * `keep:resume` is a `custom_message`, not an entry: it must reach the model
 * (the note left at quit time is the whole point of coming back).
 */
import type { KeyId } from "@earendil-works/pi-tui";

/** Breadcrumb entry appended when a session is kept. */
export const KEEP_ENTRY = "keep:unfinished";
/** Startup notice entry (rendered, never sent to the model). */
export const KEEP_NOTICE_ENTRY = "keep:notice";
/** Resume note message injected into the loaded session. */
export const KEEP_RESUME_ENTRY = "keep:resume";

/** `<agent-dir>/pi-toolkits-keep/keep.jsonl`. */
export const KEEP_DIR = "pi-toolkits-keep";
export const KEEP_LEDGER_FILE = "keep.jsonl";

/**
 * Drop the highlighted row without loading it.
 *
 * `ctrl+r` is free where we need it: the host binds it to
 * `app.session.rename` inside its own session selector, and to nothing in
 * `tui.altScreen.*` (the bindings that preempt a dialog) or in the global
 * table. Our picker owns its own component, so it consumes the key itself.
 * Re-audited with `pnpm check:keybindings ctrl+r` — see the feature section in
 * AGENTS.md for the re-check obligation on host upgrades.
 */
export const KEEP_DROP_KEY: KeyId = "ctrl+r";

/** Rows shown before the list scrolls. */
export const KEEP_MAX_ROWS = 12;
/** Note length cap: a note is a reminder, not a summary. */
export const KEEP_NOTE_MAX = 60;
/** Bytes read from the end of a session file when rebuilding the ledger. */
export const KEEP_TAIL_BYTES = 16 * 1024;
