/**
 * compact-model feature — constants.
 *
 * The compact-model config lives in `<agent-dir>/pi-toolkits-compact.json`
 * (same agent-dir convention as the review/favorites stores) and holds a
 * single model key `"provider/id"` — see store.ts.
 */

/** Config file name inside the pi agent dir. */
export const COMPACT_FILE = "pi-toolkits-compact.json";

/** Footer status key shown while a compact model is configured. */
export const COMPACT_STATUS_KEY = "compact";
