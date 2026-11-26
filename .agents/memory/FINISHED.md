# 已完成

> 只放已收口的工作：摘要、证据指针、历史附录。
> 不在这里重述规格（给指针），也不留未完成项。

## 摘要

### M0 — v0.1.0：ask 咨询模式落地（2026-08-07/08）

- 单包结构（删 `packages/` 与 workspace 多包定义）+ `src/index.ts` 聚合注册 + `src/features/ask/` 模块；
  `/ask` 会话内切换：摘除 write/edit、bash 走只读沙箱、系统提示链式追加横幅、footer 灰色状态。
- 决策点 A/B/C 采纳、D 未采纳（D 的条目在 `FUTURE.md`，脉络在 `.agents/memory/ARCHITECTURE.md` D1–D6）。
- 证据：commit `8c3e7f5`（项目结构）、`0ba02e8`（feat: ask mode）、`8a0e2fb`（PLAN 勾选）；
  规格原文 `git show 0ba02e8:PLAN.md`（原 `PLAN.md`，2026-10-26 整形为 `specs/PLAN.md`）。
- 后续演进（不在本条展开）：2026-10-19 起 ask 允许 `scratchpad` 写会话临时目录，
  现行语义见 `AGENTS.md` §Feature: ask。

### M1 — agent-framework v1 采纳（2026-10-26）

- 确定性的那半边（`/ask-init` 代码）把 `PLAN.md` 原样搬到 `specs/PLAN.md`、建好 `.agents/`（含契约、
  门牌、seeds、state）、快照 18 个文件；模型这半边做完 survey、整形计划、填覆盖表。
- 额外修掉一处 adoption 引入的回归：`.agents/framework/snapshots/` 里的源码副本被 vitest 收集，
  36 个测试文件里 6 个在 import 阶段失败 → 新增 `vitest.config.ts` 排除该目录，复跑回到
  30 文件 / 588 测试全绿。
- 证据：change record `.agents/implementations/2026-10-26_agent-framework-adoption.md`；
  框架 sidecar `.agents/framework/state.toml`（local-only）。
- 未收口的部分（AGENTS.md 预算债、ask 手动验收、根 `plans/` 归位、审计已知误报）留在 `specs/PLAN.md`。

### M2 — pi 1.5.0 宿主兼容迁移（2026-11-04）

- 窗口前移为 1.2 / 1.3 / 1.4 / 1.5（四版全绿，各 602 passed、键位 ✅）；探针 1.1 / 1.0 / 0.99 全绿，
  停在 0.87.x（`defaultActive`、`parentToolCallId`），**public floor 仍为 0.99.0**，peer `>=0.99.0` 未变。
- 镜像同步：`combineUsage` 的 `cost.totalFromProvider` 规则（1.5.0）、模型选择器品名显示（1.5.0）；
  版本事实声明按 diff 全量校正（含 `cycleModel` 1.2→1.5 字节级一致、`ctrl+f` 仍是死键的确认）。
- 顺带止住测量噪声：矩阵并发下 vitest 21 worker 的内存压力让不同测试偶发超时（floor 一度被压到 1.0.2），
  收敛为 `maxWorkers: 4` + 30s 超时 + 静态 import，断言未动。
- 证据：change record `.agents/implementations/2026-11-04_pi-1.5.0-compat.md`。

### M3 — pi 1.5.1 宿主兼容（同一条 1.5 线内，2026-11-10）

- 窗口定义按中版本线，所以 1.5.1 落进既有窗口而窗口不新增线：1.2.0–1.5.0 + 1.5.1 全绿
  （各 660 passed，键位 ✅）；探针与停留点不变，**public floor 0.99.0**，peer 未动。
- 唯一代码改动：`favorites` 的 `filterModels` patch 原样转发 1.5.1 新增的 `preferredModel`
  （后台刷新保持高亮行，#9109），覆写核心抽成可测的 `runFilterModels` + 1 个宿主无关单测；
  测试 32 文件 / 660。
- dist 判读：`compaction.js`/`usage-totals.js`/`updateList` 未动；`agent-session.js` 五处变化都不碰
  `cycleModel`（仍 1.2.0→1.5.1 字节级一致）或 autostart 的扩展命令早退；`types.d.ts` 全增量；
  quit-guard 面对的收尾链又多了两个 await，结论不变。
- 证据：change record `.agents/implementations/2026-11-10_pi-1.5.1-compat.md`。

### M5 — pi 1.6.0 宿主兼容迁移（2026-11-24）

- 窗口前移为 1.3 / 1.4 / 1.5 / 1.6（六个已发布版本全绿，各 950 passed、键位 ✅）；探针
  1.2 / 1.1 / 1.0 / 0.99 四条线全绿（0.87.x 上一轮已按规则停探、本轮未重探），
  **public floor 仍为 0.99.0**，peer `>=0.99.0` 未变，实测覆盖 0.99.0 → 1.6.0。
- 唯一代码改动：宿主把 `Component.render` 放宽为 `readonly string[]`，`permission/panel.ts`
  直接返回 `SettingsList.render()` 在 1.6.0 报 TS4104 → 改为返回副本（两侧类型都成立，
  不做版本分支）；其余功能不受影响。
- dist 判读：`compaction.js` / `compaction/utils.js` / `usage-totals.js` / `keybindings.js`
  字节级未动；`agent-session.js` 三处（tool-loadout 恢复的 `_restoredToolNames`、
  `_extensionsBound`、`getLastAssistantText` 语义）均不碰 `cycleModel`（1.2.0→1.6.0 仍字节级
  一致）与扩展命令早退（`sendUserMessage`/`_preparePrompt` 同上）；`model-selector.js` 与 pi-tui
  `settings-list.js` 只改了「光标键不重新过滤」的调用点，我们的 `filterModels` patch 语义不变；
  `types.d.ts` 全增量（`reportError`、render 放宽）；quit-guard 面对的收尾链多了
  `await flushStdout()`，结论不变。
- 对外口径：README 只公示实测结论（`pi >= 0.99.0`、已验证 0.99.0–1.6.0、无上界）；
  4 版窗口 / 4 版探针这套内部规则从 README 移回 AGENTS.md，并写进迁移流程的收尾判据。
- 证据：change record `.agents/implementations/2026-11-24_0037_pi-1-6-0-compat.md`。

### M4 — `/ask-uat` 验收台账（2026-11-12）

- 验收单位从「提交」换成「用户可见行为」：`record_change` 写规范实施记录 + 一条行为句，
  `/ask-uat` 把待验收记录聚成少数验收项，页面里展开测试方案、勾选即落盘（无提交）。
- 状态是 `.agents/uat/ledger.jsonl` 的只追加事件流（进 git、只住主仓、按 id 去重）；
  新证据自动重开已勾项，`merge`/`drop` 让验收债可收敛。
- 同轮补齐：plan/uat 共用 HTTP 壳（`src/lib/web-review.ts`）、计划期 bash 写入窄闸门与访谈协议、
  `/ask-init refresh`（受管文件按模板哈希锚刷新，`AGENTS.md` 只动 workflow 标记块）。
- 证据：change record `.agents/implementations/2026-11-12_0313_ask-uat.md`；规格 `specs/ask-uat.md`；
  `pnpm test` 48 文件 / 841 测试全绿（含第三方评审回归修复）。

### M6 — keep 会话暂存（2026-11-25）

- 三个命令成形：`/keep-quit [note]`（入账并退出）、`/keep-load`（列表；未载入在上、已载入置灰在下，都可选中）、
  `/keep-drop`（出列，另有列表内 `ctrl+r`）。载入**不**出列——入账与已载入是两个正交维度。
- 状态是 `<agent-dir>/pi-toolkits-keep/keep.jsonl` 的只追加事件流（`keep`/`drop`/`load`/`unload`），
  纯函数折叠；同 host 上 owner pid 不在时读列表就地补 `unload`（硬杀可自愈），跨 host 不探活。
  列表不调用宿主 `SessionManager.list`（实测本项目 576 ms、全量 9.8 s）。
- 载入后会向目标会话注入一条 `keep:resume` 消息（进模型上下文、不触发回合），把上次留下的备注交给模型；
  新会话启动只显示一行 `N not loaded · /keep-load`。
- 同轮把 UAT 账本的追加/自愈换行/容错解析/去重抽成 `src/lib/event-ledger.ts`，两处共用。
- 证据：change record `.agents/implementations/2026-11-25_0116_keep-session-backlog.md`；规格
  `specs/keep-sessions.md`；决策 `.agents/memory/ARCHITECTURE.md` D9；
  `pnpm test` 54 文件 / 991 测试全绿，`pnpm check:compat` 0.99.0 → 1.6.0 全绿（floor 仍 0.99.0）。

### M7 — quit-guard 移除（2026-11-26）

- **决定（崔总 2026-11-26）**：把「退出卡住超时后强制退出」的看门狗整个移除，`/quit-guard`
  命令与 `pi-toolkits-quit-guard.json` 配置一并退场。理由是实测下来卡住并不总是我们自己的
  问题（与外部系统有关），强制退出既没解决卡住、又把真正的现场抹掉了——「该卡就卡」比
  「假装解决」更诚实。
- 删掉的东西：`src/features/quit-guard/`（状态机、配置存储、诊断报告、线程杀手、命令，
  含 55 个测试）、`src/index.ts` 的注册、`package.json` 的关键词与描述、README 中英双语
  章节与命令表、`AGENTS.md` 的 feature 章节。
- 保留的东西：`redactText` 仍在 `src/lib/approval-log.ts`（审批日志自己用），只是不再为
  看门狗导出；历史上写下的 `~/.pi/agent/quit-guard/` 报告与配置文件不删（属于操作者磁盘）。
- 已知后果：宿主 `runtimeHost.dispose()` 仍是无超时串行 await，某个扩展的 `session_shutdown`
  永不 settle 时进程会一直挂着（`/quit` 后终端已还原、画面停在最后一帧）。这是**有意的**：
  没有兜底，卡住时只能看到现场，而不是被一个 8 秒后的 SIGKILL 抹掉。
- 证据：change record `.agents/implementations/2026-11-26_1506_quit-guard-removal.md`；
  `pnpm test` 全绿（文件数与用例数见该记录）。
