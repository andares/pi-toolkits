# 2026-11-06T10:46:43+08:00 — 语言字段全部去落盘 + `/ask-init scrub` 清理已 init 项目

## 定稿不变量（崔总 2026-11-06）

**全仓禁止以任何形式要求模型用什么语言——每一字节都不行**。语言由模型自判；
库内文案用英语是我们自己的输出选择（国际传播友好），不是对模型的要求。
做事与对外表达分开：这是内部事故处置，README 不叙述来由，只做中性「行为同步」。

## 改动

| 文件 | 改动 |
| --- | --- |
| `types.ts` | `FrameworkState` 删 `lang` 字段 |
| `detect.ts` | `parseState` 不再读 `lang`（旧文件含它也能解析）；渲染语言改为 `--lang ?? detectLanguage(root)` 每次现算 |
| `plan.ts` | `buildState` 不再写 `lang` |
| `apply.ts` | `stateToToml` 不再输出 `lang`；新增 `scrubPlanArtifacts`（清 plans 目录旧 JSON 的 `language` 键 + `tasks[].detail` 里内嵌的 `Language for everything you write: <lang>.` 行）与 `scrubRetiredFields`（state.toml 的 `lang` 行 + plans 目录，幂等）；mutating run 写完新 plan 后自动顺带擦旧工件 |
| `dispatch.ts` | `serializeWorkOrder` 不再落盘 `language`（内存值仍驱动模板渲染） |
| `index.ts` | 新子命令 `/ask-init scrub`（**隐藏**：不进 USAGE、不进参数补全、不进 README）；`--lang` 帮助文案改为 `rendering language for framework-generated files`，补全描述同步 |
| `spec.ts` / `render.ts` | 注释改为「渲染语言、绝不构成对模型的指令」的表述 |
| `AGENTS.md` | 「文案语言」节新增全仓禁令；Feature: init 的语言段收敛为最终形态 |

## scrub 覆盖的残留（已 init 项目跑 `/ask-init scrub` 一次清完）

1. `state.toml` 顶层 `lang = "zh"|"en"` 行（其余字节不动）
2. `plans/*.json` 顶层 `"language"` 键
3. `plans/*.json` 里 `tasks[].detail` 内嵌的 `Language for everything you write: en|zh.` 行
   （旧版 survey 任务被序列化进了历史工件——本仓库自己就中了一处）

幂等；坏 JSON 跳过不改；`snapshots/` 不动（带 sha256 manifest 的不可变备份，
同 git 历史性质，不属于活文件）。

## 本仓库自清（已执行）

- `state.toml` 删 `lang = "zh"` 行
- `plans/plan-2026-10-26T11-08-56-08-00.json` 删 `"language"` 键与内嵌指令行，JSON 有效性校验通过，`grep -ri language` 归零

## 测试

- `dispatch.test.ts`：`serializeWorkOrder` 无 `language` 键；工作单无任何 `language` 字样（en/zh 双验）
- `apply.test.ts`：state.toml 落盘无 `lang` 行；`scrubRetiredFields` 三用例（清 + 幂等 / 干净与缺失项目 no-op / 坏 JSON 不动）
- `detect.test.ts`：partial state 断言改为 `Object.keys(state)` 不含 `lang`；budgets 往返 fixture 去 `lang`
- `index.test.ts`：`parseInitArgs("scrub").sub === "scrub"`
- 保留 audit fixture 里的 `lang = "en"`：证明旧 state 文件在新代码下仍可解析

## 验证

- `pnpm typecheck` 绿；`pnpm exec vitest run src/features/init` 8 文件 / 85 测试绿
- 全量 `pnpm test` 与提交前基线一致后收口（见提交）

## 对外表达边界

README 仅两处中性行为同步（`--lang` 描述、渲染语言句），无事故叙述、无 scrub 条目；
`/ask-init scrub` 只记录在 AGENTS.md 与本记录中。
