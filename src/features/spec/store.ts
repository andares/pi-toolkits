/**
 * spec store — every submitted revision, on disk.
 *
 * A spec review is a series of revisions, and the operator needs to look back
 * at any of them ("what did v2 say before I asked for the split?"). So each
 * submit snapshots the file into `<agent-dir>/ask-spec/<slug>/vNNN.md` and
 * `state.json` keeps the metadata: blocks, the block-level diff against the
 * previous revision, the annotations attached to it, and the decision.
 *
 * Deliberately outside the project tree: a review generates many revisions and
 * polluting `git status` with them would be noise. The approved spec itself
 * stays where the agent wrote it (`specs/<slug>.md`) — the store never rewrites
 * that file, so "approved bytes == committed bytes" holds.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseBlocks, type Block } from "./blocks.js";
import { diffBlocks, type DiffEntry } from "./diff.js";
import type { Annotation, BlockAnnotations } from "./feedback.js";

export interface SpecAnnotations {
	global: Annotation[];
	blocks: BlockAnnotations[];
}

export interface SpecDecision {
	action: "approve" | "deny";
	at: string;
}

export interface SpecVersionMeta {
	/** 1-based revision number. */
	n: number;
	at: string;
	/** File the agent submitted from, when known. */
	source?: string;
	blocks: Block[];
	/** Diff against revision n-1 ([] for the first). */
	diff: DiffEntry[];
	annotations: SpecAnnotations;
	decision?: SpecDecision;
}

export interface SpecSession {
	slug: string;
	dir: string;
	createdAt: string;
	versions: SpecVersionMeta[];
}

/** Keep at most this many revisions; the oldest undecided ones go first. */
const MAX_VERSIONS = 50;

export function emptyAnnotations(): SpecAnnotations {
	return { global: [], blocks: [] };
}

/** Slug for a directory name: ascii-ish, lowercase, bounded. */
export function specSlug(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "spec";
}

function versionFile(dir: string, n: number): string {
	return join(dir, `v${String(n).padStart(3, "0")}.md`);
}

function writeAtomic(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

/** Pick a directory for the slug, appending -2, -3 … when one already exists. */
function allocateDir(root: string, slug: string): { dir: string; slug: string } {
	mkdirSync(root, { recursive: true });
	for (let attempt = 1; attempt < 100; attempt += 1) {
		const candidate = attempt === 1 ? slug : `${slug}-${attempt}`;
		const dir = join(root, candidate);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			return { dir, slug: candidate };
		}
	}
	throw new Error(`cannot allocate a directory for spec slug "${slug}" in ${root}`);
}

function saveState(session: SpecSession): void {
	writeAtomic(join(session.dir, "state.json"), `${JSON.stringify(session, null, 2)}\n`);
}

/** Trim old revisions: never drop the latest, never drop a decided one. */
function pruneVersions(session: SpecSession): void {
	if (session.versions.length <= MAX_VERSIONS) return;
	const keep: SpecVersionMeta[] = [];
	const latest = session.versions.at(-1);
	// Iterate oldest → newest, dropping undecided revisions while over budget.
	for (const version of session.versions) {
		const overBudget = session.versions.length - keep.length > MAX_VERSIONS;
		const protectedVersion = version.decision !== undefined || version === latest;
		if (overBudget && !protectedVersion) {
			const path = versionFile(session.dir, version.n);
			if (existsSync(path)) unlinkSync(path);
			continue;
		}
		keep.push(version);
	}
	session.versions = keep;
}

export interface CreateSpecSessionOptions {
	/** `<agent-dir>` — the store lives at `<agentDir>/ask-spec/`. */
	agentDir: string;
	slug: string;
	text: string;
	source?: string;
	now?: Date;
}

const STORE_DIR = "ask-spec";
const LEGACY_STORE_DIR = "ask-plan";

/**
 * Store root, migrating the pre-rename `ask-plan` directory when it is the only
 * one present. If the rename fails (read-only agent dir), the legacy directory
 * keeps working instead of silently starting a second history.
 */
function storeRoot(agentDir: string): string {
	const root = join(agentDir, STORE_DIR);
	const legacy = join(agentDir, LEGACY_STORE_DIR);
	if (!existsSync(root) && existsSync(legacy)) {
		try {
			renameSync(legacy, root);
		} catch {
			return legacy;
		}
	}
	return root;
}

export function createSpecSession(options: CreateSpecSessionOptions): SpecSession {
	const now = options.now ?? new Date();
	const root = storeRoot(options.agentDir);
	const { dir, slug } = allocateDir(root, specSlug(options.slug));
	const session: SpecSession = {
		slug,
		dir,
		createdAt: now.toISOString(),
		versions: [],
	};
	appendSpecVersion(session, {
		text: options.text,
		source: options.source,
		now,
	});
	return session;
}

export interface AppendVersionOptions {
	text: string;
	source?: string;
	now?: Date;
}

/** Snapshot a new revision, diffing it against the previous one. */
export function appendSpecVersion(
	session: SpecSession,
	options: AppendVersionOptions,
): SpecVersionMeta {
	const now = options.now ?? new Date();
	const previous = session.versions.at(-1);
	const blocks = parseBlocks(options.text);
	// Revision numbers are identities, not positions. Pruning old revisions must
	// never make the next submission reuse an existing number (and overwrite its
	// snapshot or merge its annotations into the wrong review round).
	const version: SpecVersionMeta = {
		n: (previous?.n ?? 0) + 1,
		at: now.toISOString(),
		source: options.source,
		blocks,
		diff: previous ? diffBlocks(previous.blocks, blocks) : [],
		annotations: emptyAnnotations(),
	};
	session.versions.push(version);
	writeAtomic(versionFile(session.dir, version.n), options.text);
	pruneVersions(session);
	saveState(session);
	return version;
}

export function setSpecAnnotations(
	session: SpecSession,
	n: number,
	annotations: SpecAnnotations,
): void {
	const version = session.versions.find((candidate) => candidate.n === n);
	if (!version) throw new Error(`no spec revision ${n} in ${session.dir}`);
	version.annotations = annotations;
	saveState(session);
}

export function recordSpecDecision(
	session: SpecSession,
	n: number,
	action: "approve" | "deny",
	now: Date = new Date(),
): void {
	const version = session.versions.find((candidate) => candidate.n === n);
	if (!version) throw new Error(`no spec revision ${n} in ${session.dir}`);
	version.decision = { action, at: now.toISOString() };
	saveState(session);
}

export function latestVersion(session: SpecSession): SpecVersionMeta {
	const version = session.versions.at(-1);
	if (!version) throw new Error(`spec session ${session.dir} has no revisions`);
	return version;
}

export function readVersionText(session: SpecSession, n: number): string {
	return readFileSync(versionFile(session.dir, n), "utf8");
}

/**
 * Load a session from disk (used by tests and by `/ask-spec open` after a reload).
 * A corrupt state file is reported with the path — a raw SyntaxError from
 * JSON.parse would leave the operator guessing which file is broken.
 */
export function loadSpecSession(dir: string): SpecSession {
	const path = join(dir, "state.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot read spec state at ${path}: ${reason}`);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`spec state at ${path} is not an object`);
	}
	return { ...(parsed as SpecSession), dir };
}

/** Directories under `<agentDir>/ask-spec/`, newest first. */
export function listSpecSessions(agentDir: string): string[] {
	const root = storeRoot(agentDir);
	const legacy = join(agentDir, LEGACY_STORE_DIR);
	// A partially migrated agent dir can contain both. Keep every session
	// readable instead of hiding the legacy half or merging directories.
	const roots = legacy === root || !existsSync(legacy) ? [root] : [root, legacy];
	return roots
		.filter((candidate) => existsSync(candidate))
		.flatMap((candidate) =>
			readdirSync(candidate, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(candidate, entry.name))
				.filter((dir) => existsSync(join(dir, "state.json"))),
		)
		.sort((a, b) => a.localeCompare(b));
}
