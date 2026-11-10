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
