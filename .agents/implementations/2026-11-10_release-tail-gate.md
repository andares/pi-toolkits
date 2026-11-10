# 2026-11-10T21:10:00+08:00 — 发版尾部闸门 + 30 秒空等修复（v0.12.3 / v0.12.4 事故）

## 触发

崔总连按两次 `pnpm release patch`（第一次在 retry 阶段 Ctrl+C），得到 v0.12.3 与 v0.12.4
两个版本。实测两个 tarball **只有 `package.json` 的 version 一行不同**：

```diff
diff -r a/package b/package
3c3
<   "version": "0.12.3",
---
>   "version": "0.12.4",
```

事故后的三处状态：v0.12.3 在 npm 上（08:18Z）、本地有 tag `4a60a8d`、**远端无 tag、
无 Release**；v0.12.4 三处齐全，但它的 Release notes 是 `compare/v0.12.2...v0.12.4`——
v0.12.3 的提交（quit-guard 那三条）被吞进去了，正是 AGENTS.md 警告过的漂移形状。

## 根因一：push 之前探测远端 tag（每次发版白等约 30 s）

`publish.mjs` 只推分支、不推 tag（v0.7.3 事故后改的），而 `syncGitHubRelease` 先把
`resolveRemoteTag` 的 5 次退避（2+4+8+16 s）用在**推之前**那一版探测上。那一步的「不存在」
是必然事件，不是 ref 可见性竞态，重试永远不可能命中。日志证据：

```text
local tag v0.12.3 → 4a60a8d
  tag not visible remotely yet — retry 2/5     ← 此处 Ctrl+C
```

```text
local tag v0.12.4 → 6596dcd
  tag not visible remotely yet — retry 2/5 … 5/5
  pushing refs/tags/v0.12.4
remote tag v0.12.4 校验通过 → 6596dcd          ← 推完第一次就绿，重试从未用上
```

修复：推之前的探测固定 `attempts: 1, delayMs: 0`（另一次 run 已经推过 tag 时，这一次探测
照样看得见）；退避只保留在 push 之后的那次校验。

## 根因二：没有任何东西拦「上一版没发完就再按一次」

修复：`publish.mjs` 在脏工作区检查之后、typecheck 之前加硬闸——用新导出的
`releaseTailGap({ cwd, git, tag })`（`scripts/lib/github-release.mjs`，单次探测、无退避，
返回 `ok | missing-local-tag | absent | mismatch`）核对**当前版本**的 tag；不 ok 就中止，
指向 `pnpm release:github v<当前>`（不 bump、不碰 npm，正好是「补完尾部」）。只看 tag 不看
Release：Release 依赖 token，缺 token 的人不该因此发不了版。逃生口 `--skip-tail-check`
（dry-run 会打印它跳过了什么）。

## 附带：手动 `--audit` 不再是每次发版的必做项

`publish.mjs` 末尾自动做**单版本三处自检**（`npm view <pkg>@<ver>` / 远端 tag 同哈希 /
`GET /releases/tags/v<ver>` 且非 draft），逐项 ✅/❌；不全只提示补建命令、不中止（npm 已
发布，中止只会误导）。全量 `pnpm release:github --audit` 降级为「怀疑历史漂移」时的体检。

## 验证

- `releaseTailGap` 四个分支对真实 `spawnSync` 跑通（伪造 git，`match/absent/mismatch/
  no-local` → `ok/absent/mismatch/missing-local-tag`，各 1–7 ms）。
- 端到端复现事故现场：临时 worktree 里把 `package.json` 退回 0.12.3、提交成干净工作区，
  跑新版 `scripts/publish.mjs patch` → 在「上一版 v0.12.3 的发布尾部」处中止（exit 1），
  版本号、工作区、提交历史全部未被改动。worktree 用后删除。
- 真实仓库 `--dry-run`：`0b. 上一版 v0.12.4 的远端 tag 校验（现在：已就位）`。
- 补建 v0.12.3：`git push origin refs/tags/v0.12.3` → `pnpm release:github v0.12.3` 创建
  https://github.com/andares/pi-toolkits/releases/tag/v0.12.3 。

## 顺带发现的历史缺口（未擅自处理）

`pnpm release:github --audit` 报 **v0.12.0** 同样缺远端 tag 与 Release（本地 tag 在
`44462ed`，发布于 2026-11-05T17:27Z，比这次早），是上一轮 quit-guard 发版被打断的残留。
修法与 v0.12.3 相同：`git push origin refs/tags/v0.12.0` + `pnpm release:github v0.12.0`。
待崔总确认后执行。
