/**
 * autostart feature — pure config logic, no pi imports.
 *
 * Schema (`.pi/autostart.toml`, checked into the project):
 *
 * ```toml
 * version = 1
 *
 * [command]
 * run = [
 *   "/add-dir ../shop-frontend",
 *   "/add-dir ../shop-api",
 * ]
 * ```
 *
 * `version` is optional (defaults to 1) but must be 1 when present, so a
 * future schema change can fail loudly instead of silently misreading.
 */
import { parse as parseToml } from "smol-toml";

/** Project-relative location of the autostart config (`.pi/` is pi's
 *  project-config convention, precedent: `.pi/mcp.json`). */
export const AUTOSTART_CONFIG_PATH = ".pi/autostart.toml";

/**
 * session_start reasons that replay autostart commands:
 *  - startup / new: fresh session in the project — replay
 *  - fork: new branch of an earlier session — replay (the fork point may
 *    predate the config)
 *  - resume: the resumed branch already carries its /add-dir state —
 *    replaying would at best duplicate work (pi-add-dir is idempotent) and
 *    at worst re-add directories the user removed on that branch
 *  - reload: extensions are being rebuilt — re-running commands would
 *    duplicate side effects from the same session
 */
export const RUNNABLE_REASONS: ReadonlySet<string> = new Set([
	"startup",
	"new",
	"fork",
]);

/** Parse/validation failure with a user-facing message. */
export class AutostartParseError extends Error {}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Parse autostart config text into the ordered command list.
 * @throws AutostartParseError on invalid TOML, wrong shape, or version ≠ 1.
 */
export function parseAutostartConfig(text: string): string[] {
	let doc: unknown;
	try {
		doc = parseToml(text);
	} catch (err) {
		throw new AutostartParseError(`invalid TOML: ${errMessage(err)}`);
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
		throw new AutostartParseError("top-level value must be a table");
	}
	const { version, command } = doc as {
		version?: unknown;
		command?: unknown;
	};
	if (version !== undefined && version !== 1) {
		throw new AutostartParseError(
			`unsupported version ${String(version)} (expected 1)`,
		);
	}
	if (command === undefined) return [];
	if (Array.isArray(command)) {
		throw new AutostartParseError(
			"[[command]] array tables are not supported — use a single [command] table with a run array",
		);
	}
	if (command === null || typeof command !== "object") {
		throw new AutostartParseError("[command] must be a table");
	}
	const run = (command as { run?: unknown }).run;
	if (run === undefined) return [];
	if (
		!Array.isArray(run) ||
		run.some((entry) => typeof entry !== "string")
	) {
		throw new AutostartParseError(
			"[command].run must be an array of command strings",
		);
	}
	// Trim each entry: `prompt()` dispatches a command only when the text
	// literally starts with "/", so a leading-space entry would silently fall
	// through to the model as a plain message. Normalizing here keeps the
	// "never sent to the model" guarantee (see index.ts).
	return (run as string[])
		.map((cmd) => cmd.trim())
		.filter((cmd) => cmd !== "");
}

/**
 * Extract the command name a slash command dispatches to:
 * `"/add-dir ../x"` → `"add-dir"`, tolerant of leading whitespace and an
 * optional slash. Empty for blank input.
 */
export function commandNameOf(command: string): string {
	const stripped = command.trim().replace(/^\//, "");
	return stripped.split(/\s+/)[0] ?? "";
}
