/**
 * init feature — the deterministic half of a run.
 *
 * Guarantees, in the order they are enforced:
 *
 *  1. **Nothing is touched before it is snapshotted.** A copy of every path the
 *     plan may write lives under `.agents/framework/snapshots/<stamp>/` with a
 *     sha256 manifest and the `git status` of the moment.
 *  2. **Writes stay inside the repository.** Every path is resolved and checked;
 *     added roots are never written here (they go through the permission gate as
 *     ordinary tool calls in the model stage).
 *  3. **Existing files are never clobbered.** A create skips an existing path; a
 *     move refuses a non-empty destination and turns it into a manual task.
 *  4. **Counts are reconciled.** The rewrite uses the same bare-reference
 *     predicate as the survey, so the reported number matches the plan's number.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import {
	CONTRACT_FILE,
	FRAMEWORK_DIR,
	FRAMEWORK_VERSION,
	IMPLEMENTATIONS_DIR,
	MEMORY_DIR,
	PLAN_FILE,
	REPORTS_DIR,
	SIGNPOST_FILE,
	SPECS_DIR,
	STATE_FILE,
	SCAN,
	STATE_GITIGNORE,
} from "./spec.js";
import { isBareRef, readDoc, walk } from "./detect.js";
import { renderTemplate } from "./templates.js";
import { buildCoverage, renderCoverage } from "./coverage.js";
import { serializeWorkOrder } from "./dispatch.js";
import { runStamp } from "./plan.js";
import type {
	Action,
	ApplyResult,
	CreateFileAction,
	DocInfo,
	FrameworkState,
	Plan,
	RewriteAction,
} from "./types.js";

export interface ApplyOptions {
	readonly dryRun?: boolean;
	/** Test seam: pretend the clock, so paths are predictable. */
	readonly now?: Date;
}

/* -------------------------------------------------------------------------- */
/* Paths and hashing                                                           */
/* -------------------------------------------------------------------------- */

function inside(root: string, rel: string): string {
	const absolute = resolve(root, rel);
	const base = resolve(root);
	if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
		throw new Error(`refusing to write outside the repository: ${rel}`);
	}
	return absolute;
}

function sha256File(absolute: string): string {
	return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

function mkdirFor(absolute: string): void {
	mkdirSync(dirname(absolute), { recursive: true });
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                    */
/* -------------------------------------------------------------------------- */

interface SnapshotResult {
	readonly dir: string;
	readonly files: number;
}

function snapshot(root: string, paths: string[], stamp: string): SnapshotResult {
	const target = join(FRAMEWORK_DIR, "snapshots", stamp);
	const absoluteTarget = inside(root, target);
	mkdirSync(absoluteTarget, { recursive: true });

	const manifest: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	let files = 0;
	for (const rel of paths) {
		if (seen.has(rel)) continue;
		seen.add(rel);
		const source = inside(root, rel);
		if (!existsSync(source)) continue;
		const stat = statSync(source);
		if (stat.isDirectory()) {
			const entries = walk(root, { excludePrefix: [FRAMEWORK_DIR] }).filter(
				(entry) => entry.rel === rel || entry.rel.startsWith(`${rel}/`),
			);
			for (const entry of entries) {
				if (seen.has(entry.rel)) continue;
				seen.add(entry.rel);
				const from = inside(root, entry.rel);
				const to = join(absoluteTarget, "files", entry.rel);
				mkdirFor(to);
				copyFileSync(from, to);
				manifest.push({ path: entry.rel, bytes: statSync(from).size, sha256: sha256File(from) });
				files += 1;
			}
		} else {
			const to = join(absoluteTarget, "files", rel);
			mkdirFor(to);
			copyFileSync(source, to);
			manifest.push({ path: rel, bytes: stat.size, sha256: sha256File(source) });
			files += 1;
		}
	}

	let gitStatus = "";
	try {
		gitStatus = execFileSync("git", ["-C", root, "status", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		// Not a git repository: the manifest stands on its own.
	}

	writeFileSync(
		join(absoluteTarget, "manifest.json"),
		`${JSON.stringify(
			{
				created: new Date().toISOString(),
				framework: FRAMEWORK_VERSION,
				root,
				gitStatus,
				files: manifest,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return { dir: target, files };
}

/* -------------------------------------------------------------------------- */
/* Moves                                                                       */
/* -------------------------------------------------------------------------- */

interface MoveResult {
	readonly ok: boolean;
	readonly files: number;
	readonly reason?: string;
}

function moveDir(root: string, from: string, to: string): MoveResult {
	const source = inside(root, from);
	const destination = inside(root, to);
	if (!existsSync(source)) return { ok: false, files: 0, reason: "source missing" };
	if (existsSync(destination)) return { ok: false, files: 0, reason: "destination exists" };
	mkdirSync(dirname(destination), { recursive: true });

	const count = (): number => {
		const stat = statSync(destination);
		if (!stat.isDirectory()) return 1;
		let files = 0;
		const visit = (current: string): void => {
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const child = join(current, entry.name);
				if (entry.isDirectory()) visit(child);
				else files += 1;
			}
		};
		visit(destination);
		return files;
	};

	try {
		execFileSync("git", ["-C", root, "mv", from, to], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return { ok: true, files: count() };
	} catch {
		try {
			renameSync(source, destination);
			return { ok: true, files: count() };
		} catch (error) {
			return {
				ok: false,
				files: 0,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Reference rewrite                                                           */
/* -------------------------------------------------------------------------- */

export interface RewriteStat {
	readonly path: string;
	readonly hits: number;
}

export interface RewriteResult {
	readonly files: number;
	readonly hits: number;
	readonly stats: RewriteStat[];
}

/**
 * Apply the ordered pairs to one text. The first pair that matches at a given
 * position wins, so `memory/PLAN.md → specs/PLAN.md` runs before the broader
 * `memory/ → .agents/memory/`.
 */
export function rewriteText(
	text: string,
	pairs: ReadonlyArray<{ from: string; to: string }>,
): { text: string; hits: number } {
	if (pairs.length === 0) return { text, hits: 0 };
	let out = "";
	let index = 0;
	let hits = 0;
	while (index < text.length) {
		let best: { pair: { from: string; to: string }; at: number } | undefined;
		for (const pair of pairs) {
			const at = text.indexOf(pair.from, index);
			if (at < 0) continue;
			if (
				!best ||
				at < best.at ||
				(at === best.at && pair.from.length > best.pair.from.length)
			) {
				best = { pair, at };
			}
		}
		if (!best) {
			out += text.slice(index);
			break;
		}
		out += text.slice(index, best.at);
		const { pair, at } = best;
		const length = pair.from.length;
		if (isBareRef(text, at, pair.from)) {
			out += pair.to;
			hits += 1;
		} else {
			out += text.slice(at, at + length);
		}
		index = at + length;
	}
	return { text: out, hits };
}

function rewriteRefs(root: string, action: RewriteAction): RewriteResult {
	const entries = walk(root, { excludePrefix: [FRAMEWORK_DIR] });
	let files = 0;
	let hits = 0;
	const stats: RewriteStat[] = [];
	for (const entry of entries) {
		if (entry.bytes === 0 || entry.bytes > SCAN.maxFileBytes) continue;
		const absolute = inside(root, entry.rel);
		const buffer = readFileSync(absolute);
		if (buffer.subarray(0, 8192).includes(0)) continue;
		const text = buffer.toString("utf8");
		// Never "rewrite" a file that is not valid UTF-8: decoding would replace
		// bytes and writing it back would silently corrupt the document.
		if (!buffer.equals(Buffer.from(text, "utf8"))) continue;
		const result = rewriteText(text, action.pairs);
		if (result.hits === 0) continue;
		writeFileSync(absolute, result.text, "utf8");
		files += 1;
		hits += result.hits;
		stats.push({ path: entry.rel, hits: result.hits });
	}
	return { files, hits, stats };
}

function renderRewriteReport(
	result: RewriteResult,
	action: RewriteAction,
	createdAt: string,
	root: string,
): string {
	const byArea = new Map<string, { files: number; hits: number }>();
	for (const entry of result.stats) {
		const slash = entry.path.indexOf("/");
		const area = slash < 0 ? entry.path : entry.path.slice(0, slash);
		const bucket = byArea.get(area) ?? { files: 0, hits: 0 };
		bucket.files += 1;
		bucket.hits += entry.hits;
		byArea.set(area, bucket);
	}
	const rows = [...byArea.entries()]
		.sort((a, b) => b[1].hits - a[1].hits)
		.map(([area, bucket]) => `| \`${area}\` | ${bucket.files} | ${bucket.hits} |`);
	const files = result.stats
		.slice(0, 300)
		.map((entry) => `| \`${entry.path}\` | ${entry.hits} |`);
	if (result.stats.length > 300) files.push(`| … ${result.stats.length - 300} more | |`);
	return [
		"# Path rewrite",
		"",
		`- created: ${createdAt}`,
		`- root: ${root}`,
		`- pairs: ${action.pairs.map((pair) => `${pair.from} → ${pair.to}`).join(", ")}`,
		`- planned: ${action.hits} occurrences in ${action.files} files`,
		`- done: ${result.hits} occurrences in ${result.files} files`,
		"",
		"## By area",
		"",
		"| Area | Files | Occurrences |",
		"| --- | --- | --- |",
		...rows,
		"",
		"## Files",
		"",
		"| File | Occurrences |",
		"| --- | --- |",
		...files,
		"",
	].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Creates                                                                     */
/* -------------------------------------------------------------------------- */

function createFile(
	root: string,
	action: CreateFileAction,
	language: Plan["language"],
): string | undefined {
	const absolute = inside(root, action.path);
	if (existsSync(absolute)) return undefined;
	mkdirFor(absolute);
	const body = renderTemplate(action.template, action.tokens, language);
	writeFileSync(absolute, body, "utf8");
	return body;
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

function compact<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

export function stateToToml(state: FrameworkState): string {
	const doc = compact({
		version: state.version,
		tool: state.tool,
		created: state.created,
		updated: state.updated,
		profile: state.profile,
		modules: state.modules,
		lang: state.lang,
		budgets: state.budgets
			? compact({
					agents_md_soft_chars: state.budgets.agentsMdSoftChars,
					agents_md_hard_chars: state.budgets.agentsMdHardChars,
					memory_file_chars: state.budgets.memoryFileChars,
				})
			: undefined,
		roots: state.roots.map((root) =>
			compact({
				label: root.label,
				path: root.path,
				absolute: root.absolute,
				role: root.role,
				agents_md: root.agentsMd,
				source: root.source,
				last_seen: root.lastSeen,
			}),
		),
		managed: state.managed.map((entry) => ({
			path: entry.path,
			sha256: entry.sha256,
			template: entry.template,
		})),
		migrations: state.migrations.map((entry) =>
			compact({ at: entry.at, to: entry.to, notes: entry.notes }),
		),
	});
	return `${stringifyToml(doc)}\n`;
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                    */
/* -------------------------------------------------------------------------- */

function listDocs(root: string, rel: string): DocInfo[] {
	const docs: DocInfo[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(join(root, rel)).sort();
	} catch {
		return docs;
	}
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const doc = readDoc(root, `${rel}/${name}`);
		if (doc) docs.push(doc);
	}
	return docs;
}

function writeCoverage(
	root: string,
	plan: Plan,
	reportRel: string,
	createdAt: string,
): void {
	const sources: DocInfo[] = [];
	const agents = readDoc(root, "AGENTS.md");
	if (agents) sources.push(agents);
	// The plan file is compared from its pre-move snapshot: after a `move-file`
	// its content lives at specs/PLAN.md and is already a target, so counting it
	// as a source too would report it as “accounted for” by itself.
	sources.push(
		...plan.facts.legacyMemory.filter((doc) => doc.rel === "memory/PLAN.md"),
	);
	sources.push(...plan.facts.todos);
	sources.push(
		...plan.facts.legacyDocs.filter((doc) => doc.rel !== "AGENTS.md" && doc.rel !== PLAN_FILE),
	);
	if (sources.length === 0) return;

	const targets = [
		...listDocs(root, MEMORY_DIR),
		...listDocs(root, SPECS_DIR),
		...listDocs(root, IMPLEMENTATIONS_DIR),
	];
	const report = buildCoverage(sources, targets);
	const body = renderCoverage(report, {
		createdAt,
		sources: sources.map((doc) => doc.rel),
		targets: [MEMORY_DIR, SPECS_DIR, IMPLEMENTATIONS_DIR],
	});
	const absolute = inside(root, reportRel);
	if (existsSync(absolute)) return;
	mkdirFor(absolute);
	writeFileSync(absolute, body, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */


/* -------------------------------------------------------------------------- */
/* Action handlers (one concern each)                                          */
/* -------------------------------------------------------------------------- */

interface ApplyContext {
	readonly root: string;
	readonly stamp: string;
	readonly createdAt: string;
	readonly language: Plan["language"];
	readonly dryRun: boolean;
	readonly moved: ApplyResult["moved"];
	readonly created: string[];
	readonly skipped: ApplyResult["skipped"];
	rewrites?: ApplyResult["rewrites"];
	snapshot?: ApplyResult["snapshot"];
	statePath?: string;
}

function applySnapshot(ctx: ApplyContext, action: Action & { kind: "snapshot" }): void {
	const dir = `${FRAMEWORK_DIR}/snapshots/${ctx.stamp}`;
	if (ctx.dryRun) {
		ctx.snapshot = { dir, files: action.files };
		return;
	}
	ctx.snapshot = snapshot(ctx.root, action.paths, ctx.stamp);
}

function applyCreateDirs(ctx: ApplyContext, action: Action & { kind: "create-dirs" }): void {
	if (ctx.dryRun) return;
	for (const rel of action.paths) mkdirSync(inside(ctx.root, rel), { recursive: true });
}

function applyMoveDir(ctx: ApplyContext, action: Action & { kind: "move-dir" }): void {
	if (ctx.dryRun) {
		ctx.moved.push({ from: action.from, to: action.to, files: action.files });
		return;
	}
	const result = moveDir(ctx.root, action.from, action.to);
	if (result.ok) ctx.moved.push({ from: action.from, to: action.to, files: result.files });
	else ctx.skipped.push({ path: `${action.from}/`, reason: result.reason ?? "move failed" });
}

function applyMoveFile(ctx: ApplyContext, action: Action & { kind: "move-file" }): void {
	if (ctx.dryRun) {
		ctx.moved.push({ from: action.from, to: action.to, files: 1 });
		return;
	}
	const source = inside(ctx.root, action.from);
	const destination = inside(ctx.root, action.to);
	if (!existsSync(source)) {
		ctx.skipped.push({ path: action.from, reason: "source missing" });
		return;
	}
	if (existsSync(destination)) {
		ctx.skipped.push({ path: action.from, reason: "destination exists" });
		return;
	}
	mkdirFor(destination);
	try {
		execFileSync("git", ["-C", ctx.root, "mv", action.from, action.to], {
			stdio: ["ignore", "ignore", "ignore"],
		});
	} catch {
		renameSync(source, destination);
	}
	ctx.moved.push({ from: action.from, to: action.to, files: 1 });
}

function applyRewrite(ctx: ApplyContext, action: Action & { kind: "rewrite-refs" }): void {
	const report = `${REPORTS_DIR}/rewrite-${ctx.stamp}.md`;
	if (ctx.dryRun) {
		ctx.rewrites = { files: action.files, hits: action.hits, report };
		return;
	}
	const result = rewriteRefs(ctx.root, action);
	ctx.rewrites = { files: result.files, hits: result.hits, report };
	const absolute = inside(ctx.root, report);
	mkdirFor(absolute);
	writeFileSync(
		absolute,
		renderRewriteReport(result, action, ctx.createdAt, ctx.root),
		"utf8",
	);
}

function applyCreateFile(ctx: ApplyContext, action: Action & { kind: "create-file" }): void {
	if (ctx.dryRun) {
		ctx.created.push(action.path);
		return;
	}
	const body = createFile(ctx.root, action, ctx.language);
	if (body === undefined) ctx.skipped.push({ path: action.path, reason: "already exists" });
	else ctx.created.push(action.path);
}

function applyWriteState(ctx: ApplyContext, action: Action & { kind: "write-state" }): void {
	if (ctx.dryRun) {
		ctx.statePath = STATE_FILE;
		return;
	}
	ctx.statePath = writeState(ctx.root, action.state);
}

function runAction(ctx: ApplyContext, action: Action): void {
	switch (action.kind) {
		case "snapshot":
			return applySnapshot(ctx, action);
		case "create-dirs":
			return applyCreateDirs(ctx, action);
		case "move-dir":
			return applyMoveDir(ctx, action);
		case "move-file":
			return applyMoveFile(ctx, action);
		case "rewrite-refs":
			return applyRewrite(ctx, action);
		case "create-file":
			return applyCreateFile(ctx, action);
		case "write-state":
			return applyWriteState(ctx, action);
		default: {
			const exhaustive: never = action;
			throw new Error(`unknown action: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

export function applyPlan(plan: Plan, options: ApplyOptions = {}): ApplyResult {
	const stamp = runStamp(plan.createdAt);
	const ctx: ApplyContext = {
		root: plan.root,
		stamp,
		createdAt: plan.createdAt,
		language: plan.language,
		dryRun: options.dryRun === true,
		moved: [],
		created: [],
		skipped: [],
	};

	for (const action of plan.actions) runAction(ctx, action);

	const coverageWritten =
		!ctx.dryRun && plan.artifacts.coverage
			? writeCoverageFile(plan, plan.artifacts.coverage)
			: undefined;
	const planPath = !ctx.dryRun && plan.artifacts.plan ? writeWorkOrder(plan, ctx) : undefined;

	const summary: string[] = [];
	if (ctx.snapshot) summary.push(`snapshot: ${ctx.snapshot.dir} (${ctx.snapshot.files} files)`);
	for (const move of ctx.moved) summary.push(`moved ${move.from}/ → ${move.to}/ (${move.files})`);
	if (ctx.rewrites) {
		summary.push(`rewrote ${ctx.rewrites.hits} references in ${ctx.rewrites.files} files`);
	}
	if (ctx.created.length > 0) summary.push(`created ${ctx.created.length} files`);
	if (coverageWritten) summary.push(`coverage worklist: ${coverageWritten}`);
	if (planPath) summary.push(`work order: ${planPath}`);
	if (ctx.skipped.length > 0) summary.push(`skipped ${ctx.skipped.length} (see report)`);

	return {
		snapshot: ctx.snapshot,
		moved: ctx.moved,
		rewrites: ctx.rewrites,
		created: ctx.created,
		skipped: ctx.skipped,
		statePath: ctx.statePath,
		planPath,
		summary,
	};
}

function writeCoverageFile(plan: Plan, rel: string): string {
	writeCoverage(plan.root, plan, rel, plan.createdAt);
	return rel;
}

function writeWorkOrder(plan: Plan, ctx: ApplyContext): string | undefined {
	if (!plan.artifacts.plan) return undefined;
	const absolute = inside(ctx.root, plan.artifacts.plan);
	mkdirFor(absolute);
	writeFileSync(
		absolute,
		serializeWorkOrder(plan, {
			moved: ctx.moved,
			created: ctx.created,
			skipped: ctx.skipped,
			rewrites: ctx.rewrites,
			snapshot: ctx.snapshot,
			summary: [],
		}),
		"utf8",
	);
	return plan.artifacts.plan;
}

/** Write state, refreshing the hashes of files this framework manages. */
function writeState(root: string, state: FrameworkState): string {
	const managedPaths = [CONTRACT_FILE, SIGNPOST_FILE, STATE_GITIGNORE];
	const previous = new Map(state.managed.map((entry) => [entry.path, entry]));
	const managed: FrameworkState["managed"] = [];
	for (const rel of managedPaths) {
		const absolute = inside(root, rel);
		if (!existsSync(absolute)) continue;
		const template =
			rel === CONTRACT_FILE
				? "memory-readme"
				: rel === SIGNPOST_FILE
					? "signpost"
					: "state-gitignore";
		managed.push({
			path: rel,
			sha256: sha256File(absolute),
			template: previous.get(rel)?.template ?? template,
		});
	}
	const absolute = inside(root, STATE_FILE);
	mkdirFor(absolute);
	writeFileSync(absolute, stateToToml({ ...state, managed }), "utf8");
	return STATE_FILE;
}
