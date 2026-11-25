# 2026-11-25T01:16+08:00 — keep 会话暂存：/keep-quit、/keep-load、/keep-drop

按 `specs/keep-sessions.md`（v1 批准）实现「入账 / 已载入」两个正交维度的会话待办。

**做了什么**

- `src/features/keep/ledger.ts`：`keep.jsonl` 只追加四类事件（`keep` / `drop` / `load` / `unload`），`deriveKeepState` 纯函数折叠；owner 探活用 `kill(pid, 0)`（`EPERM` 视为存活），同 host 上 pid 不在的 owner 就地补一条 `unload`（幂等）；`currentHost()` 用 `os.hostname()`（`process.env.HOSTNAME` 在本机是空的，实测踩到）。排序：未载入在前、已载入在后，组内按最近 keep 倒序。
- `src/features/keep/store.ts`：当前会话事实（in-memory 会话直接拒绝）、笔记三级回退（显式 → 上次 → 会话名 → 首条用户消息）、`rebuild` 的尾部 16 KB 扫描 + 首行 header 解析。全程不调用 `SessionManager.list`。
- `src/features/keep/format.ts`：行文本（`○`/`●` + 年龄 + 笔记 + 可选项目列/`missing`）、notice、`[keep] Resumed …` 文案，纯字符串。
- `src/features/keep/picker.ts`：专用列表组件（分组、整行置灰、`ctrl+r` 原地移出、滚动窗口）+ 切换前三选对话框（复用 `SelectList`）。
- `src/features/keep/index.ts`：三个命令、启动一行 notice（entry renderer）、`session_shutdown` 解锁、`keep:resume` 消息渲染、切换取消回滚。
- `src/lib/event-ledger.ts`：从 UAT 账本抽出「追加 + 自愈换行 + 容错解析 + 去重」，两边共用；UAT 的公开 API 原样保留。
- 文档：AGENTS.md 新增 `## Feature: keep`、README / README.zh-CN 的简介与功能段、CHANGELOG Unreleased、`package.json` 描述与 `session-backlog` 关键词；spec 的 §10 按批注改成「两项都明确不做，且不进 FUTURE」。

**过程中修掉的两个真问题（都是冒烟抓到的）**

1. `switchSession` 期间旧会话的 `session_shutdown(resume)` 先于 `withSession` 触发：最初在 switch **之前**写 `loadedHere`，结果账本里出现相邻的 `load` + `unload`（新载入的标记被旧会话收尾解掉）。改成在 `withSession` 里认领所有权。
2. `/keep-load` 注册了 `getArgumentCompletions`，pi 在 Enter 时会把高亮补全应用到编辑器，导致 `/keep-load 1` 变成 `/keep-load --all` 且不执行——直接去掉补全，子命令写进 description 与提示。

**证据**

- `pnpm typecheck` 绿；`pnpm test` 54 文件 / 991 测试全绿（keep 41 例）。
- `pnpm check:keybindings ctrl+r`：legacy/kitty 都只有 `app.session.rename`（🔵 会话选择器作用域），插件声明键无冲突；真机 tmux 按 `ctrl+r` 成功移出一行。
- `pnpm check:compat`：0.99.0 → 1.6.0 全部 16 个版本 install/tsc/991 tests/键位全绿，窗口与探针全绿，public floor 仍 **0.99.0**，peer 未变；未触碰任何镜像/patch 目标文件，dist 漂移结论沿用。
- 真实 pi 1.6.0 + tmux 冒烟（`-ne -e ./src/index.ts`，独立 `--session-dir`，账本已清理）：keep-quit → 账本落 `keep` 且进程退出；重开新会话 notice `2 not loaded`；列表 `○`/`●` 两段（`capture-pane -e` 确认置灰色值不同）；enter 载入后注入 `[keep] Resumed …` 且**只有 load 没有 unload**；已载入行可强行重载；`kill -9` 持有进程后下一次读取补一条 `unload`，两个 owner 全灭后回到 `○`；`ctrl+r` 不载入直接移出；`/keep-drop` 移出当前会话；`/keep-load 1` 与裸命令都正常；删账本后 `rebuild` 从面包屑恢复 2 条且保留原时间戳。

## 补记（2026-11-25 11:30，崔总追问「为什么没有做完」后补齐）

上一段写完时漏了本仓「做完」的三件事，均已补齐：

- `specs/keep-sessions.md` 状态行从「待评审」改成「已实现」并指向本记录（其他 spec 的惯例）。
- 记忆层收口：`.agents/memory/ARCHITECTURE.md` 的分层段从「12 个 feature」改为 13 个（补 `keep`，并把
  过期的 `plan` 改成 `spec`）、`src/lib/` 补 `event-ledger.ts`、新增决策记录 D9（两轴 + 不是锁）；
  `.agents/memory/FINISHED.md` 新增里程碑 M6（摘要 + 证据指针）。
- 两条此前只有单测、没在真实终端跑过的 UI 路径补了冒烟：`/keep-load --all` 跨项目列出并带项目列；
  切换前三选对话框渲染正常，选 `Keep it & load` 时账本按预期出现两条 `keep`（当前会话 + 目标）与一条 `load`。

