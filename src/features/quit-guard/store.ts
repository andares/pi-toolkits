/**
 * quit-guard feature — persisted settings store.
 *
 * State lives in `<agent-dir>/pi-toolkits-quit-guard.json` (agent-dir from
 * getAgentDir(), same convention as the favorites/compact/review stores).
 *
 * File shape:
 *   {
 *     "enabled": true,
 *     "timeoutMs": 8000,
 *     "report": true
 *   }
 *
 * `enabled` (default true) gates the whole watchdog; `timeoutMs` is clamped
 * to [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]; `report` (default true) writes a JSON
 * artifact under `<agent-dir>/quit-guard/` every time the guard fires.
 *
 * Robustness: a missing file means defaults (and is created on first save),
 * corrupted/unreadable files fall back to defaults with a console.warn, and
 * writes are atomic (tmp + rename) and never throw.
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
import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	QUIT_GUARD_FILE,
} from "./constants.js";

export interface QuitGuardConfig {
	/** Master switch. When false the guard never arms. */
	enabled: boolean;
	/** Milliseconds allowed between the terminal teardown write and exit. */
	timeoutMs: number;
	/** Write a JSON hang report before forcing exit. */
	report: boolean;
}

export const DEFAULT_CONFIG: QuitGuardConfig = {
	enabled: true,
	timeoutMs: DEFAULT_TIMEOUT_MS,
	report: true,
};

/** Clamp/round a timeout into the supported range; non-numbers fall back. */
export function normalizeTimeoutMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_TIMEOUT_MS;
	}
	const rounded = Math.round(value);
	if (rounded <= MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
	if (rounded >= MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
	return rounded;
}

/** Coerce an unknown JSON blob into a complete config (defaults for gaps). */
export function normalizeConfig(input: unknown): QuitGuardConfig {
	const config: QuitGuardConfig = { ...DEFAULT_CONFIG };
	if (!input || typeof input !== "object") return config;
	const raw = input as Partial<QuitGuardConfig>;
	if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
	if (typeof raw.report === "boolean") config.report = raw.report;
	if (raw.timeoutMs !== undefined) {
		config.timeoutMs = normalizeTimeoutMs(raw.timeoutMs);
	}
	return config;
}

export class QuitGuardStore {
	private config: QuitGuardConfig = { ...DEFAULT_CONFIG };
	private readonly file: string;
	private loaded = false;

	constructor(file: string = join(getAgentDir(), QUIT_GUARD_FILE)) {
		this.file = file;
	}

	/** Path of the JSON file (also used to derive the report directory). */
	get path(): string {
		return this.file;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(this.file)) return;
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			this.config = normalizeConfig(parsed);
		} catch (error) {
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/quit-guard] Failed to load settings, using defaults:",
				error instanceof Error ? error.message : String(error),
			);
			this.config = { ...DEFAULT_CONFIG };
		}
	}

	/** Current settings (a copy). */
	get(): QuitGuardConfig {
		this.ensureLoaded();
		return { ...this.config };
	}

	/** Merge a patch, normalize it, persist, and return the new settings. */
	update(patch: Partial<QuitGuardConfig>): QuitGuardConfig {
		this.ensureLoaded();
		this.config = normalizeConfig({ ...this.config, ...patch });
		this.save();
		return { ...this.config };
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
				`${JSON.stringify(this.config, null, 2)}\n`,
				"utf8",
			);
			renameSync(tmp, this.file);
		} catch (error) {
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/quit-guard] Failed to save settings:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}
