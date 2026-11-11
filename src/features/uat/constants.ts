/**
 * UAT feature — names and limits in one place.
 *
 * The limits are about *legibility*, not throughput: an acceptance page that
 * shows sixty items is a page nobody reads. A run therefore clusters at most
 * `MAX_ITEMS_PER_RUN` items from at most `MAX_CANDIDATES_PER_RUN` records, and
 * says out loud how many records are still waiting.
 */
export const UAT_COMMAND = "ask-uat";
export const RECORD_CHANGE_TOOL = "record_change";
export const UAT_ITEM_TOOL = "uat_item";

/** Records fed to the clustering turn in one run. */
export const MAX_CANDIDATES_PER_RUN = 40;
/** New items a single clustering turn may create. */
export const MAX_ITEMS_PER_RUN = 12;

/** Close the page server after this long without a request (2 hours). */
export const UAT_IDLE_CLOSE_MS = 2 * 60 * 60 * 1000;
/** How often the server checks the ledger for changes written by another process. */
export const UAT_WATCH_MS = 1500;
/** Footer/status key (not rendered today; kept for symmetry with other features). */
export const UAT_STATUS_KEY = "uat-mode";
