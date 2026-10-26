/**
 * init feature — types shared by detect / plan / apply / audit.
 *
 * The split is intentional: `Facts` is what the disk says (no judgement),
 * `Plan` is what the command intends to do about it (deterministic actions for
 * code, tasks for the model), and `Finding` is what the audit can prove.
 */
import type { ProjectLanguage } from "./spec.js";

export type Severity = "error" | "warning" | "info";

/** One audit result. `code` is stable so reports stay machine-readable. */
export interface Finding {
	readonly code: string;
	readonly severity: Severity;
	readonly message: string;
	readonly path?: string;
	readonly line?: number;
}

/* -------------------------------------------------------------------------- */
/* Facts                                                                       */
/* -------------------------------------------------------------------------- */

export interface FileInfo {
	/** Path relative to the project root, POSIX separators. */
	readonly rel: string;
	readonly bytes: number;
	readonly lines: number;
	readonly mtimeMs: number;
}

export interface Heading {
	readonly level: number;
	readonly text: string;
	readonly line: number;
}

export interface DocInfo extends FileInfo {
	readonly text: string;
	readonly headings: readonly Heading[];
}

export interface RootInfo {
	readonly label: string;
	/** Path as registered (relative to the project root when inside it). */
	readonly path: string;
	readonly absolute: string;
	readonly role?: string;
	readonly agentsMd: "none" | "scope-card" | "independent" | "unknown";
	readonly source: "state" | "add-dir";
	readonly exists: boolean;
	readonly lastSeen?: string;
}

export interface FrameworkState {
	version: number;
	tool: string;
	created: string;
	updated: string;
	profile: "core" | "full";
	modules: string[];
	lang: ProjectLanguage;
	budgets?: {
		agentsMdSoftChars?: number;
		agentsMdHardChars?: number;
		memoryFileChars?: number;
	};
	roots: RootInfo[];
	managed: Array<{ path: string; sha256: string; template: string }>;
	migrations: Array<{ at: string; to: string; notes?: string }>;
}

export interface RefArea {
	files: number;
	hits: number;
}

/** Bare `memory/` / `implementations/` references that a move would break. */
export interface RefScan {
	/** Text files inspected. */
	files: number;
	/** Bare occurrences (already excludes `.agents/…` and `my-memory/`-style). */
	hits: number;
	byArea: Record<string, RefArea>;
	examples: Array<{ path: string; line: number; text: string }>;
	/** Files that contain at least one bare occurrence. */
	paths: string[];
}

export interface ProjectFacts {
	manifests: string[];
	lockfiles: string[];
	license?: string;
	ci: string[];
	scripts: Record<string, string>;
	pkgManager?: string;
}

export interface ContextFiles {
	agents?: DocInfo;
	claude?: DocInfo;
	override?: DocInfo;
	piAgents?: DocInfo;
}

export interface Facts {
	root: string;
	isGit: boolean;
	gitClean?: boolean;
	gitDirtyCount?: number;
	/** Present when the state file exists and parsed. */
	state?: FrameworkState;
	stateError?: string;
	context: ContextFiles;
	/** Framework-relevant directories that exist (relative paths). */
	dirs: Record<string, boolean>;
	/** Legacy locations that the framework wants under `.agents/`. */
	deprecated: { memory: boolean; implementations: boolean; prompts: boolean };
	/** File counts for the three legacy locations (all file types). */
	deprecatedFiles: { memory: number; implementations: number; prompts: number };
	/** `todos/` is retired; content becomes specs. */
	retiredTodos: boolean;
	/** Zero-byte files sitting at the root (crash artefacts, placeholders). */
	rootEmptyFiles: string[];
	/** Memory docs found at the canonical location, sorted by name. */
	memory: DocInfo[];
	/** Extra memory docs found in a legacy `memory/` directory. */
	legacyMemory: DocInfo[];
	specs: DocInfo[];
	implementations: FileInfo[];
	todos: DocInfo[];
	legacyDocs: DocInfo[];
	nestedAgents: FileInfo[];
	/** Memory-module ids that already have a file (design, terms, review, …). */
	modulesPresent: string[];
	refs: RefScan;
	project: ProjectFacts;
	language: ProjectLanguage;
	roots: RootInfo[];
	warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export type PlanMode =
	| "fresh"
	| "adopt"
	| "reconcile"
	| "upgrade"
	| "audit-only"
	| "unsupported";

export interface SnapshotAction {
	readonly kind: "snapshot";
	readonly paths: string[];
	readonly files: number;
}

export interface MoveAction {
	readonly kind: "move-dir";
	readonly from: string;
	readonly to: string;
	readonly files: number;
	/** untracked files ride along with a plain rename instead of `git mv`. */
	readonly trackedOnly: boolean;
}

export interface MoveFileAction {
	readonly kind: "move-file";
	readonly from: string;
	readonly to: string;
}

export interface RewriteAction {
	readonly kind: "rewrite-refs";
	/** Applied in order; first match wins (longest prefixes first). */
	readonly pairs: Array<{ from: string; to: string }>;
	readonly files: number;
	readonly hits: number;
}

export interface CreateFileAction {
	readonly kind: "create-file";
	readonly path: string;
	/** Template name in `templates/` or "inline" with `content`. */
	readonly template: string;
	readonly tokens: Record<string, string>;
	readonly note: string;
}

export interface CreateDirsAction {
	readonly kind: "create-dirs";
	readonly paths: string[];
}

export interface WriteStateAction {
	readonly kind: "write-state";
	readonly state: FrameworkState;
}

export type Action =
	| SnapshotAction
	| MoveAction
	| MoveFileAction
	| RewriteAction
	| CreateDirsAction
	| CreateFileAction
	| WriteStateAction;

export type TaskKind =
	| "survey"
	| "edit-agents"
	| "merge-plan"
	| "merge-legacy"
	| "triage-todos"
	| "fill-file"
	| "root-cards"
	| "budget-debt"
	| "coverage";

export interface Task {
	readonly id: string;
	readonly kind: TaskKind;
	readonly detail: string;
	readonly targets?: string[];
	readonly acceptance: string[];
}

export interface Plan {
	readonly mode: PlanMode;
	readonly root: string;
	readonly language: ProjectLanguage;
	readonly frameworkVersion: number;
	readonly toolVersion: string;
	readonly createdAt: string;
	readonly actions: Action[];
	readonly tasks: Task[];
	/** Paths this run writes for the model and the operator. */
	readonly artifacts: { plan?: string; coverage?: string; rewrite?: string; snapshot?: string };
	/** Human summary lines shown in the confirmation panel. */
	readonly summary: string[];
	readonly warnings: string[];
	readonly facts: Facts;
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

export interface ApplyResult {
	readonly snapshot?: { dir: string; files: number };
	readonly moved: Array<{ from: string; to: string; files: number }>;
	readonly rewrites?: { files: number; hits: number; report: string };
	readonly created: string[];
	readonly skipped: Array<{ path: string; reason: string }>;
	readonly statePath?: string;
	/** Machine-readable work order for the model stage. */
	readonly planPath?: string;
	readonly summary: string[];
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                    */
/* -------------------------------------------------------------------------- */

export type CoverageStatus = "hit" | "mapped" | "open";

export interface CoverageRow {
	readonly source: string;
	readonly heading: string;
	readonly status: CoverageStatus;
	readonly destination?: string;
	readonly reason?: string;
}

export interface CoverageReport {
	readonly rows: CoverageRow[];
	readonly open: number;
	readonly mapped: number;
	readonly hit: number;
}
