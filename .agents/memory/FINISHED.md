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
