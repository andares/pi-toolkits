/**
 * whats-new feature — persisted "which version has the operator seen" state.
 *
 * State lives in `<agent-dir>/pi-toolkits-whats-new.json` (agent-dir from
 * getAgentDir(), same convention as the other feature stores):
 *
 *   { "lastSeenVersion": "0.13.0" }
 *
 * `lastSeenVersion` is the highest version whose notes were already handled —
 * shown, or recorded silently because this is a fresh install. A missing field
 * means a fresh install: there is no previous version to report from.
 *
 * Robustness: a missing file means defaults, a corrupted file falls back to
 * defaults with one warning, writes are atomic (tmp + rename) and never throw.
 * A failed write only means the notice may appear once more; it must never
 * block a session.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WHATS_NEW_FILE } from "./constants.js";
import { parseVersion } from "./version.js";

export interface WhatsNewState {
	/** Highest version already handled; absent on a fresh install. */
	lastSeenVersion?: string;
}

export const DEFAULT_STATE: WhatsNewState = {};

/** Coerce an unknown JSON blob into state (defaults for gaps). */
export function normalizeState(input: unknown): WhatsNewState {
	const state: WhatsNewState = { ...DEFAULT_STATE };
	if (!input || typeof input !== "object") return state;
	const raw = input as Partial<WhatsNewState>;
	if (
		typeof raw.lastSeenVersion === "string" &&
		parseVersion(raw.lastSeenVersion) !== undefined
	) {
		state.lastSeenVersion = raw.lastSeenVersion;
	}
	return state;
}

export class WhatsNewStore {
	private state: WhatsNewState = { ...DEFAULT_STATE };
	private readonly file: string;
	private loaded = false;

	constructor(file: string = join(getAgentDir(), WHATS_NEW_FILE)) {
		this.file = file;
	}

	/** Path of the JSON file. */
	get path(): string {
		return this.file;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(this.file)) return;
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			this.state = normalizeState(parsed);
		} catch (error) {
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/whats-new] Failed to load state, using defaults:",
				error instanceof Error ? error.message : String(error),
			);
			this.state = { ...DEFAULT_STATE };
		}
	}

	/** Current state (a copy). */
	get(): WhatsNewState {
		this.ensureLoaded();
		return { ...this.state };
	}

	/** Remember that `version` was handled. */
	markSeen(version: string): void {
		this.ensureLoaded();
		if (parseVersion(version) === undefined) return;
		this.state.lastSeenVersion = version;
		this.save();
	}

	/** Atomically persist (tmp + rename). Never throws. */
	private save(): void {
		try {
			const dir = dirname(this.file);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
			renameSync(tmp, this.file);
		} catch (error) {
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/whats-new] Failed to save state:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}
