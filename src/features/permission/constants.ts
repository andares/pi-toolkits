/**
 * permission feature — modes, labels, and the fixed safety tables.
 *
 * The four modes are deliberately small: project boundary (in/out) crossed
 * with operation kind (read/write, exec folded into write). There is no rule
 * matrix — session grants cover the exceptions.
 *
 * Two tables sit outside the four modes on purpose:
 *  - {@link SECRET_ROOTS} / {@link isSecretFile}: reads and writes of
 *    credential material are denied in every mode. Without this, the default
 *    `outside read = allow` would hand the agent `~/.ssh/id_rsa`.
 *  - {@link DANGER_REASON}: destructive commands are always asked about, even
 *    when their scope says allow (`rm -rf .` inside the project is still a
 *    guarded operation). Scope alone cannot express "destructive".
 */
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

/** Three-way mode, used for outside-project operations. */
export type TriMode = "ask" | "allow" | "deny";

/** Two-way mode, used for inside-project operations. */
export type PairMode = "ask" | "allow";

/** What one tool call does to the filesystem. */
export type Effect = "read" | "write";

/** The four permission modes, all at once. */
export interface PermissionModes {
	inRead: PairMode;
	inWrite: PairMode;
	outRead: TriMode;
	outWrite: TriMode;
}

/**
 * Defaults: project-internal work is uninterrupted; outside reads are allowed
 * (the secrets table is what protects credentials); outside writes ask.
 */
export const DEFAULT_MODES: PermissionModes = {
	inRead: "allow",
	inWrite: "allow",
	outRead: "allow",
	outWrite: "ask",
};

/** Footer status key (extension-scoped; `/ask` uses its own). */
export const PERMISSION_STATUS_KEY = "perm-mode";

/** Values offered by the mode panel, in cycle order. */
export const IN_VALUES: readonly PairMode[] = ["allow", "ask"];
export const OUT_VALUES: readonly TriMode[] = ["allow", "ask", "deny"];

/**
 * Credential locations denied in every mode. `~` is expanded at match time so
 * the table survives a moved home directory.
 */
export const SECRET_ROOTS: readonly string[] = [
	"~/.ssh",
	"~/.gnupg",
	"~/.aws",
	"~/.pi/agent/auth.json",
];

/** `.env` family: secrets by convention, except the sample templates. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/** pi's own credential files other than the exact `auth.json` entry. */
function isPiAuthFile(pathValue: string): boolean {
	const authPrefix = join(homedir(), ".pi", "agent", "auth");
	return pathValue.startsWith(authPrefix) && basename(pathValue).endsWith(".json");
}

/** Containment: `pathValue` is `root` itself or under it (with sep boundaries). */
function pathWithin(root: string, pathValue: string): boolean {
	const a = process.platform === "win32" ? root.toLowerCase() : root;
	const b = process.platform === "win32" ? pathValue.toLowerCase() : pathValue;
	return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

/** `true` when `pathValue` is `.env`-shaped and not a template. */
function isSecretEnvFile(pathValue: string): boolean {
	const name = basename(pathValue);
	if (ENV_TEMPLATES.has(name)) return false;
	return name === ".env" || name.startsWith(".env.");
}

/** Absolute secret prefixes, `~` expanded. */
export function secretRoots(): string[] {
	return SECRET_ROOTS.map((root) =>
		root.startsWith("~") ? join(homedir(), root.slice(1)) : root,
	);
}

/** Why `pathValue` is secret, or `undefined` when it is not. */
export function secretReason(pathValue: string): string | undefined {
	if (isPiAuthFile(pathValue)) return "pi credentials";
	if (isSecretEnvFile(pathValue)) return "environment file";
	for (const root of secretRoots()) {
		if (pathWithin(root, pathValue)) return "credentials";
	}
	return undefined;
}

/**
 * Commands always confirmed regardless of mode. Returns the human-facing
 * reason, or `undefined` for an ordinary command.
 *
 * `targets` are the unit's already-resolved absolute paths.
 */
export function dangerReason(
	command: string,
	args: readonly string[],
	targets: readonly string[],
	base: string | null,
): string | undefined {
	const home = homedir();
	const inDangerousRoot = (pathValue: string): boolean =>
		pathValue === "/" ||
		pathValue === home ||
		(base !== null && pathValue === base);

	if (command === "sudo" || command === "doas") return "privileged command";
	if (command === "rm" && targets.some(inDangerousRoot)) {
		return "recursive delete of /, the home directory, or the working directory";
	}
	if (command === "git") {
		const [verb, ...rest] = args;
		if (verb === "reset" && rest.includes("--hard")) return "git reset --hard";
		if (verb === "clean" && rest.some((a) => /^-[a-zA-Z]*f/.test(a))) {
			return "git clean -f";
		}
		if (verb === "push" && rest.some((a) => a === "-f" || a === "--force")) {
			return "forced git push";
		}
	}
	if (
		["npm", "pnpm", "yarn", "bun"].includes(command) &&
		args[0] === "publish"
	) {
		return "package publish";
	}
	if (command === "dd" && targets.some((t) => t.startsWith("/dev/"))) {
		return "raw device write";
	}
	if (command.startsWith("mkfs")) return "filesystem creation";
	if (["shutdown", "reboot", "poweroff", "halt"].includes(command)) {
		return "system power command";
	}
	if (
		command === "chmod" &&
		args.some((a) => /^-[a-zA-Z]*R/.test(a)) &&
		args.includes("777")
	) {
		return "recursive world-writable chmod";
	}
	return undefined;
}
