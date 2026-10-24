/**
 * approval-log — capped, rolling, append-only audit of approval decisions.
 *
 * The log is write-only telemetry: nothing in this module is ever consulted
 * when a permission verdict is made, so a full disk, a read-only home, or a
 * deleted directory changes no decision. Failures therefore fail **open**
 * (logging is disabled for the process with one warning), unlike the gate
 * itself, which fails closed.
 *
 * On-disk shape: one JSON object per line (`JSON.stringify` escapes newlines,
 * so a record never spans lines), files named `audit-NNNNNN.jsonl` and read in
 * lexical order. A file is rotated when it reaches 1000 records **or** 8 MiB;
 * after a new file is created, the lowest-numbered file is removed so at most
 * ten files (≈10k typical records) remain.
 *
 * Why JSONL rather than SQLite or CSV:
 *  - appends never rewrite existing bytes (no write amplification, no VACUUM);
 *  - a crash can leave at most one truncated tail line, which readers skip;
 *  - `jq` / `readline` can stream all files for analysis, and the nested
 *    command decomposition has a natural home;
 *  - rotation is an `unlink`, not a compaction pass.
 *
 * Writes are synchronous and unbatched: approval events happen at tool-call
 * pace (seconds apart), so one ~2 KiB append plus a readdir/stat costs tens of
 * microseconds. No `fsync` is issued — the page cache coalesces appends and
 * the kernel writes them back sequentially, which keeps physical writes close
 * to the logical volume and leaves SSD wear negligible.
 *
 * Redaction is applied to every string in the record (commands, unit args,
 * prompts, reasons) before serialization. `write` / `edit` *content* bodies are
 * never logged at all: the policy only needs paths.
 */
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

/** Bump when a reader can no longer assume the current field layout. */
export const APPROVAL_LOG_SCHEMA = 1;

export const DEFAULT_MAX_FILES = 10;
export const DEFAULT_MAX_RECORDS = 1000;
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_RECORD_BYTES = 16 * 1024;

/** `interesting` skips plain mode-allowed calls; `all` logs them too. */
export type ApprovalLogMode = "off" | "interesting" | "all";

/** Everything a record may contain; keeps the log JSON-serializable by type. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue | undefined };

export type ApprovalRecord = { [key: string]: JsonValue | undefined };

export interface ApprovalLogOptions {
	/** Directory; defaults to `$PI_APPROVAL_LOG_DIR` or `<agentDir>/approval-log`. */
	readonly dir?: string;
	/** Defaults to `$PI_APPROVAL_LOG` or `interesting`. */
	readonly mode?: ApprovalLogMode;
	readonly maxFiles?: number;
	readonly maxRecords?: number;
	readonly maxFileBytes?: number;
	readonly maxRecordBytes?: number;
	readonly now?: () => Date;
	/** Receives the one-time failure warning. Defaults to stderr. */
	readonly warn?: (message: string) => void;
}

export interface ApprovalLog {
	readonly dir: string;
	readonly mode: ApprovalLogMode;
	/** False once a write failed; the process stops logging. */
	readonly active: boolean;
	append(record: ApprovalRecord): void;
}

/* -------------------------------------------------------------------------- */
/* Record envelope                                                            */
/* -------------------------------------------------------------------------- */

const EXTENSION_VERSION: string | undefined = (() => {
	try {
		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
})();

/** Session id, or `undefined` when the context has no session manager. */
export function sessionIdOf(
	ctx: ExtensionContext | undefined,
): string | undefined {
	try {
		return ctx?.sessionManager?.getSessionId();
	} catch {
		return undefined;
	}
}

/** Common envelope carried by every record. */
export function auditBase(
	ctx: ExtensionContext | undefined,
	now: Date = new Date(),
): ApprovalRecord {
	const model = ctx?.model;
	return {
		v: APPROVAL_LOG_SCHEMA,
		ts: now.toISOString(),
		session: sessionIdOf(ctx),
		pid: process.pid,
		pi: VERSION,
		ext: EXTENSION_VERSION,
		os: process.platform,
		model: model ? `${model.provider}/${model.id}` : undefined,
		cwd: ctx?.cwd,
	};
}

/** Tool-call fields, with the input reduced to what policy analysis needs. */
export function auditTool(event: ToolCallEvent): ApprovalRecord {
	return {
		tool: event.toolName,
		toolCall: event.toolCallId,
		parentToolCall: event.parentToolCallId,
		input: sanitizeToolInput(event.toolName, event.input),
	};
}

/* -------------------------------------------------------------------------- */
/* Truncation                                                                 */
/* -------------------------------------------------------------------------- */

/** Middle-truncate long text, keeping the head and a short tail. */
export function clipText(value: string, maxChars = 4096): string {
	if (value.length <= maxChars) return value;
	const tail = Math.min(512, Math.floor(maxChars / 8));
	const head = maxChars - tail;
	const omitted = value.length - maxChars;
	return `${value.slice(0, head)}…[+${omitted} chars]…${value.slice(-tail)}`;
}

function sanitizeValue(value: unknown, depth: number): JsonValue {
	if (typeof value === "string") return clipText(value, 4096);
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return value;
	}
	if (value === undefined) return null;
	if (depth >= 4) {
		try {
			return clipText(JSON.stringify(value), 1024);
		} catch {
			return "[unserializable]";
		}
	}
	if (Array.isArray(value)) {
		return value.slice(0, 64).map((item) => sanitizeValue(item, depth + 1));
	}
	if (typeof value === "object") {
		const out: ApprovalRecord = {};
		let count = 0;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (count++ >= 64) break;
			out[key] = sanitizeValue(item, depth + 1);
		}
		return out;
	}
	return String(value);
}

/**
 * Tool input as it may be logged.
 *
 * `write`/`edit` bodies are replaced by byte counts: they are not needed to
 * judge or mine a path decision, and logging them would turn the audit trail
 * into a copy of every edited file.
 */
export function sanitizeToolInput(
	toolName: string,
	input: unknown,
): JsonValue {
	const record =
		typeof input === "object" && input !== null
			? (input as Record<string, unknown>)
			: {};
	if (toolName === "write" || toolName === "edit") {
		const out: ApprovalRecord = {};
		if (typeof record.path === "string") out.path = record.path;
		const content = toolName === "write" ? record.content : record.newText;
		if (typeof content === "string") {
			out.contentBytes = Buffer.byteLength(content);
		}
		if (toolName === "edit" && typeof record.oldText === "string") {
			out.oldTextBytes = Buffer.byteLength(record.oldText);
		}
		return out;
	}
	if (toolName === "bash" && typeof record.command === "string") {
		return { ...record, command: clipText(record.command, 8192) };
	}
	if (toolName === "powershell" && typeof record.script === "string") {
		return { ...record, script: clipText(record.script, 8192) };
	}
	return sanitizeValue(input, 0);
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/** Best-effort credential patterns; the file is still sensitive regardless. */
type Replacer = string | ((match: string, ...groups: string[]) => string);

const REDACTIONS: ReadonlyArray<readonly [RegExp, Replacer]> = [
	[
		/(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*)?\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
		(_match: string, prefix?: string) => `${prefix ?? ""}[redacted]`,
	],
	[
		/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd)\b\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
		(_match: string, prefix: string) => `${prefix}[redacted]`,
	],
	[
		/(\bhttps?:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi,
		(_match: string, prefix: string, suffix: string) =>
			`${prefix}[redacted]${suffix}`,
	],
	[
		/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
		"[redacted]",
	],
];

function redactText(value: string): string {
	let out = value;
	for (const [pattern, replacement] of REDACTIONS) {
		out =
			typeof replacement === "string"
				? out.replace(pattern, replacement)
				: out.replace(
						pattern,
						replacement as (
							substring: string,
							...args: string[]
						) => string,
					);
	}
	return out;
}

function redactValue(
	value: JsonValue,
	state: { changed: boolean },
	depth = 0,
): JsonValue {
	if (typeof value === "string") {
		const out = redactText(value);
		if (out !== value) state.changed = true;
		return out;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, state, depth + 1));
	}
	if (value !== null && typeof value === "object") {
		if (depth >= 8) return value;
		const out: ApprovalRecord = {};
		for (const [key, item] of Object.entries(value as ApprovalRecord)) {
			out[key] = redactValue(item ?? null, state, depth + 1);
		}
		return out;
	}
	return value;
}

function isRecord(value: JsonValue): value is ApprovalRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactRecord(record: ApprovalRecord): {
	record: ApprovalRecord;
	changed: boolean;
} {
	const state = { changed: false };
	const value = redactValue(record, state, 0);
	return { record: isRecord(value) ? value : record, changed: state.changed };
}

/* -------------------------------------------------------------------------- */
/* Serialization guard                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Serialize one record, dropping optional detail (with a marker) if it still
 * exceeds the per-record budget. The verdict/answer envelope survives every
 * step, so a pathological command cannot hide the decision itself.
 *
 * Returns `undefined` when the record cannot be serialized at all (a value
 * `JSON.stringify` rejects, such as a BigInt or an exotic object that survived
 * sanitization). That is a property of *this* record, not of the log, so the
 * caller skips it instead of disabling logging for the whole process.
 */
function encodeRecord(
	record: ApprovalRecord,
	maxBytes: number,
): string | undefined {
	const fits = (value: ApprovalRecord): string | undefined => {
		try {
			const line = JSON.stringify(value);
			return Buffer.byteLength(line) <= maxBytes ? line : undefined;
		} catch {
			return undefined;
		}
	};

	let line = fits(record);
	if (line !== undefined) return line;

	const candidate: ApprovalRecord = { ...record };
	if (Array.isArray(candidate.units)) {
		candidate.units = {
			omitted: true,
			count: candidate.units.length,
		};
		candidate.truncated = true;
	}
	line = fits(candidate);
	if (line !== undefined) return line;

	if (candidate.prompt !== undefined) {
		candidate.prompt = undefined;
		candidate.truncated = true;
		line = fits(candidate);
		if (line !== undefined) return line;
	}

	if (candidate.input !== undefined) {
		candidate.input = { omitted: true };
		candidate.truncated = true;
		line = fits(candidate);
		if (line !== undefined) return line;
	}

	if (candidate.reason !== undefined) {
		candidate.reason = clipText(String(candidate.reason), 512);
		candidate.truncated = true;
		line = fits(candidate);
		if (line !== undefined) return line;
	}

	// Last resort: keep only the decision envelope. `truncated` makes the loss
	// visible to every reader instead of silently dropping fields.
	try {
		return JSON.stringify({
			v: candidate.v,
			ts: candidate.ts,
			event: candidate.event,
			session: candidate.session,
			tool: candidate.tool,
			verdict: candidate.verdict,
			answer: candidate.answer,
			outcome: candidate.outcome,
			truncated: true,
		});
	} catch {
		return undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* Rolling writer                                                             */
/* -------------------------------------------------------------------------- */

const FILE_PATTERN = /^audit-(\d{6,})\.jsonl$/;

interface LogFile {
	readonly index: number;
	readonly path: string;
}

interface ActiveFile extends LogFile {
	count: number;
	bytes: number;
}

/**
 * Newlines in `[from, to)` of an append-only file.
 *
 * Used to fold another process's appends into our record count: the bytes we
 * have not observed yet are exactly those lines, so counting them costs the
 * size of the delta rather than a re-read of the whole file. Without it the
 * cap would silently become "1000 per process".
 */
function countNewlines(path: string, from: number, to: number): number {
	const chunk = 64 * 1024;
	const buffer = Buffer.allocUnsafe(chunk);
	const fd = openSync(path, "r");
	try {
		let position = from;
		let count = 0;
		while (position < to) {
			const wanted = Math.min(chunk, to - position);
			const read = readSync(fd, buffer, 0, wanted, position);
			if (read <= 0) break;
			for (let i = 0; i < read; i++) {
				if (buffer[i] === 0x0a) count++;
			}
			position += read;
		}
		return count;
	} finally {
		closeSync(fd);
	}
}

function listLogFiles(dir: string): LogFile[] {
	try {
		return readdirSync(dir)
			.flatMap((name) => {
				const match = FILE_PATTERN.exec(name);
				return match
					? [{ index: Number(match[1]), path: join(dir, name) }]
					: [];
			})
			.sort((a, b) => a.index - b.index);
	} catch {
		return [];
	}
}

function parseMode(value: string | undefined): ApprovalLogMode | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["off", "0", "false", "no"].includes(normalized)) return "off";
	if (normalized === "all") return "all";
	if (["interesting", "on", "1", "true", "yes"].includes(normalized)) {
		return "interesting";
	}
	return undefined;
}

export function createApprovalLog(
	options: ApprovalLogOptions = {},
): ApprovalLog {
	const mode =
		options.mode ??
		parseMode(process.env.PI_APPROVAL_LOG) ??
		"interesting";
	const dir =
		options.dir ??
		process.env.PI_APPROVAL_LOG_DIR ??
		join(getAgentDir(), "approval-log");
	const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
	const maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
	const maxFileBytes = Math.max(
		1,
		options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
	);
	const maxRecordBytes = Math.max(
		1,
		options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
	);
	const now = options.now ?? (() => new Date());
	const warn =
		options.warn ??
		((message: string): void => {
			// `console.warn` is what the host and the other features use for a
			// degraded (not fatal) path.
			console.warn(message);
		});

	let active = mode !== "off";
	let initialized = mode === "off";
	let warned = false;
	/** Separate flag: a skipped record must not swallow the "disabled" notice. */
	let warnedSkip = false;
	let current: ActiveFile | undefined;

	function fail(error: unknown): void {
		active = false;
		if (warned) return;
		warned = true;
		const message = error instanceof Error ? error.message : String(error);
		warn(`[pi-toolkits] approval log disabled: ${message}`);
	}

	function createFile(startIndex: number): ActiveFile {
		for (let index = startIndex; index < startIndex + 1000; index++) {
			const path = join(
				dir,
				`audit-${String(index).padStart(6, "0")}.jsonl`,
			);
			try {
				writeFileSync(path, "", { flag: "wx", mode: 0o600 });
				return { index, path, count: 0, bytes: 0 };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error;
				}
			}
		}
		throw new Error(`could not allocate a log file index under ${dir}`);
	}

	function prune(): void {
		const files = listLogFiles(dir);
		const excess = files.length - maxFiles;
		for (let i = 0; i < excess; i++) {
			try {
				unlinkSync(files[i].path);
			} catch {
				// A concurrent process may have removed it already.
			}
		}
	}

	function rotate(): void {
		const files = listLogFiles(dir);
		const next = (files.at(-1)?.index ?? 0) + 1;
		current = createFile(next);
		// The new file counts towards the cap, so pruning after creation is what
		// makes file number 11 remove file number 1.
		prune();
	}

	function adopt(file: LogFile): void {
		const size = statSync(file.path).size;
		if (size > maxFileBytes) {
			// Only our own writer creates these names, but a copied-in or corrupted
			// file must not turn startup into a multi-gigabyte read. Treat it as
			// full and start a fresh file; the oversized one is pruned normally.
			current = {
				index: file.index,
				path: file.path,
				count: maxRecords,
				bytes: size,
			};
			rotate();
			return;
		}
		const buffer = readFileSync(file.path);
		const unterminated =
			buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a;
		if (unterminated) {
			// A crash may have left a partial line; terminate it so the next
			// record starts on a line of its own. Readers still skip the fragment.
			appendFileSync(file.path, "\n", { mode: 0o600 });
		}
		let count = 0;
		for (const byte of buffer) {
			if (byte === 0x0a) count++;
		}
		if (unterminated) count++;
		current = {
			index: file.index,
			path: file.path,
			count,
			bytes: statSync(file.path).size,
		};
		if (current.count >= maxRecords || current.bytes >= maxFileBytes) {
			rotate();
		}
	}

	function ensureInitialized(): void {
		if (initialized) return;
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			// mkdir's mode is masked by umask; make the intent explicit.
			try {
				chmodSync(dir, 0o700);
			} catch {
				// Non-POSIX filesystem: keep going.
			}
			const files = listLogFiles(dir);
			if (files.length === 0) current = createFile(1);
			else adopt(files[files.length - 1]);
			// A directory copied from elsewhere (or left over after a config
			// change) may hold more than the cap; trim before the first append.
			prune();
			initialized = true;
		} catch (error) {
			fail(error);
		}
	}

	/**
	 * Detect a rotation performed by another pi process, a pruned file, or a
	 * boundary reached by concurrent appends. Runs once per record: a readdir of
	 * at most ten names plus one stat.
	 */
	function refresh(): void {
		const files = listLogFiles(dir);
		if (files.length === 0) {
			current = createFile(1);
			return;
		}
		const newest = files[files.length - 1];
		if (!current) {
			adopt(newest);
			return;
		}
		if (newest.index > current.index) {
			adopt(newest);
			return;
		}
		if (!existsSync(current.path)) {
			adopt(newest);
			return;
		}
		let size: number;
		try {
			size = statSync(current.path).size;
		} catch {
			adopt(newest);
			return;
		}
		if (size !== current.bytes) {
			if (size > current.bytes) {
				// Another process appended: fold its lines into the count so the
				// 1000-record cap stays a cap rather than a per-process counter.
				try {
					current.count += countNewlines(current.path, current.bytes, size);
				} catch {
					// Leave the count as a lower bound; the byte cap still bounds growth.
				}
				current.bytes = size;
			} else {
				// The file shrank: it was truncated or replaced, so the running count
				// is meaningless. Re-derive it from the file itself.
				adopt({ index: current.index, path: current.path });
				return;
			}
			if (size >= maxFileBytes) {
				rotate();
				return;
			}
		}
		if (current.count >= maxRecords || current.bytes >= maxFileBytes) {
			// Rotate lazily: the next record opens a fresh file. This keeps the
			// last file full instead of leaving an empty 11th file behind when the
			// process stops right at a boundary.
			rotate();
		}
	}

	function append(record: ApprovalRecord): void {
		if (!active) return;
		try {
			ensureInitialized();
			if (!active || !current) return;
			refresh();
			if (!active || !current) return;

			const stamped: ApprovalRecord = {
				v: APPROVAL_LOG_SCHEMA,
				...record,
			};
			if (typeof stamped.ts !== "string") {
				stamped.ts = now().toISOString();
			}
			const redacted = redactRecord(stamped);
			const safe = redacted.record;
			if (redacted.changed) safe.redacted = true;

			const encoded = encodeRecord(safe, maxRecordBytes);
			if (encoded === undefined) {
				// One unserializable record is not a reason to go blind for the rest
				// of the process (the alternative, `fail()`, would).
				if (!warnedSkip) {
					warnedSkip = true;
					warn(
						"[pi-toolkits] approval log skipped a record it could not serialize",
					);
				}
				return;
			}
			const line = `${encoded}\n`;
			appendFileSync(current.path, line, { mode: 0o600 });
			current.count++;
			current.bytes += Buffer.byteLength(line);
		} catch (error) {
			fail(error);
		}
	}

	return {
		dir,
		mode,
		get active() {
			return active;
		},
		append,
	};
}
