/**
 * init feature — read-only survey of a project.
 *
 * Everything here is a fact read from disk, with no judgement: the plan and the
 * audit decide what those facts mean. Two rules shape the code:
 *
 *  1. **Bounded** — the survey must never stall the command on a huge repo, so
 *     the walk is capped, ignored dirs are explicit, and oversized files are
 *     read for headings only.
 *  2. **Reproducible** — the reference scan used for "N occurrences in M files"
 *     is the same predicate the rewrite uses. Counts and edits can therefore be
 *     reconciled instead of trusted.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	AGENTS_DIR,
	DEPRECATED_ROOT_DIRS,
	FRAMEWORK_DIR,
	FRAMEWORK_VERSION,
	IMPLEMENTATIONS_DIR,
	LEGACY_DOC_NAMES,
	MEMORY_DIR,
	OVERRIDE_FILE,
	PROMPTS_DIR,
	RETIRED_ROOT_DIRS,
	SCAN,
	SPECS_DIR,
	STATE_FILE,
	isMemoryFileName,
	type ProjectLanguage,
} from "./spec.js";
import type {
	DocInfo,
	Facts,
	FileInfo,
	FrameworkState,
	Heading,
	ProjectFacts,
	RefArea,
	RefScan,
	RootInfo,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Small filesystem helpers                                                    */
/* -------------------------------------------------------------------------- */

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

export function statFile(root: string, rel: string): FileInfo | undefined {
	try {
		const absolute = join(root, rel);
		const stat = statSync(absolute);
		if (!stat.isFile()) return undefined;
		let lines = 0;
		if (stat.size <= SCAN.maxFileBytes) {
			const text = readFileSync(absolute, "utf8");
			lines = countLines(text);
		}
		return { rel, bytes: stat.size, lines, mtimeMs: stat.mtimeMs };
	} catch {
		return undefined;
	}
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) lines += 1;
	}
	return lines;
}

export function readTextFile(root: string, rel: string): string | undefined {
	try {
		const absolute = join(root, rel);
		const stat = statSync(absolute);
		if (!stat.isFile()) return undefined;
		const buffer = readFileSync(absolute);
		// Binary check: a NUL in the first 8 KiB is enough to classify.
		const probe = buffer.subarray(0, 8192);
		if (probe.includes(0)) return undefined;
		const limit = SCAN.maxFileBytes;
		const text =
			buffer.length > limit
				? buffer.subarray(0, limit).toString("utf8")
				: buffer.toString("utf8");
		return text;
	} catch {
		return undefined;
	}
}

/** Headings outside fenced code blocks, with 1-based line numbers. */
export function parseHeadings(text: string): Heading[] {
	const headings: Heading[] = [];
	let fence: string | undefined;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (fence) continue;
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (match) {
			headings.push({ level: match[1].length, text: match[2].trim(), line: index + 1 });
		}
	}
	return headings;
}

export function readDoc(root: string, rel: string): DocInfo | undefined {
	const text = readTextFile(root, rel);
	if (text === undefined) return undefined;
	const info = statFile(root, rel);
	if (!info) return undefined;
	return { ...info, text, headings: parseHeadings(text) };
}

function listDir(root: string, rel: string): string[] {
	try {
		return readdirSync(join(root, rel)).sort();
	} catch {
		return [];
	}
}

function isDir(root: string, rel: string): boolean {
	try {
		return statSync(join(root, rel)).isDirectory();
	} catch {
		return false;
	}
}

function isFile(root: string, rel: string): boolean {
	try {
		return statSync(join(root, rel)).isFile();
	} catch {
		return false;
	}
}

/* -------------------------------------------------------------------------- */
/* Tree walk                                                                   */
/* -------------------------------------------------------------------------- */

export interface WalkEntry {
	readonly rel: string;
	readonly bytes: number;
}

/**
 * Walk `root` with the shared ignore list. Directories listed in `excludePrefix`
 * are skipped entirely (the framework's own runtime dir must never be scanned:
 * snapshots are copies, reports quote old paths).
 */
export function walk(
	root: string,
	options: { excludePrefix?: string[]; maxDepth?: number; maxFiles?: number } = {},
): WalkEntry[] {
	const out: WalkEntry[] = [];
	const maxDepth = options.maxDepth ?? SCAN.maxDepth;
	const maxFiles = options.maxFiles ?? SCAN.maxFiles;
	const excluded = options.excludePrefix ?? [];

	const visit = (rel: string, depth: number): boolean => {
		if (out.length >= maxFiles) return false;
		let names: string[];
		try {
			names = readdirSync(join(root, rel), { withFileTypes: true })
				.map((entry) => `${entry.isDirectory() ? "d:" : "f:"}${entry.name}`)
				.sort();
		} catch {
			return true;
		}
		for (const tagged of names) {
			const kind = tagged.slice(0, 2);
			const name = tagged.slice(2);
			const child = rel === "" ? name : `${rel}/${name}`;
			if (excluded.some((prefix) => child === prefix || child.startsWith(`${prefix}/`))) {
				continue;
			}
			if (kind === "d:") {
				if (SCAN.ignoreDirs.has(name)) continue;
				if (depth >= maxDepth) continue;
				if (!visit(child, depth + 1)) return false;
				continue;
			}
			let bytes = 0;
			try {
				bytes = statSync(join(root, child)).size;
			} catch {
				continue;
			}
			out.push({ rel: child, bytes });
			if (out.length >= maxFiles) return false;
		}
		return true;
	};

	visit("", 0);
	return out;
}

export function isTextExtension(rel: string): boolean {
	const dot = rel.lastIndexOf(".");
	if (dot < 0) return false;
	return SCAN.refExtensions.has(rel.slice(dot).toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Reference scan                                                              */
/* -------------------------------------------------------------------------- */

const REF_NAMES = ["memory/", "implementations/"] as const;

/**
 * True when the occurrence at `index` is a *bare* reference: not already under
 * `.agents/`, not a longer hyphenated name (`my-memory/`), and not the tail of
 * somebody else's absolute path (`~/.pi/agent/memory/`).
 *
 * Relative prefixes are part of the reference, not a reason to skip it:
 * `../memory/X.md` and `./memory/X.md` must be rewritten just like `memory/X.md`
 * (the prefix is preserved, only the directory name changes).
 */
export function isBareRef(text: string, index: number, name: string): boolean {
	if (text.startsWith(name, index) === false) return false;
	const before = text.slice(Math.max(0, index - 32), index);
	if (before.endsWith(".agents/")) return false;
	const prev = index > 0 ? text[index - 1] : "";
	if (prev === "/") {
		const prefix = text.slice(0, index);
		// Only `./` and one or more `../` count as a reference prefix. Anything
		// else (`agent/memory/`, `/memory/`) is a different path altogether.
		return /(?:\.\.\/)+$/.test(prefix) || /\.\/$/.test(prefix);
	}
	// `-` continues a compound name (`my-memory/`); letters, digits and `.` are
	// the same story (`foo.memory/`).
	if (prev && /[A-Za-z0-9_.-]/.test(prev)) return false;
	return true;
}

/** Count bare occurrences of `name` in `text`. */
export function countBareRefs(text: string, name: string): number {
	let count = 0;
	let index = text.indexOf(name);
	while (index >= 0) {
		if (isBareRef(text, index, name)) count += 1;
		index = text.indexOf(name, index + name.length);
	}
	return count;
}

function areaOf(rel: string): string {
	const slash = rel.indexOf("/");
	return slash < 0 ? "(root)" : rel.slice(0, slash);
}

export function scanRefs(root: string): RefScan {
	const entries = walk(root, { excludePrefix: [FRAMEWORK_DIR] });
	const byArea: Record<string, RefArea> = {};
	const examples: RefScan["examples"] = [];
	const paths: string[] = [];
	let files = 0;
	let hits = 0;

	for (const entry of entries) {
		if (entry.bytes === 0 || entry.bytes > SCAN.maxFileBytes) continue;
		if (!isTextExtension(entry.rel)) continue;
		const text = readTextFile(root, entry.rel);
		if (text === undefined) continue;
		files += 1;
		let fileHits = 0;
		for (const name of REF_NAMES) fileHits += countBareRefs(text, name);
		if (fileHits === 0) continue;
		hits += fileHits;
		paths.push(entry.rel);
		const area = areaOf(entry.rel);
		const bucket = (byArea[area] ??= { files: 0, hits: 0 });
		bucket.files += 1;
		bucket.hits += fileHits;
		if (examples.length < 8) {
			const line = lineOfFirstRef(text);
			examples.push({
				path: entry.rel,
				line,
				text: firstRefLine(text) ?? "",
			});
		}
	}

	return { files, hits, byArea, examples, paths };
}

function lineOfFirstRef(text: string): number {
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		for (const name of REF_NAMES) {
			let at = lines[index].indexOf(name);
			while (at >= 0) {
				if (isBareRef(lines[index], at, name)) return index + 1;
				at = lines[index].indexOf(name, at + name.length);
			}
		}
	}
	return 1;
}

function firstRefLine(text: string): string | undefined {
	const lines = text.split("\n");
	for (const line of lines) {
		for (const name of REF_NAMES) {
			let at = line.indexOf(name);
			while (at >= 0) {
				if (isBareRef(line, at, name)) return line.trim().slice(0, 160);
				at = line.indexOf(name, at + name.length);
			}
		}
	}
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* Git                                                                         */
/* -------------------------------------------------------------------------- */

function git(args: string[], root: string): string | undefined {
	try {
		return execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 8 * 1024 * 1024,
		});
	} catch {
		return undefined;
	}
}

function gitInfo(root: string): Pick<Facts, "isGit" | "gitClean" | "gitDirtyCount"> {
	const inside = git(["rev-parse", "--is-inside-work-tree"], root);
	if (inside?.trim() !== "true") return { isGit: false };
	const status = git(["status", "--porcelain"], root);
	if (status === undefined) return { isGit: true };
	const lines = status.split("\n").filter((line) => line.length > 0);
	return { isGit: true, gitClean: lines.length === 0, gitDirtyCount: lines.length };
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export function loadState(root: string): { state?: FrameworkState; error?: string } {
	if (!existsSync(join(root, STATE_FILE))) return {};
	try {
		const raw = readFileSync(join(root, STATE_FILE), "utf8");
		return { state: parseState(raw) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Defensive reader for our own state file: unknown or missing fields fall back
 * instead of throwing, so a partially hand-edited state file still produces a
 * plan (and a warning) rather than a dead command.
 */
export function parseState(raw: string): FrameworkState {
	const data = parseToml(raw) as Record<string, unknown>;
	const version = Number(data.version ?? 0);
	const tool = String(data.tool ?? "");
	const created = String(data.created ?? "");
	const updated = String(data.updated ?? created);
	const profile = data.profile === "full" ? "full" : "core";
	const modules = Array.isArray(data.modules) ? data.modules.map(String) : [];
	const lang = data.lang === "zh" ? "zh" : "en";
	const budgets = data.budgets as Record<string, unknown> | undefined;
	const roots = Array.isArray(data.roots)
		? (data.roots as Array<Record<string, unknown>>).map((entry) => ({
				label: String(entry.label ?? ""),
				path: String(entry.path ?? ""),
				absolute: String(entry.absolute ?? ""),
				role: entry.role === undefined ? undefined : String(entry.role),
				agentsMd:
					entry.agents_md === "scope-card" ||
					entry.agents_md === "independent" ||
					entry.agents_md === "none"
						? (entry.agents_md as RootInfo["agentsMd"])
						: "unknown",
				source: "state" as const,
				exists: true,
				lastSeen: entry.last_seen === undefined ? undefined : String(entry.last_seen),
			}))
		: [];
	const managed = Array.isArray(data.managed)
		? (data.managed as Array<Record<string, unknown>>).map((entry) => ({
				path: String(entry.path ?? ""),
				sha256: String(entry.sha256 ?? ""),
				template: String(entry.template ?? ""),
			}))
		: [];
	const migrations = Array.isArray(data.migrations)
		? (data.migrations as Array<Record<string, unknown>>).map((entry) => ({
				at: String(entry.at ?? ""),
				to: String(entry.to ?? ""),
				notes: entry.notes === undefined ? undefined : String(entry.notes),
			}))
		: [];
	return {
		version: Number.isFinite(version) ? version : 0,
		tool,
		created,
		updated,
		profile,
		modules,
		lang,
		budgets: budgets
			? {
					agentsMdSoftChars: numberOrUndefined(
						budgets.agents_md_soft_chars ?? budgets.agentsMdSoftChars,
					),
					agentsMdHardChars: numberOrUndefined(
						budgets.agents_md_hard_chars ?? budgets.agentsMdHardChars,
					),
					memoryFileChars: numberOrUndefined(
						budgets.memory_file_chars ?? budgets.memoryFileChars,
					),
				}
			: undefined,
		roots,
		managed,
		migrations,
	};
}

function numberOrUndefined(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/* -------------------------------------------------------------------------- */
/* Language                                                                    */
/* -------------------------------------------------------------------------- */

export function detectLanguage(
	root: string,
	fallback: ProjectLanguage = "en",
): ProjectLanguage {
	const candidates = ["AGENTS.md", "README.md", "README.zh-CN.md", "readme.md"];
	for (const candidate of candidates) {
		const text = readTextFile(root, candidate);
		if (!text) continue;
		const sample = text.slice(0, 20_000);
		let cjk = 0;
		let visible = 0;
		for (const char of sample) {
			const code = char.codePointAt(0) ?? 0;
			if (code <= 32) continue;
			visible += 1;
			if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
		}
		if (visible === 0) continue;
		return cjk / visible >= 0.08 ? "zh" : "en";
	}
	return fallback;
}

/* -------------------------------------------------------------------------- */
/* Project facts                                                               */
/* -------------------------------------------------------------------------- */

const MANIFESTS = [
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"composer.json",
	"Gemfile",
	"mix.exs",
];

const LOCKFILES: Array<[string, string]> = [
	["pnpm-lock.yaml", "pnpm"],
	["package-lock.json", "npm"],
	["yarn.lock", "yarn"],
	["bun.lockb", "bun"],
	["Cargo.lock", "cargo"],
	["uv.lock", "uv"],
	["poetry.lock", "poetry"],
	["Pipfile.lock", "pipenv"],
	["go.sum", "go"],
];

function detectProject(root: string): ProjectFacts {
	const manifests = MANIFESTS.filter((name) => isFile(root, name));
	const lockfiles: string[] = [];
	let pkgManager: string | undefined;
	for (const [name, manager] of LOCKFILES) {
		if (!isFile(root, name)) continue;
		lockfiles.push(name);
		pkgManager ??= manager;
	}
	const licenseName = listDir(root, "").find((name) =>
		/^(LICENSE|LICENCE|COPYING)(\..*)?$/i.test(name),
	);
	const ci: string[] = [];
	if (isDir(root, ".github/workflows")) {
		for (const name of listDir(root, ".github/workflows")) {
			if (/\.ya?ml$/i.test(name)) ci.push(`.github/workflows/${name}`);
		}
	}
	if (isFile(root, ".gitlab-ci.yml")) ci.push(".gitlab-ci.yml");
	if (isFile(root, "azure-pipelines.yml")) ci.push("azure-pipelines.yml");
	if (isFile(root, "Jenkinsfile")) ci.push("Jenkinsfile");

	const scripts: Record<string, string> = {};
	const pkg = readTextFile(root, "package.json");
	if (pkg) {
		try {
			const parsed = JSON.parse(pkg) as {
				scripts?: Record<string, string>;
				packageManager?: string;
			};
			for (const [key, value] of Object.entries(parsed.scripts ?? {})) {
				if (typeof value === "string") scripts[key] = value;
			}
			if (parsed.packageManager) {
				pkgManager = parsed.packageManager.split("@")[0];
			}
		} catch {
			// A malformed manifest is a project problem, not an init failure.
		}
	}

	return { manifests, lockfiles, license: licenseName, ci, scripts, pkgManager };
}

/* -------------------------------------------------------------------------- */
/* Roots                                                                       */
/* -------------------------------------------------------------------------- */

function classifyRootAgentsMd(root: string, absolute: string): RootInfo["agentsMd"] {
	const rel = toPosix(relative(root, absolute));
	const agentsRel = rel === "" ? "AGENTS.md" : posix.join(rel, "AGENTS.md");
	if (!isFile(root, agentsRel)) return "none";
	const text = readTextFile(root, agentsRel) ?? "";
	const lines = text.split("\n").length;
	// A secondary root that already carries the framework contract owns its own
	// memory; we must not treat it as a scope card.
	if (text.includes(".agents/memory") || text.includes("agent-framework")) {
		return "independent";
	}
	return lines <= 40 ? "scope-card" : "independent";
}

export function mergeRoots(
	root: string,
	stateRoots: RootInfo[],
	added: Array<{ label: string; absolute: string }>,
): RootInfo[] {
	const byAbsolute = new Map<string, RootInfo>();
	for (const entry of stateRoots) {
		byAbsolute.set(entry.absolute, {
			...entry,
			exists: existsSync(entry.absolute),
			agentsMd: classifyRootAgentsMd(root, entry.absolute),
		});
	}
	for (const entry of added) {
		const rel = toPosix(relative(root, entry.absolute));
		const inside = !rel.startsWith("..");
		byAbsolute.set(entry.absolute, {
			label: entry.label,
			path: inside ? rel : entry.absolute,
			absolute: entry.absolute,
			agentsMd: classifyRootAgentsMd(root, entry.absolute),
			source: "add-dir",
			exists: existsSync(entry.absolute),
		});
	}
	return [...byAbsolute.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/* -------------------------------------------------------------------------- */
/* The survey                                                                  */
/* -------------------------------------------------------------------------- */

export interface DetectOptions {
	/** Absolute paths added via pi-add-dir in this session. */
	readonly addedRoots?: Array<{ label: string; absolute: string }>;
	/** Language override (`--lang`). */
	readonly lang?: ProjectLanguage;
}

function readDocs(root: string, rel: string, keep: (name: string) => boolean): DocInfo[] {
	const docs: DocInfo[] = [];
	for (const name of listDir(root, rel)) {
		if (!name.endsWith(".md") || !keep(name)) continue;
		const doc = readDoc(root, `${rel}/${name}`);
		if (doc) docs.push(doc);
	}
	return docs;
}

function readFiles(root: string, rel: string): FileInfo[] {
	const files: FileInfo[] = [];
	for (const name of listDir(root, rel)) {
		if (!name.endsWith(".md")) continue;
		const info = statFile(root, `${rel}/${name}`);
		if (info) files.push(info);
	}
	return files;
}

function countFilesUnder(root: string, rel: string, limit = 5000): number {
	let count = 0;
	const visit = (current: string): void => {
		if (count >= limit) return;
		for (const name of listDir(root, current)) {
			if (count >= limit) return;
			const child = `${current}/${name}`;
			if (isDir(root, child)) {
				if (SCAN.ignoreDirs.has(name)) continue;
				visit(child);
				continue;
			}
			count += 1;
		}
	};
	visit(rel);
	return count;
}

function readDeprecated(root: string): {
	deprecated: Facts["deprecated"];
	deprecatedFiles: Facts["deprecatedFiles"];
	retiredTodos: boolean;
} {
	const deprecated = {
		memory: isDir(root, DEPRECATED_ROOT_DIRS[0]),
		implementations: isDir(root, DEPRECATED_ROOT_DIRS[1]),
		prompts: isDir(root, DEPRECATED_ROOT_DIRS[2]),
	};
	return {
		deprecated,
		deprecatedFiles: {
			memory: deprecated.memory ? countFilesUnder(root, "memory") : 0,
			implementations: deprecated.implementations ? countFilesUnder(root, "implementations") : 0,
			prompts: deprecated.prompts ? countFilesUnder(root, "prompts") : 0,
		},
		retiredTodos: isDir(root, RETIRED_ROOT_DIRS[0]),
	};
}

function readLegacyDocs(root: string): DocInfo[] {
	const docs: DocInfo[] = [];
	for (const name of [...LEGACY_DOC_NAMES, ".github/copilot-instructions.md", ".cursorrules", ".windsurfrules"]) {
		if (!isFile(root, name)) continue;
		const doc = readDoc(root, name);
		if (doc) docs.push(doc);
	}
	if (isDir(root, ".cursor/rules")) {
		docs.push(...readDocs(root, ".cursor/rules", () => true));
	}
	for (const rel of ["adr", "decisions", "docs/adr", "docs/decisions"]) {
		if (!isDir(root, rel)) continue;
		docs.push(...readDocs(root, rel, () => true));
	}
	return docs;
}

function readNestedAgents(root: string): FileInfo[] {
	const files: FileInfo[] = [];
	for (const entry of walk(root, { maxDepth: 3 })) {
		if (entry.rel === "AGENTS.md") continue;
		if (!/(^|\/)(AGENTS|CLAUDE)\.md$/.test(entry.rel)) continue;
		const info = statFile(root, entry.rel);
		if (info) files.push(info);
	}
	return files;
}

function readModulesPresent(root: string, memory: readonly DocInfo[]): string[] {
	return MEMORY_MODULES.filter((module) => {
		if (module === "function") {
			return memory.some((doc) => doc.rel.startsWith(".agents/memory/FUNCTION-"));
		}
		return isFile(root, `${MEMORY_DIR}/${module.toUpperCase()}.md`);
	});
}

function readEmptyRootFiles(root: string): string[] {
	return listDir(root, "").filter((name) => {
		const info = statFile(root, name);
		return info !== undefined && info.bytes === 0;
	});
}

function contextWarnings(
	context: Facts["context"],
	state: FrameworkState | undefined,
	stateError: string | undefined,
): string[] {
	const warnings: string[] = [];
	if (stateError) warnings.push(`state file unreadable: ${stateError}`);
	if (state && state.version > FRAMEWORK_VERSION) {
		warnings.push(
			`state version ${state.version} is newer than this tool (${FRAMEWORK_VERSION}); refusing to plan a migration`,
		);
	}
	if (context.override) {
		warnings.push(
			`${OVERRIDE_FILE} exists: pi loads it instead of AGENTS.md in this directory, so the framework entry is invisible to the agent`,
		);
	}
	if (!context.agents && context.claude) {
		warnings.push("only CLAUDE.md exists; AGENTS.md is the pi entry and will be created");
	}
	return warnings;
}

export function detect(root: string, options: DetectOptions = {}): Facts {
	const { state, error: stateError } = loadState(root);
	const context = {
		agents: readDoc(root, "AGENTS.md"),
		claude: readDoc(root, "CLAUDE.md"),
		override: readDoc(root, OVERRIDE_FILE),
		piAgents: readDoc(root, ".pi/AGENTS.md"),
	};
	const dirs: Record<string, boolean> = {};
	for (const rel of [
		AGENTS_DIR,
		MEMORY_DIR,
		IMPLEMENTATIONS_DIR,
		PROMPTS_DIR,
		FRAMEWORK_DIR,
		SPECS_DIR,
		"design",
		"docs",
		"legal",
	]) {
		dirs[rel] = isDir(root, rel);
	}

	const memory = readDocs(
		root,
		MEMORY_DIR,
		// PLAN.md is not a memory file in v1, but an older install may still
		// have one here; it must stay visible so the plan can move it to specs/.
		(name) => isMemoryFileName(name) || name === "PLAN.md",
	);
	const legacyMemory = readDocs(root, "memory", () => true);
	const specs = readDocs(root, SPECS_DIR, () => true);
	const implementations = [
		...readFiles(root, IMPLEMENTATIONS_DIR),
		...readFiles(root, "implementations"),
	];
	const todos = readDocs(root, "todos", () => true);
	const { deprecated, deprecatedFiles, retiredTodos } = readDeprecated(root);

	return {
		root,
		...gitInfo(root),
		state,
		stateError,
		context,
		dirs,
		deprecated,
		deprecatedFiles,
		retiredTodos,
		rootEmptyFiles: readEmptyRootFiles(root),
		memory,
		legacyMemory,
		specs,
		implementations,
		todos,
		legacyDocs: readLegacyDocs(root),
		nestedAgents: readNestedAgents(root),
		modulesPresent: readModulesPresent(root, memory),
		refs: scanRefs(root),
		project: detectProject(root),
		language: options.lang ?? state?.lang ?? detectLanguage(root),
		roots: mergeRoots(root, state?.roots ?? [], options.addedRoots ?? []),
		warnings: contextWarnings(context, state, stateError),
	};
}

/** Module ids recognised inside `.agents/memory/`. */
const MEMORY_MODULES = ["design", "terms", "review", "debugging", "function"] as const;
