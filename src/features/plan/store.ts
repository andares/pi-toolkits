/**
 * plan store — every submitted revision, on disk.
 *
 * A plan review is a series of revisions, and the operator needs to look back
 * at any of them ("what did v2 say before I asked for the split?"). So each
 * submit snapshots the file into `<agent-dir>/ask-plan/<slug>/vNNN.md` and
 * `state.json` keeps the metadata: blocks, the block-level diff against the
 * previous revision, the annotations attached to it, and the decision.
 *
 * Deliberately outside the project tree: a review generates many revisions and
 * polluting `git status` with them would be noise. The approved plan itself
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

export interface PlanAnnotations {
	global: Annotation[];
	blocks: BlockAnnotations[];
}

export interface PlanDecision {
	action: "approve" | "deny";
	at: string;
}

export interface PlanVersionMeta {
	/** 1-based revision number. */
	n: number;
	at: string;
	/** File the agent submitted from, when known. */
	source?: string;
	blocks: Block[];
	/** Diff against revision n-1 ([] for the first). */
	diff: DiffEntry[];
	annotations: PlanAnnotations;
	decision?: PlanDecision;
}

export interface PlanSession {
	slug: string;
	dir: string;
	createdAt: string;
	versions: PlanVersionMeta[];
}

/** Keep at most this many revisions; the oldest undecided ones go first. */
const MAX_VERSIONS = 50;

export function emptyAnnotations(): PlanAnnotations {
	return { global: [], blocks: [] };
}

/** Slug for a directory name: ascii-ish, lowercase, bounded. */
export function planSlug(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "plan";
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
	throw new Error(`cannot allocate a directory for plan slug "${slug}" in ${root}`);
}

function saveState(session: PlanSession): void {
	writeAtomic(join(session.dir, "state.json"), `${JSON.stringify(session, null, 2)}\n`);
}

/** Trim old revisions: never drop the latest, never drop a decided one. */
function pruneVersions(session: PlanSession): void {
	if (session.versions.length <= MAX_VERSIONS) return;
	const keep: PlanVersionMeta[] = [];
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

export interface CreatePlanSessionOptions {
	/** `<agent-dir>` — the store lives at `<agentDir>/ask-plan/`. */
	agentDir: string;
	slug: string;
	text: string;
	source?: string;
	now?: Date;
}

export function createPlanSession(options: CreatePlanSessionOptions): PlanSession {
	const now = options.now ?? new Date();
	const root = join(options.agentDir, "ask-plan");
	const { dir, slug } = allocateDir(root, planSlug(options.slug));
	const session: PlanSession = {
		slug,
		dir,
		createdAt: now.toISOString(),
		versions: [],
	};
	appendPlanVersion(session, {
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
export function appendPlanVersion(
	session: PlanSession,
	options: AppendVersionOptions,
): PlanVersionMeta {
	const now = options.now ?? new Date();
	const previous = session.versions.at(-1);
	const blocks = parseBlocks(options.text);
	// Revision numbers are identities, not positions. Pruning old revisions must
	// never make the next submission reuse an existing number (and overwrite its
	// snapshot or merge its annotations into the wrong review round).
	const version: PlanVersionMeta = {
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

export function setPlanAnnotations(
	session: PlanSession,
	n: number,
	annotations: PlanAnnotations,
): void {
	const version = session.versions.find((candidate) => candidate.n === n);
	if (!version) throw new Error(`no plan revision ${n} in ${session.dir}`);
	version.annotations = annotations;
	saveState(session);
}

export function recordPlanDecision(
	session: PlanSession,
	n: number,
	action: "approve" | "deny",
	now: Date = new Date(),
): void {
	const version = session.versions.find((candidate) => candidate.n === n);
	if (!version) throw new Error(`no plan revision ${n} in ${session.dir}`);
	version.decision = { action, at: now.toISOString() };
	saveState(session);
}

export function latestVersion(session: PlanSession): PlanVersionMeta {
	const version = session.versions.at(-1);
	if (!version) throw new Error(`plan session ${session.dir} has no revisions`);
	return version;
}

export function readVersionText(session: PlanSession, n: number): string {
	return readFileSync(versionFile(session.dir, n), "utf8");
}

/**
 * Load a session from disk (used by tests and by `/ask-plan open` after a reload).
 * A corrupt state file is reported with the path — a raw SyntaxError from
 * JSON.parse would leave the operator guessing which file is broken.
 */
export function loadPlanSession(dir: string): PlanSession {
	const path = join(dir, "state.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot read plan state at ${path}: ${reason}`);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`plan state at ${path} is not an object`);
	}
	return { ...(parsed as PlanSession), dir };
}

/** Directories under `<agentDir>/ask-plan/`, newest first. */
export function listPlanSessions(agentDir: string): string[] {
	const root = join(agentDir, "ask-plan");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name))
		.filter((dir) => existsSync(join(dir, "state.json")))
		.sort((a, b) => a.localeCompare(b));
}
