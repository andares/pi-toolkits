/**
 * review feature — persisted review-model config store.
 *
 * State lives in `<agent-dir>/pi-toolkits-review.json` (agent-dir from
 * getAgentDir(), same convention as the favorites store). The file holds a
 * single model key:
 *
 *   { "model": "anthropic/claude-sonnet-4" }
 *
 * Robustness mirrors the favorites store: corrupted/unreadable files fall
 * back to "no model configured" with a console.warn; writes are atomic
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
import { REVIEW_FILE } from "./constants.js";

/** Model identity used as the review-model key: "provider/id". */
export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export class ReviewStore {
	private model: string | undefined;
	private readonly file: string;
	private loaded = false;
	private readonly listeners = new Set<() => void>();

	constructor(file: string = join(getAgentDir(), REVIEW_FILE)) {
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
				"[pi-toolkits/review] Failed to load review config, starting unset:",
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
				"[pi-toolkits/review] Failed to save review config:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** The configured review model key ("provider/id"), or undefined. */
	getModel(): string | undefined {
		this.ensureLoaded();
		return this.model;
	}

	/** Set (or clear with undefined) the review model key and persist. */
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
				// A broken listener must not break review config handling.
			}
		}
	}
}

/**
 * Process-wide store shared by the runner and commands.
 *
 * Accessed via getReviewStore() (lazy) so tests can swap in an isolated
 * store via setSharedReviewStore().
 */
let sharedStore: ReviewStore | undefined;

export function getReviewStore(): ReviewStore {
	if (!sharedStore) {
		sharedStore = new ReviewStore();
	}
	return sharedStore;
}

/** Test hook — replace the shared store (e.g. with one backed by a temp file). */
export function setSharedReviewStore(store: ReviewStore): void {
	sharedStore = store;
}
