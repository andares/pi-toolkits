/**
 * ask feature — scratch directory for planning notes.
 *
 * Ask mode used to confiscate every write tool, including writes to a temp
 * file. That is stricter than the promise it makes ("do not change the
 * project"): a model that wants to hold an outline, a checklist or a draft
 * analysis had to either dump it into the reply or work around the sandbox. So
 * the mode now hands out exactly one place to write — a per-session directory
 * under the OS temp dir, outside the project:
 *
 *  - the root is `<os.tmpdir()>/pi-ask/<session>`, so nothing here can touch the
 *    repository and no path arrives from the model (names are relative);
 *  - names are validated against a narrow allowlist (letters, digits, dot,
 *    dash, underscore; at most two levels; no `..`, no absolute path, no
 *    backslash), and the joined path is re-checked for containment as defence
 *    in depth;
 *  - existing symlinked components are refused, so a pre-existing link in the
 *    temp dir cannot turn a note into a write somewhere else;
 *  - files are capped at {@link SCRATCH_MAX_BYTES}: "notes" are not a dump of
 *    the repository, and the cap also keeps a tool result from flooding the
 *    context when the model reads its own note back;
 *  - `createScratchStore` throws when the temp dir cannot be created or written.
 *    The caller then degrades to the old fully read-only mode instead of
 *    running half-open.
 *
 * Nothing written here is ever executed: ask mode's bash sandbox stays
 * read-only, so a script dropped into the scratch directory is just text.
 */
import { createHash } from "node:crypto";
// Creation and sweeping are synchronous on purpose: ask mode can be entered from
// `session_start` (the autostart path), and the first run starts before an async
// directory creation would resolve. Those are a handful of syscalls; the actual
// note operations stay async because they run inside tool calls.
import {
	mkdirSync,
	realpathSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	appendFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Directory under the OS temp dir that holds every session's scratch space. */
export const SCRATCH_DIR_NAME = "pi-ask";
/** Largest single note. Notes are planning aids, not a copy of the repository. */
export const SCRATCH_MAX_BYTES = 256 * 1024;
/** Scratch directories older than this are removed when a session enters ask mode. */
export const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A note name segment: no leading dot, no separators, no shell metacharacters. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A session id that is safe as a directory name (pi uses UUIDs; be defensive). */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Deepest allowed note name, e.g. `notes/api.md`. */
const MAX_SEGMENTS = 2;

/** One note as reported by `list`. */
export interface ScratchFile {
	readonly name: string;
	readonly bytes: number;
}

/** Result of writing or appending one note. */
export interface ScratchWrite {
	readonly name: string;
	readonly path: string;
	readonly bytes: number;
	readonly lines: number;
}

/** The scratch space of one session. Every operation takes a relative note name. */
export interface ScratchStore {
	readonly root: string;
	write(name: string, content: string): Promise<ScratchWrite>;
	append(name: string, content: string): Promise<ScratchWrite>;
	read(name: string): Promise<string>;
	list(): Promise<ScratchFile[]>;
	remove(name: string): Promise<void>;
}

/** Why `name` is not a valid note name, or undefined when it is. */
export function nameError(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed === "") {
		return 'The note name is empty. Use a relative name such as "plan.md".';
	}
	if (isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.includes("\\")) {
		return `"${name}" is not a relative name. Scratch names are relative to the scratch directory (for example "plan.md"); absolute paths and backslashes are rejected.`;
	}
	const segments = name.split("/");
	if (segments.length > MAX_SEGMENTS) {
		return `"${name}" is nested too deeply. At most ${MAX_SEGMENTS} levels are allowed ("notes/api.md").`;
	}
	const invalid = segments.find((segment) => !SEGMENT.test(segment));
	if (invalid !== undefined) {
		return `"${name}" has an invalid segment "${invalid}". A segment is 1-64 characters of letters, digits, dot, dash or underscore and may not start with a dot.`;
	}
	return undefined;
}

/** Case-folded containment check (Windows paths are case-insensitive). */
function inside(root: string, target: string): boolean {
	const fold = (value: string): string =>
		process.platform === "win32" ? value.toLowerCase() : value;
	const base = fold(root);
	const candidate = fold(target);
	return (
		candidate === base ||
		candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
	);
}

/** Absolute path of a validated note name, re-checked for containment. */
function targetFor(root: string, name: string): string {
	const problem = nameError(name);
	if (problem !== undefined) throw new Error(problem);
	const target = resolve(root, name);
	if (!inside(root, target)) {
		throw new Error(`"${name}" resolves outside the scratch directory.`);
	}
	return target;
}

/**
 * Refuse a target whose existing components go through a symlink.
 *
 * The store never creates links itself, so this only matters when something
 * else (the operator, another process) put one in the temp directory first.
 * Missing components are fine: they are about to be created inside the root.
 */
async function assertNoSymlink(root: string, target: string): Promise<void> {
	const parts = target.slice(root.length).split(sep).filter(Boolean);
	let current = root;
	for (const part of parts) {
		current = join(current, part);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) {
				throw new Error(
					`${part} in the scratch directory is a symbolic link; scratch notes must be regular files.`,
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

function tooBig(bytes: number): string {
	const kib = Math.ceil(SCRATCH_MAX_BYTES / 1024);
	return `Scratch notes are capped at ${kib} KiB; this note would be ${Math.ceil(bytes / 1024)} KiB. Keep it to the planning essentials — the reply, not the note, is the deliverable.`;
}

function lineCount(text: string): number {
	if (text === "") return 0;
	const breaks = text.split("\n").length;
	return text.endsWith("\n") ? breaks - 1 : breaks;
}

async function sizeOf(path: string): Promise<number | undefined> {
	try {
		const info = await stat(path);
		return info.size;
	} catch {
		return undefined;
	}
}

/** Create a {@link ScratchStore} rooted in `options.baseDir` (default: OS temp). */
export function createScratchStore(options: {
	readonly sessionId: string;
	readonly baseDir?: string;
	readonly now?: number;
}): ScratchStore {
	const base = join(resolve(options.baseDir ?? tmpdir()), SCRATCH_DIR_NAME);
	const leaf = SESSION.test(options.sessionId)
		? options.sessionId
		: createHash("sha256").update(options.sessionId).digest("hex").slice(0, 16);
	const created = join(base, leaf);
	mkdirSync(created, { recursive: true });
	// macOS resolves /var (and therefore the default tmpdir) through a symlink.
	const root = realpathSync(created);
	// Prove the directory is writable: on a read-only TMPDIR `mkdir -p` on an
	// existing directory succeeds without proving anything. Ask mode degrades
	// when this throws.
	const probe = join(root, `.probe-${process.pid}-${Date.now()}`);
	writeFileSync(probe, "");
	unlinkSync(probe);
	sweepScratchDirs(base, SCRATCH_MAX_AGE_MS, options.now);

	const store: ScratchStore = {
		root,

		async write(name, content) {
			const target = targetFor(root, name);
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes > SCRATCH_MAX_BYTES) throw new Error(tooBig(bytes));
			await assertNoSymlink(root, target);
			await mkdir(resolve(target, ".."), { recursive: true });
			await writeFile(target, content, "utf8");
			return { name, path: target, bytes, lines: lineCount(content) };
		},

		async append(name, content) {
			const target = targetFor(root, name);
			const existing = (await sizeOf(target)) ?? 0;
			const bytes = Buffer.byteLength(content, "utf8");
			if (existing + bytes > SCRATCH_MAX_BYTES) {
				throw new Error(tooBig(existing + bytes));
			}
			await assertNoSymlink(root, target);
			await mkdir(resolve(target, ".."), { recursive: true });
			await appendFile(target, content, "utf8");
			const total = existing + bytes;
			return {
				name,
				path: target,
				bytes: total,
				// The appended text is what the caller just wrote; the file's own
				// line count is not needed by the model.
				lines: lineCount(content),
			};
		},

		async read(name) {
			const target = targetFor(root, name);
			await assertNoSymlink(root, target);
			let data: Buffer;
			try {
				data = await readFile(target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new Error(
						`There is no scratch note named "${name}". Use op "list" to see the notes that exist.`,
					);
				}
				throw error;
			}
			if (data.length > SCRATCH_MAX_BYTES) {
				return `${data.subarray(0, SCRATCH_MAX_BYTES).toString("utf8")}\n…(truncated at ${Math.floor(SCRATCH_MAX_BYTES / 1024)} KiB)`;
			}
			return data.toString("utf8");
		},

		async list() {
			const files: ScratchFile[] = [];
			const walk = async (dir: string, prefix: string): Promise<void> => {
				const entries = await readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.name.startsWith(".")) continue;
					const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
					if (entry.isDirectory()) {
						// One level only: names cannot nest deeper than MAX_SEGMENTS.
						if (prefix === "") await walk(join(dir, entry.name), name);
						continue;
					}
					// Symlinks and other non-files are deliberately not listed.
					if (!entry.isFile()) continue;
					const size = await sizeOf(join(dir, entry.name));
					files.push({ name, bytes: size ?? 0 });
				}
			};
			await walk(root, "");
			return files.sort((a, b) => a.name.localeCompare(b.name));
		},

		async remove(name) {
			const target = targetFor(root, name);
			try {
				await unlink(target);
			} catch (error) {
				// Deleting a note that is already gone is not an error: the model
				// asked for the note to be gone and it is.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
	return store;
}

/**
 * Remove scratch directories older than `maxAgeMs`. Never throws: cleanup is
 * housekeeping, and a stale directory must not keep ask mode from starting.
 */
export function sweepScratchDirs(
	base: string,
	maxAgeMs: number,
	now = Date.now(),
): string[] {
	const removed: string[] = [];
	let entries;
	try {
		entries = readdirSync(base, { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(base, entry.name);
		try {
			const info = statSync(dir);
			if (now - info.mtimeMs <= maxAgeMs) continue;
			rmSync(dir, { recursive: true, force: true });
			removed.push(entry.name);
		} catch {
			// Best effort; a directory in use elsewhere stays.
		}
	}
	return removed;
}
