/**
 * favorites feature — persisted favorites store.
 *
 * State lives in `<agent-dir>/pi-toolkits-favorites.json` (agent-dir from
 * getAgentDir(), same convention as @cnife/pi-auto-naming-session's config
 * file). Favorites are global across projects and sessions.
 *
 * File shape:
 *   {
 *     "favorites": ["anthropic/claude-sonnet-4", "openrouter/openai/gpt-5"],
 *     "config": { "cycleOnlyFavorites": true }
 *   }
 *
 * `cycleOnlyFavorites` (default true) gates the ctrl+p favorites-only
 * cycling behavior — set it to false in the JSON to restore full cycling.
 *
 * Robustness: corrupted/unreadable files fall back to an empty set + default
 * config with a console.warn; writes are atomic (tmp file + rename) and
 * failures are logged, never thrown.
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
import { FAVORITES_FILE } from "./constants.js";

export interface FavoritesConfig {
	/** When true (default), ctrl+p / ctrl+shift+p cycle only favorited models. */
	cycleOnlyFavorites: boolean;
}

export interface FavoritesSnapshot {
	favorites: string[];
	config: FavoritesConfig;
}

const DEFAULT_CONFIG: FavoritesConfig = { cycleOnlyFavorites: true };

/** Model identity used as the favorites key: "provider/id". */
export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export class FavoritesStore {
	private favorites = new Set<string>();
	private config: FavoritesConfig = { ...DEFAULT_CONFIG };
	private readonly file: string;
	private loaded = false;
	private readonly listeners = new Set<() => void>();

	constructor(file: string = join(getAgentDir(), FAVORITES_FILE)) {
		this.file = file;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(this.file)) {
				this.save();
				return;
			}
			const raw = readFileSync(this.file, "utf8");
			const parsed = JSON.parse(raw) as Partial<FavoritesSnapshot>;
			if (parsed && Array.isArray(parsed.favorites)) {
				for (const id of parsed.favorites) {
					if (typeof id === "string" && id.includes("/")) {
						this.favorites.add(id);
					}
				}
			}
			if (parsed && parsed.config && typeof parsed.config === "object") {
				const cfg = parsed.config as Partial<FavoritesConfig>;
				if (typeof cfg.cycleOnlyFavorites === "boolean") {
					this.config.cycleOnlyFavorites = cfg.cycleOnlyFavorites;
				}
			}
		} catch (error) {
			console.warn(
				"[pi-toolkits/favorites] Failed to load favorites file, starting empty:",
				error instanceof Error ? error.message : String(error),
			);
			this.favorites.clear();
			this.config = { ...DEFAULT_CONFIG };
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
			const data: FavoritesSnapshot = {
				favorites: [...this.favorites].sort(),
				config: this.config,
			};
			writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
			renameSync(tmp, this.file);
		} catch (error) {
			console.warn(
				"[pi-toolkits/favorites] Failed to save favorites file:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	has(model: { provider: string; id: string }): boolean {
		this.ensureLoaded();
		return this.favorites.has(modelKey(model));
	}

	hasAny(): boolean {
		this.ensureLoaded();
		return this.favorites.size > 0;
	}

	count(): number {
		this.ensureLoaded();
		return this.favorites.size;
	}

	list(): string[] {
		this.ensureLoaded();
		return [...this.favorites].sort();
	}

	/** Toggle favorite for a model. Returns true if it is now favorited. */
	toggle(model: { provider: string; id: string }): boolean {
		this.ensureLoaded();
		const key = modelKey(model);
		let nowFavorite: boolean;
		if (this.favorites.has(key)) {
			this.favorites.delete(key);
			nowFavorite = false;
		} else {
			this.favorites.add(key);
			nowFavorite = true;
		}
		this.save();
		this.notify();
		return nowFavorite;
	}

	getConfig(): FavoritesConfig {
		this.ensureLoaded();
		return { ...this.config };
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
				// A broken listener must not break favorites handling.
			}
		}
	}
}

/**
 * Process-wide store shared by the selector/cycle patches and commands.
 *
 * Accessed via getFavoritesStore() (lazy) so tests can swap in an isolated
 * store via setSharedFavoritesStore().
 */
let sharedStore: FavoritesStore | undefined;

export function getFavoritesStore(): FavoritesStore {
	if (!sharedStore) {
		sharedStore = new FavoritesStore();
	}
	return sharedStore;
}

/** Test hook — replace the shared store (e.g. with one backed by a temp file). */
export function setSharedFavoritesStore(store: FavoritesStore): void {
	sharedStore = store;
}
