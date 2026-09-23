/**
 * compact-model feature — persisted compact-model config store.
 *
 * State lives in `<agent-dir>/pi-toolkits-compact.json` (agent-dir from
 * getAgentDir(), same convention as the review store). The file holds a
 * single model key:
 *
 *   { "model": "google/gemini-2.5-flash" }
 *
 * Unset = feature disabled: every compaction (manual /compact, auto-compact
 * threshold, overflow recovery) uses pi's default behavior with the current
 * session model, zero overhead.
 *
 * Robustness mirrors the review store: corrupted/unreadable files fall back
 * to "no model configured" with a console.warn; writes are atomic
 * (tmp + rename) and never throw.
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
import { COMPACT_FILE } from "./constants.js";

export class CompactStore {
	private model: string | undefined;
	private readonly file: string;
	private loaded = false;
	private readonly listeners = new Set<() => void>();

	constructor(file: string = join(getAgentDir(), COMPACT_FILE)) {
		this.file = file;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(this.file)) return;
			const raw = readFileSync(this.file, "utf8");
			const parsed = JSON.parse(raw) as { model?: unknown };
			if (
				parsed &&
				typeof parsed.model === "string" &&
				parsed.model.includes("/")
			) {
				this.model = parsed.model;
			}
		} catch (error) {
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/compact] Failed to load compact-model config, starting unset:",
				error instanceof Error ? error.message : String(error),
			);
			this.model = undefined;
		}
	}

	/** Atomically persist (tmp + rename). Never throws. */
	save(): void {
		try {
			const dir = dirname(this.file);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const tmp = `${this.file}.tmp`;
			writeFileSync(
				tmp,
				`${JSON.stringify({ model: this.model ?? null }, null, 2)}\n`,
				"utf8",
			);
			renameSync(tmp, this.file);
		} catch (error) {
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/compact] Failed to save compact-model config:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** The configured compact model key ("provider/id"), or undefined. */
	getModel(): string | undefined {
		this.ensureLoaded();
		return this.model;
	}

	/** Set (or clear with undefined) the compact model key and persist. */
	setModel(key: string | undefined): void {
		this.ensureLoaded();
		this.model = key;
		this.save();
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A broken listener must not break compact config handling.
			}
		}
	}
}

/**
 * Process-wide store shared by the session_before_compact handler and the
 * /compact-model command.
 *
 * Accessed via getCompactStore() (lazy) so tests can swap in an isolated
 * store via setSharedCompactStore().
 */
let sharedStore: CompactStore | undefined;

export function getCompactStore(): CompactStore {
	if (!sharedStore) {
		sharedStore = new CompactStore();
	}
	return sharedStore;
}

/** Test hook — replace the shared store (e.g. with one backed by a temp file). */
export function setSharedCompactStore(store: CompactStore): void {
	sharedStore = store;
}
