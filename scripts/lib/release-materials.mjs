/**
 * Release materials — everything `pnpm release` must have BEFORE it does any work.
 *
 * Why this is a module instead of a few `if` blocks in the script: discovering an
 * empty `## Unreleased` AFTER typecheck/test/UI gates have run costs two minutes
 * and fails in the worst possible environment — a terminal with no agent attached,
 * where the fix (writing release notes) is exactly what an agent is for. So every
 * gap that is knowable up front is collected in one pass, printed as one list, and
 * the script stops before touching anything (no gates, no writes, no commit, no push).
 *
 * Levels:
 *   ok    — material present;
 *   warn  — explicitly bypassed by a flag (`--skip-changelog`, `--skip-tail-check`);
 *   block — the release cannot be correct without it; stop now.
 *
 * Pure: no fs, no git, no network. The caller feeds facts; tests feed cells.
 */

/** Human labels for `releaseTailGap` states (shared with `--dry-run`). */
export const TAIL_LABEL = {
	ok: "已就位",
	absent: "远端缺失",
	mismatch: "远端指向别的提交",
	unknown: "无法确认（git 探测失败或超时）",
	"missing-local-tag": "本地无此 tag",
	skipped: "跳过（--skip-tail-check）",
};

const NOTES_FIX = [
	"把这一版的用户可见变更写进 CHANGELOG.md 的 `## Unreleased`，一行一条顶格 `- `，例如：",
	"- **scope** — what the operator can now do, in one sentence.",
	"缩进子项、`### 小节` 标题、HTML 注释都不算条目（解析器只认顶格 bullet）。",
	"最省事的是交给 agent：它应当在这次变更的提交里就写好备注，而不是留到发版时补。",
].join("\n");

/**
 * The next action for a failed previous-release tail check. Kept next to the
 * states themselves so the advice cannot drift from the verdict.
 */
function tailFix({ state, current, next, tailTag, arg, tail }) {
	switch (state) {
		case "missing-local-tag":
			return [
				`本地没有 tag ${tailTag}，无法确认 ${current} 是否已发布。`,
				`若 ${current} 确实在 npm 上、本地只是丢了 tag：git tag ${tailTag} <发布提交>，然后重跑。`,
				`若它从未发布过：先修好 package.json 的版本号。`,
			].join("\n");
		case "absent":
			return [
				`远端没有 tag ${tailTag} —— 上一版很可能在推 tag 之前被打断。`,
				`先补完尾部：pnpm release:github ${tailTag}（推 tag + 校验 + 建 Release，不碰 npm，幂等）`,
				`否则这次会发出 v${next}，内容与 ${current} 逐字节相同（只有 version 一行不同）。`,
				`确认要跳过：pnpm release ${arg} --skip-tail-check`,
			].join("\n");
		case "mismatch":
			return [
				`远端 tag ${tailTag} 指向 ${(tail?.remoteSha ?? "").slice(0, 7) || "?"}，本地指向 ${(tail?.localSha ?? "").slice(0, 7) || "?"}。`,
				`人工确认后（远端不对就 git push origin refs/tags/${tailTag} --force）再发版。`,
			].join("\n");
		case "unknown":
			return [
				"git 无法核实远端 tag（网络 / SSH 失败或超时），这不等于远端没有 tag。",
				`先手动复核：git ls-remote origin refs/tags/${tailTag}`,
				"恢复网络 / SSH 后重跑；只有人工确认风险后才用 --skip-tail-check 跳过。",
			].join("\n");
		default:
			return `无法判定 ${tailTag} 的发布状态（${String(state)}）。`;
	}
}

/**
 * @param {{
 *   current: string,
 *   next: string,
 *   arg: string,
 *   dirty?: string,
 *   changelog?: { state: "ready" | "empty" | "missing", count: number },
 *   filesIncludeChangelog?: boolean,
 *   nextTagExists?: boolean,
 *   tail?: { state: string, localSha?: string, remoteSha?: string },
 *   skipChangelog?: boolean,
 *   skipTailCheck?: boolean,
 * }} input
 * @returns {{
 *   items: Array<{ id: string, level: "ok" | "warn" | "block", title: string, detail?: string, fix?: string }>,
 *   blocked: boolean,
 *   blocking: string[],
 *   promoteNotes: boolean,
 * }}
 */
export function assessReleaseMaterials(input) {
	const {
		current,
		next,
		arg,
		dirty = "",
		changelog = { state: "missing", count: 0 },
		filesIncludeChangelog = false,
		nextTagExists = false,
		tail,
		skipChangelog = false,
		skipTailCheck = false,
	} = input;

	const tailTag = `v${current}`;
	const items = [];
	const add = (id, level, title, extra = {}) =>
		items.push({ id, level, title, ...extra });

	// 1. Working tree — the published tarball is packed from the workspace, the
	//    tag is not. Uncommitted work would ship to npm without being in the tag
	//    (v0.4.0 incident).
	if (dirty) {
		add("tree", "block", "工作区有未提交变更", {
			detail: dirty,
			fix: [
				"先把工作提交干净（临时文件加进 .gitignore），再重跑。",
				"未提交内容会进 npm 包却不进 tag —— v0.4.0 事故就是这么来的。",
			].join("\n"),
		});
	} else {
		add("tree", "ok", "工作区干净");
	}

	// 2. Release notes — the extension announces the section between the
	//    operator's last version and this one, so a release with no notes ships
	//    an announcement with nothing in it.
	if (skipChangelog) {
		add("changelog", "warn", "CHANGELOG.md 未提升（--skip-changelog）：本版不会有启动公告");
	} else if (changelog.state === "missing") {
		add("changelog", "block", "CHANGELOG.md 没有 `## Unreleased` 段落", {
			fix: NOTES_FIX,
		});
	} else if (changelog.state === "empty") {
		add("changelog", "block", "CHANGELOG.md 的 `## Unreleased` 没有顶格 `- ` 条目", {
			fix: NOTES_FIX,
		});
	} else {
		add(
			"changelog",
			"ok",
			`CHANGELOG.md \`## Unreleased\`：${changelog.count} 条待发布 → \`## ${next}\``,
		);
	}

	// 3. The changelog must actually travel with the package.
	if (filesIncludeChangelog) {
		add("files", "ok", "package.json files 含 CHANGELOG.md");
	} else {
		add("files", "block", "package.json files 不含 CHANGELOG.md", {
			fix: '把 "CHANGELOG.md" 加进 package.json 的 files：安装后的包没有它，升级公告就永远是空的。',
		});
	}

	// 4. The version being released must not already have a tag — `tag-current`
	//    would skip it and the post-commit self-check would fail with the tag
	//    pointing at the previous HEAD, i.e. after the commit was already made.
	if (nextTagExists) {
		add("next-tag", "block", `本地已存在 tag v${next}`, {
			fix: [
				`先确认它有没有推出去：git ls-remote origin refs/tags/v${next}`,
				`没推过就删掉本地 tag（git tag -d v${next}）并重跑；已推过就换一个版本号。`,
			].join("\n"),
		});
	} else {
		add("next-tag", "ok", `本地没有 tag v${next}`);
	}

	// 5. The previous release must really be finished — an interrupted release
	//    makes the next one byte-identical apart from the version line.
	if (skipTailCheck) {
		add("tail", "warn", `上一版 ${tailTag} 的远端 tag：跳过校验（--skip-tail-check）`);
	} else if (tail?.state === "ok") {
		const sha = (tail.localSha ?? "").slice(0, 7);
		add("tail", "ok", `上一版 v${current} 的远端 tag 已就位${sha ? ` → ${sha}` : ""}`);
	} else {
		const state = tail?.state ?? "unknown";
		add("tail", "block", `上一版 v${current} 的远端 tag：${TAIL_LABEL[state] ?? state}`, {
			fix: tailFix({ state, current, next, tailTag, arg, tail }),
		});
	}

	const blocking = items.filter((item) => item.level === "block").map((item) => item.id);

	return {
		items,
		blocked: blocking.length > 0,
		blocking,
		promoteNotes: !skipChangelog && changelog.state === "ready",
	};
}
