/**
 * permission feature — bash command decomposition.
 *
 * One `bash` tool call becomes an ordered list of {@link CommandUnit}s, each
 * carrying the command it runs, whether that command mutates, the working
 * directory in force at that point, and the paths it touches. The policy layer
 * answers per unit and the strictest unit wins.
 *
 * Precision is deliberately bounded (this is a boundary guard, not a sandbox):
 *  - `shell-quote` tokenizes with real quoting rules; operators split the
 *    stream into simple commands.
 *  - Command substitution, backticks, `bash -c`/`eval` payloads, and the common
 *    indirection wrappers (`sudo`, `env`, `xargs`, `find -exec`, …) are peeled
 *    or recursed into.
 *  - Heredoc bodies are stripped before parsing.
 *  - Anything the parser cannot account for is marked `opaque`; policy answers
 *    `ask` for an opaque unit regardless of mode (fail closed).
 */
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type ControlOperator,
	type GlobPattern,
	type ParseEntry,
	parse as parseShell,
	quote as quoteWords,
} from "shell-quote";
import type { Effect } from "./constants.js";
import { expandHome } from "./paths.js";

/** One filesystem path a unit touches. */
export interface UnitTarget {
	/** Absolute lexical path (policy canonicalizes it). */
	readonly path: string;
	readonly effect: Effect;
	readonly source: "redirect" | "operand";
}

/** One simple command of a bash program. */
export interface CommandUnit {
	/** Reconstructed text, for prompts and denial reasons. */
	readonly raw: string;
	/** First word before wrapper peeling (`sudo` stays visible here). */
	readonly headWord: string;
	/** Command after wrapper peeling. */
	readonly command: string;
	/** Arguments after wrapper peeling, without redirects. */
	readonly args: readonly string[];
	readonly effect: Effect;
	readonly opaque: boolean;
	/** Working directory in force, or `null` when it cannot be resolved. */
	readonly base: string | null;
	readonly targets: readonly UnitTarget[];
	/** Human-facing reason when {@link opaque} is set. */
	readonly note?: string;
}

const SENTINEL = "\u0000";

/**
 * Device sinks: writing to them is a no-op, not a boundary decision. They are
 * excluded whenever they appear as a plain operand (`curl -o /dev/null`),
 * not just as a redirect target (`cmd > /dev/null`). Commands that mutate the
 * node itself (`rm /dev/null`, `mv /dev/null x`) still collect the target —
 * the write-path branch below keeps them visible to the policy.
 */
const DEVICE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/**
 * Commands whose ordinary arguments are never filesystem paths. `echo` /
 * `printf` can only write through a redirect, which is collected separately,
 * so skipping their operands cannot hide a write and avoids treating a
 * message containing `/` plus an unresolved variable as an opaque path.
 */
const NO_PATH_OPERANDS = new Set(["echo", "printf"]);

/* -------------------------------------------------------------------------- */
/* Read/write classification                                                  */
/* -------------------------------------------------------------------------- */

/** Commands that only read, unless an option guard below withdraws the claim. */
const READ_COMMANDS = new Set([
	"ls", "cat", "tac", "head", "tail", "less", "more", "bat", "grep", "egrep",
	"fgrep", "rg", "ag", "wc", "uniq", "cut", "tr", "column", "file", "stat",
	"du", "df", "tree", "pwd", "echo", "printf", "date", "whoami", "id",
	"uname", "which", "type", "ps", "history", "diff", "cmp", "md5sum",
	"sha1sum", "sha256sum", "base64", "realpath", "dirname", "basename",
	"readlink", "test", "[", "true", "false", "sleep", "seq", "bc", "expr",
	"tput", "jq", "yq", "sort", "sed", "awk", "find", "fd", "nl", "rev",
	"comm", "paste", "join", "split", "fold", "fmt", "pr", "od", "xxd",
]);

/** Commands that mutate by name. */
const WRITE_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp",
	"ln", "truncate", "shred", "dd", "tee", "install", "rsync", "scp", "sftp",
	"unlink", "mkfifo", "mknod", "setfacl", "chattr", "patch", "docker",
	"podman", "systemctl", "service", "kill", "killall", "pkill", "crontab",
	"useradd", "userdel", "groupadd", "passwd", "mount", "umount", "swapon",
	"swapoff", "iptables", "ufw", "git", "npm", "pnpm", "yarn", "bun",
	"pip", "pip3", "uv", "cargo", "go", "make", "cmake", "python", "python3",
	"node", "ruby", "perl", "php", "java", "tsx", "deno",
]);

/** Commands whose operands are always paths, even when they are bare names. */
const WRITE_PATH_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp",
	"ln", "truncate", "shred", "unlink", "tee", "install", "rsync", "scp",
	"sftp", "mkfifo", "mknod", "setfacl", "chattr", "patch",
]);

/** Git verbs that only read. Anything else is treated as mutating. */
const GIT_READ_VERBS = new Set([
	"log", "diff", "show", "status", "blame", "grep", "rev-parse", "rev-list",
	"describe", "shortlog", "cat-file", "show-ref", "for-each-ref", "ls-files",
	"ls-tree", "merge-base", "cherry", "check-ignore", "check-attr",
	"count-objects", "whatchanged", "diff-tree", "name-rev", "stash",
	"reflog", "worktree", "tag", "config", "remote", "branch", "help",
]);

/** Package-manager verbs that only read. */
const PKG_READ_VERBS = new Set([
	"view", "info", "search", "list", "ls", "why", "outdated", "config",
	"licenses", "tree",
]);

/** Git options that take a value; the verb follows them. */
const GIT_VALUE_OPTS = new Set([
	"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
]);

/** Index of the first non-option word, skipping values of `valueOpts`. */
function firstNonOption(
	args: readonly string[],
	valueOpts: ReadonlySet<string>,
): number {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return i + 1;
		if (arg.startsWith("-") && arg !== "-") {
			if (valueOpts.has(arg)) i++;
			continue;
		}
		return i;
	}
	return -1;
}

function hasFlag(args: readonly string[], ...flags: string[]): boolean {
	return args.some((arg) => flags.includes(arg));
}

/**
 * Effective read/write classification for one peeled command.
 * Unknown commands are writes: mutation is the fail-closed assumption.
 */
export function commandEffect(command: string, args: readonly string[]): Effect {
	if (command === "git") {
		const verbIndex = firstNonOption(args, GIT_VALUE_OPTS);
		const verb = verbIndex >= 0 ? args[verbIndex] : "";
		const rest = verbIndex >= 0 ? args.slice(verbIndex + 1) : [];
		if (!GIT_READ_VERBS.has(verb)) return "write";
		if (verb === "stash") {
			return rest.length === 0 || rest[0] === "list" || rest[0] === "show"
				? "read"
				: "write";
		}
		if (verb === "tag") return hasFlag(rest, "-l", "--list") ? "read" : "write";
		if (verb === "branch") {
			const positional = rest.filter((a) => !a.startsWith("-"));
			return positional.length === 0 ? "read" : "write";
		}
		if (verb === "config") {
			return hasFlag(rest, "--get", "--get-all", "--get-regexp", "-l", "--list")
				? "read"
				: "write";
		}
		if (verb === "remote") {
			return hasFlag(rest, "-v", "--verbose", "show", "get-url") ? "read" : "write";
		}
		if (verb === "reflog") {
			return rest.length === 0 || rest[0] === "show" ? "read" : "write";
		}
		return "read";
	}
	if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
		const verbIndex = firstNonOption(args, new Set(["--prefix", "-C", "--dir"]));
		const verb = verbIndex >= 0 ? args[verbIndex] : "";
		return PKG_READ_VERBS.has(verb) ? "read" : "write";
	}
	if (command === "sed") {
		const inPlace = args.some(
			(arg) => arg === "--in-place" || /^-[a-zA-Z]*i/.test(arg),
		);
		return inPlace ? "write" : "read";
	}
	if (command === "sort") {
		return hasFlag(args, "-o", "--output") ? "write" : "read";
	}
	if (command === "find") {
		return args.some(
			(arg) =>
				arg === "-delete" || arg === "-exec" || arg === "-execdir" ||
				arg === "-ok" || arg === "-okdir",
		)
			? "write"
			: "read";
	}
	if (command === "fd") {
		return args.some(
			(arg) => arg === "-x" || arg === "-X" || arg.startsWith("--exec"),
		)
			? "write"
			: "read";
	}
	if (command === "curl") {
		const writes = args.some(
			(arg) =>
				arg === "-O" || arg === "--remote-name" || arg === "-T" ||
				arg === "--upload-file" || arg === "--output" || arg === "-o" ||
				/^-[a-zA-Z]*[oO]$/.test(arg),
		);
		return writes ? "write" : "read";
	}
	if (command === "wget") {
		const toStdout = args.some(
			(arg) => arg === "-O-" || arg === "-qO-" || arg === "--output-document=-",
		);
		return toStdout ? "read" : "write";
	}
	if (command === "tar") {
		const verb = args.find((arg) => /^[a-zA-Z]+$/.test(arg)) ?? "";
		return /[xc]/.test(verb) ? "write" : "read";
	}
	if (READ_COMMANDS.has(command)) return "read";
	if (WRITE_COMMANDS.has(command)) return "write";
	return "write";
}

/* -------------------------------------------------------------------------- */
/* Token helpers                                                              */
/* -------------------------------------------------------------------------- */

const SEPARATORS = new Set([
	"&&", "||", ";", "&", "|", "|&", ";;", ";;&", ";&",
]);
const REDIRECTS = new Set([
	">", ">>", ">|", "&>", "&>>", "<", "<<<", ">&", "<&", "<>",
]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"]);
const PROCESS_SUBSTITUTION = new Set(["<(", ">("]);

function opOf(entry: ParseEntry): string | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	if (!("op" in entry)) return undefined;
	return (entry as { op: string }).op;
}

function isGlob(entry: ParseEntry): entry is GlobPattern {
	return opOf(entry) === "glob";
}

function isControl(entry: ParseEntry): entry is ControlOperator {
	const op = opOf(entry);
	return op !== undefined && op !== "glob";
}

function wordOf(entry: ParseEntry): string | undefined {
	if (typeof entry === "string") return entry;
	if (isGlob(entry)) return entry.pattern;
	return undefined;
}

function hasSentinel(value: string): boolean {
	return value.includes(SENTINEL);
}

/* -------------------------------------------------------------------------- */
/* Pre-passes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Remove heredoc bodies so their text is never parsed as commands.
 * `undefined` means an unterminated heredoc: the caller marks the whole
 * command opaque.
 */
export function stripHeredocs(input: string): string | undefined {
	const lines = input.split("\n");
	const kept: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		const match = /<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(line);
		if (!match) {
			kept.push(line);
			index++;
			continue;
		}
		const delimiter = match[2];
		kept.push(
			line.slice(0, match.index) + line.slice(match.index + match[0].length),
		);
		index++;
		let closed = false;
		while (index < lines.length) {
			const body = lines[index];
			index++;
			if (body.trim() === delimiter) {
				closed = true;
				break;
			}
		}
		if (!closed) return undefined;
	}
	return kept.join("\n");
}

/**
 * Replace `$(…)` and backtick substitutions with placeholder words and return
 * their payloads, so the outer command parses cleanly and each payload can be
 * analysed as a command of its own.
 */
export function extractSubstitutions(input: string): {
	text: string;
	payloads: string[];
} | undefined {
	const payloads: string[] = [];
	let out = "";
	let index = 0;
	while (index < input.length) {
		const char = input[index];
		if (char === "\\") {
			out += input.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (char === "`") {
			const end = input.indexOf("`", index + 1);
			if (end < 0) return undefined;
			payloads.push(input.slice(index + 1, end));
			out += `${SENTINEL}SUBST${payloads.length - 1}${SENTINEL}`;
			index = end + 1;
			continue;
		}
		if (char === "$" && input[index + 1] === "(") {
			const end = findClosingParen(input, index + 2);
			if (end < 0) return undefined;
			payloads.push(input.slice(index + 2, end));
			out += `${SENTINEL}SUBST${payloads.length - 1}${SENTINEL}`;
			index = end + 1;
			continue;
		}
		out += char;
		index++;
	}
	return { text: out, payloads };
}

/**
 * Remove shell comments and verify quote balance in one pass.
 *
 * `shell-quote` silently accepts an unterminated quote, so the balance check
 * is what keeps malformed input from being parsed as a command we then judge.
 * Comments are dropped first because an apostrophe in `# it's fine` would
 * otherwise look like an opening quote. `undefined` means unbalanced.
 */
function stripComments(input: string): string | undefined {
	let out = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (quote !== "'") {
			if (char === "\\") {
				out += input.slice(i, i + 2);
				i++;
				continue;
			}
		}
		if (quote) {
			out += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			out += char;
			continue;
		}
		if (char === "#" && (i === 0 || /\s/.test(input[i - 1]))) {
			while (i < input.length && input[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += char;
	}
	return quote === undefined ? out : undefined;
}

/** Index of the `)` matching an already-consumed `(`, quote-aware. */
function findClosingParen(input: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	for (let i = start; i < input.length; i++) {
		const char = input[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "(") depth++;
		if (char === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Environment proxy: unknown variables expand to a detectable sentinel
 * instead of the empty string, so `$DIR/secret` cannot silently become
 * `/secret` and slip past the boundary check.
 */
function envFor(base: string | null): Record<string, string> {
	const known: Record<string, string> = { HOME: homedir() };
	if (base) known.PWD = base;
	return new Proxy(known, {
		get(target, key) {
			if (typeof key !== "string") return undefined;
			if (Object.hasOwn(target, key)) return target[key];
			return `${SENTINEL}VAR${key}${SENTINEL}`;
		},
	});
}

/* -------------------------------------------------------------------------- */
/* Wrapper peeling                                                            */
/* -------------------------------------------------------------------------- */

const WRAPPER_VALUE_OPTS: Record<string, ReadonlySet<string>> = {
	sudo: new Set(["-u", "-g", "-p", "-C", "-h", "-U", "-T", "-r", "-R", "-D", "-t"]),
	doas: new Set(["-u", "-C"]),
	env: new Set(["-u", "-S", "-C", "--unset", "--split-string", "--chdir"]),
	xargs: new Set([
		"-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--replace", "--max-args",
		"--max-procs", "--max-lines", "--max-chars", "--delimiter", "--eof", "--arg-file",
	]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	watch: new Set(["-n", "--interval"]),
	flock: new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]),
	nice: new Set(["-n", "--adjustment"]),
	time: new Set(["-f", "--format", "-o", "--output"]),
	exec: new Set(["-a"]),
	parallel: new Set(["-j", "--jobs", "-n", "--max-args", "-I", "--replace"]),
	command: new Set(),
	builtin: new Set(),
	nohup: new Set(),
	setsid: new Set(),
};

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);

/** Index of the first word after the wrapper's own options. */
function afterOptions(
	words: string[],
	start: number,
	values: ReadonlySet<string>,
): number {
	let index = start;
	while (index < words.length) {
		const word = words[index];
		if (word === "--") return index + 1;
		if (word.startsWith("-") && word !== "-") {
			index += values.has(word) ? 2 : 1;
			continue;
		}
		return index;
	}
	return index;
}

/** Peel one wrapper, returning the index of the inner command. */
function peelOne(words: string[]): { wrapper: string; inner: number } | undefined {
	const head = words[0];
	if (!head || !Object.hasOwn(WRAPPER_VALUE_OPTS, head)) return undefined;
	const values = WRAPPER_VALUE_OPTS[head];
	let index = afterOptions(words, 1, values);
	if (head === "timeout" || head === "flock") {
		// First non-option word: the duration (timeout) or the lock file (flock).
		if (index < words.length) index++;
	} else if (head === "env") {
		while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
			index++;
		}
	}
	return { wrapper: head, inner: index };
}

/* -------------------------------------------------------------------------- */
/* Segment analysis                                                           */
/* -------------------------------------------------------------------------- */

function opaqueUnit(
	raw: string,
	headWord: string,
	command: string,
	base: string | null,
	note: string,
): CommandUnit {
	return {
		raw,
		headWord,
		command,
		args: [],
		effect: "write",
		opaque: true,
		base,
		targets: [],
		note,
	};
}

/** First word that is not a leading `VAR=value` assignment. */
function firstCommandWord(words: readonly string[]): string {
	for (const word of words) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return word;
	}
	return "";
}

/** Whether a word looks like a filesystem path. */
export function looksLikePath(word: string): boolean {
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(word)) return false; // URL
	return (
		word === "." ||
		word === ".." ||
		word.startsWith("/") ||
		word.startsWith("~") ||
		word.includes("/") ||
		word.includes("\\") ||
		word.includes("*") ||
		word.includes("?") ||
		word.includes("[")
	);
}

/** Resolve one path word against a base; `undefined` when not resolvable. */
function resolveTargetPath(
	base: string | null,
	word: string,
): string | undefined {
	if (hasSentinel(word)) return undefined;
	const expanded = expandHome(word);
	if (/[*?[\]]/.test(expanded)) {
		// A glob targets the directory it expands in — the directory is what a
		// boundary decision can actually judge.
		const prefix = expanded.slice(0, expanded.search(/[*?[\]]/));
		const directory = prefix.includes("/") ? dirname(prefix || ".") : ".";
		if (!directory.startsWith("/") && !directory.startsWith("~") && base === null) {
			return undefined;
		}
		return resolve(base ?? "/", expandHome(directory));
	}
	if (expanded.startsWith("/")) return resolve(expanded);
	if (base === null) return undefined;
	return resolve(base, expanded);
}

/** Positional words, skipping options and the values of known value options. */
export function operands(
	args: readonly string[],
	valueOpts: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	let afterDoubleDash = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (afterDoubleDash) {
			out.push(word);
			continue;
		}
		if (word === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (word.startsWith("-") && word !== "-") {
			if (valueOpts.has(word)) i++;
			continue;
		}
		out.push(word);
	}
	return out;
}

const WRITE_OPERAND_VALUE_OPTS = new Set([
	"-t", "-S", "-e", "-C", "-o", "--output", "--target-directory", "--suffix",
	"--reference", "--mode",
]);

function dedupeTargets(targets: UnitTarget[]): UnitTarget[] {
	const seen = new Set<string>();
	const out: UnitTarget[] = [];
	for (const target of targets) {
		const key = `${target.effect}:${target.path}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(target);
	}
	return out;
}

/** Separate redirects from the command words, keeping redirect targets typed. */
function splitRedirects(tokens: string[]): {
	words: string[];
	redirects: Array<{ op: string; target?: string }>;
	processSubstitution: boolean;
} {
	const words: string[] = [];
	const redirects: Array<{ op: string; target?: string }> = [];
	let processSubstitution = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (PROCESS_SUBSTITUTION.has(token)) {
			processSubstitution = true;
			continue;
		}
		if (!REDIRECTS.has(token)) {
			words.push(token);
			continue;
		}
		// Keep a file descriptor (`2>`) out of the argument list.
		if (words.length > 0 && /^\d+$/.test(words[words.length - 1])) {
			words.pop();
		}
		const target = tokens[i + 1];
		if (target !== undefined && !REDIRECTS.has(target)) i++;
		redirects.push({ op: token, target });
	}
	return { words, redirects, processSubstitution };
}

/**
 * Turn one simple command (already split on separators) into units.
 * Recursion depth is bounded so a pathological substitution cannot loop.
 */
function analyzeSegment(
	tokens: string[],
	base: string | null,
	depth: number,
): { units: CommandUnit[]; nextBase: string | null } {
	const raw = tokens.join(" ");
	const { words, redirects, processSubstitution } = splitRedirects(tokens);
	const headWord = firstCommandWord(words);

	if (processSubstitution) {
		return {
			units: [opaqueUnit(raw, headWord, "", base, "process substitution")],
			nextBase: base,
		};
	}
	if (words.length === 0) return { units: [], nextBase: base };

	// Leading `VAR=value` assignments belong to the segment's environment, not
	// to the command.
	let peeled = words.filter(() => true);
	while (peeled.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(peeled[0])) {
		peeled = peeled.slice(1);
	}

	// Wrapper peeling: `sudo rm` is decided by `rm`, while `headWord` keeps the
	// wrapper visible for the danger table.
	for (let round = 0; round < 4; round++) {
		const step = peelOne(peeled);
		if (!step) break;
		if (step.inner >= peeled.length) {
			return {
				units: [opaqueUnit(raw, headWord, step.wrapper, base, "wrapper runs no visible command")],
				nextBase: base,
			};
		}
		peeled = peeled.slice(step.inner);
	}

	const command = peeled[0] ?? "";
	const args = peeled.slice(1);

	// Shell payloads and `eval`: recurse into the payload text.
	if (SHELLS.has(command) || command === "eval") {
		let payload: string | undefined;
		if (command === "eval") {
			payload = args.join(" ");
		} else {
			const flag = args.indexOf("-c");
			if (flag >= 0) payload = args[flag + 1];
		}
		if (payload !== undefined) {
			if (payload === "" || hasSentinel(payload) || depth >= 4) {
				return {
					units: [opaqueUnit(raw, headWord, command, base, "shell payload is not a literal")],
					nextBase: base,
				};
			}
			return { units: parseSubText(payload, base, depth + 1), nextBase: base };
		}
	}

	// `cd` changes the base for the commands that follow it.
	if (command === "cd") {
		const target = operands(args, new Set())[0];
		if (target === undefined) {
			const home = homedir();
			return {
				units: [{
					raw,
					headWord,
					command,
					args,
					effect: "read",
					opaque: false,
					base,
					targets: [{ path: home, effect: "read", source: "operand" }],
				}],
				nextBase: home,
			};
		}
		if (target === "-" || hasSentinel(target) || /^~[^/]/.test(target)) {
			return {
				units: [opaqueUnit(raw, headWord, command, base, "unresolved cd target")],
				nextBase: null,
			};
		}
		const destination = resolveTargetPath(base, target);
		if (destination === undefined) {
			return {
				units: [opaqueUnit(raw, headWord, command, base, "unresolved cd target")],
				nextBase: null,
			};
		}
		return {
			units: [{
				raw,
				headWord,
				command,
				args,
				effect: "read",
				opaque: false,
				base,
				targets: [{ path: destination, effect: "read", source: "operand" }],
			}],
			nextBase: destination,
		};
	}

	const effect = commandEffect(command, args);
	const targets: UnitTarget[] = [];
	const units: CommandUnit[] = [];

	// `find`/`fd` exec flags run a nested command.
	if (command === "find" || command === "fd") {
		const flagIndex = args.findIndex(
			(arg) =>
				arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir" ||
				arg === "-x" || arg === "-X" || arg === "--exec" || arg === "--exec-batch",
		);
		if (flagIndex >= 0 && depth < 4) {
			const end = args.indexOf(";", flagIndex);
			const inner = args.slice(flagIndex + 1, end < 0 ? undefined : end);
			if (inner.length > 0) {
				units.push(...parseSubText(quoteWords(inner), base, depth + 1));
			}
		}
	}

	// Redirect targets are proof, independent of the command. `/dev/null` (and
	// the standard streams) are not files a boundary decision can meaningfully
	// guard; `cmd 2>/dev/null` is noise, not a write.
	for (const redirect of redirects) {
		if (redirect.target === undefined) continue;
		if (redirect.op === "<<<") continue; // herestring: data, not a path
		if (DEVICE_SINKS.has(redirect.target)) continue;
		const descriptor =
			(redirect.op === ">&" || redirect.op === "<&" || redirect.op === "&>") &&
			/^\d+$/.test(redirect.target);
		if (descriptor) continue;
		const pathValue = resolveTargetPath(base, redirect.target);
		if (pathValue === undefined) {
			return {
				units: [opaqueUnit(raw, headWord, command, base, "unresolved redirect target")],
				nextBase: base,
			};
		}
		targets.push({
			path: pathValue,
			effect: WRITE_REDIRECTS.has(redirect.op) ? "write" : "read",
			source: "redirect",
		});
	}

	// `git -C <dir>` makes every relative path argument (and the repo itself)
	// resolve against <dir> for this invocation; treat it like a local cd.
	let commandBase = base;
	if (command === "git") {
		for (let i = 0; i < args.length; i++) {
			const value = args[i] === "-C" ? args[i + 1] : undefined;
			if (value === undefined) continue;
			const destination = resolveTargetPath(commandBase, value);
			if (destination === undefined) {
				return {
					units: [opaqueUnit(raw, headWord, command, base, "unresolved git -C target")],
					nextBase: base,
				};
			}
			commandBase = destination;
		}
	}

	// Command-specific target extraction.
	if (WRITE_PATH_COMMANDS.has(command)) {
		for (const operand of operands(args, WRITE_OPERAND_VALUE_OPTS)) {
			const pathValue = resolveTargetPath(commandBase, operand);
			if (pathValue === undefined) {
				return {
					units: [opaqueUnit(raw, headWord, command, base, "unresolved path operand")],
					nextBase: base,
				};
			}
			targets.push({ path: pathValue, effect: "write", source: "operand" });
		}
	} else if (
		command === "sed" &&
		effect === "write"
	) {
		// `sed -i` writes its file operands; the first non-option operand is the
		// script unless -e/-f already named one.
		const ops = operands(args, new Set(["-e", "--expression", "-f", "--file"]));
		const files = hasFlag(args, "-e", "--expression", "-f", "--file")
			? ops
			: ops.slice(1);
		for (const file of files) {
			const pathValue = resolveTargetPath(base, file);
			if (pathValue === undefined) {
				return {
					units: [opaqueUnit(raw, headWord, command, base, "unresolved sed target")],
					nextBase: base,
				};
			}
			targets.push({ path: pathValue, effect: "write", source: "operand" });
		}
	} else if (command === "dd") {
		for (const arg of args) {
			if (arg.startsWith("of=")) {
				const value = arg.slice(3);
				if (DEVICE_SINKS.has(value)) continue;
				const pathValue = resolveTargetPath(base, value);
				if (pathValue === undefined) {
					return {
						units: [opaqueUnit(raw, headWord, command, base, "unresolved dd target")],
						nextBase: base,
					};
				}
				targets.push({ path: pathValue, effect: "write", source: "operand" });
			} else if (arg.startsWith("if=")) {
				const pathValue = resolveTargetPath(base, arg.slice(3));
				if (pathValue) {
					targets.push({ path: pathValue, effect: "read", source: "operand" });
				}
			}
		}
	}

	// Path-like arguments are targets for every command, except for commands
	// whose arguments are data (`echo`, `printf`) and device sinks.
	if (!NO_PATH_OPERANDS.has(command)) {
		for (const arg of args) {
			if (DEVICE_SINKS.has(arg)) continue;
			if (!looksLikePath(arg)) continue;
			// `sed -i` operands were already classified above; its script is not a path.
			if (command === "sed" && effect === "write") continue;
			const pathValue = resolveTargetPath(commandBase, arg);
			if (pathValue === undefined) {
				return {
					units: [opaqueUnit(raw, headWord, command, base, "unresolved path argument")],
					nextBase: base,
				};
			}
			targets.push({ path: pathValue, effect, source: "operand" });
		}
	}

	// `-o FILE` / `--output FILE` writes whatever the command is. `echo` and
	// `printf` do not have an output option, so their `-o` is data too.
	if (!NO_PATH_OPERANDS.has(command)) {
		for (let i = 0; i < args.length; i++) {
			if (args[i] !== "-o" && args[i] !== "--output") continue;
			const value = args[i + 1];
			if (value === undefined || DEVICE_SINKS.has(value)) continue;
			const pathValue = resolveTargetPath(commandBase, value);
			if (pathValue) targets.push({ path: pathValue, effect: "write", source: "operand" });
		}
	}

	units.push({
		raw,
		headWord,
		command,
		args,
		effect: targets.some((t) => t.effect === "write") ? "write" : effect,
		opaque: false,
		base: commandBase ?? base,
		targets: dedupeTargets(targets),
	});
	return { units, nextBase: base };
}

/* -------------------------------------------------------------------------- */
/* Program parsing                                                            */
/* -------------------------------------------------------------------------- */

function segmentTokens(entries: ParseEntry[]): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const entry of entries) {
		if (isControl(entry)) {
			if (SEPARATORS.has(entry.op)) {
				if (current.length > 0) segments.push(current);
				current = [];
				continue;
			}
			if (entry.op === "(" || entry.op === ")") continue;
			current.push(entry.op);
			continue;
		}
		const word = wordOf(entry);
		if (word !== undefined) current.push(word);
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

const PLACEHOLDER = /\u0000SUBST(\d+)\u0000/g;

/**
 * Token-level walker: substitutions are analysed where their placeholder
 * appears, so a payload after `cd /tmp` is judged against `/tmp`.
 */
function parseText(
	text: string,
	base: string | null,
	depth: number,
	payloads: readonly string[],
): CommandUnit[] {
	let entries: ParseEntry[];
	try {
		entries = parseShell(text, envFor(base));
	} catch {
		return [opaqueUnit(text, "", "", base, "the parser could not tokenize this command")];
	}
	const units: CommandUnit[] = [];
	let currentBase = base;
	for (const segment of segmentTokens(entries)) {
		const cleaned: string[] = [];
		for (const word of segment) {
			let rest = word;
			for (const match of word.matchAll(PLACEHOLDER)) {
				const payload = payloads[Number(match[1])];
				if (payload !== undefined && depth < 4) {
					units.push(...parseSubText(payload, currentBase, depth + 1));
				}
				rest = rest.replace(match[0], "");
			}
			if (rest !== "") cleaned.push(rest);
		}
		if (cleaned.length === 0) continue;
		const analyzed = analyzeSegment(cleaned, currentBase, depth);
		units.push(...analyzed.units);
		currentBase = analyzed.nextBase;
	}
	return units;
}

/** Extract substitutions from one command string, then walk it. */
function parseSubText(
	text: string,
	base: string | null,
	depth: number,
): CommandUnit[] {
	const withoutComments = stripComments(text);
	if (withoutComments === undefined) {
		return [opaqueUnit(text, "", "", base, "unbalanced quoting")];
	}
	const extracted = extractSubstitutions(withoutComments);
	if (extracted === undefined) {
		return [opaqueUnit(text, "", "", base, "unterminated command substitution")];
	}
	return parseText(extracted.text, base, depth, extracted.payloads);
}

/**
 * Parse one bash tool call into ordered command units.
 *
 * The initial base is the session working directory; `cd` folds forward
 * between segments. An empty command yields no units (nothing to gate); a
 * pre-pass failure yields one opaque unit.
 */
export function parseCommandUnits(command: string, cwd: string): CommandUnit[] {
	const stripped = stripHeredocs(command);
	if (stripped === undefined) {
		return [opaqueUnit(command, "", "", cwd, "unterminated heredoc")];
	}
	if (stripped.trim() === "") return [];
	return parseSubText(stripped, cwd, 0);
}
