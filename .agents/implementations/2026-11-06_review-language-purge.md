# 2026-11-06T11:02:59+08:00 — 第三方评审：语言指令清除这一轮的修正

评审范围：本轮「提示词与落盘字段中的语言指令全部清除 + `/ask-init scrub`」的改动，
不含仓库既有问题。结论 **needs changes → 已修**。

## 修掉的问题（本轮代码内）

| # | 位置 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | `apply.ts` `scrubPlanArtifacts` | 缩进被编辑打乱（`record.detail` 分支多两级、`catch` 多一级），读起来像嵌套错了 | 重排为正常缩进 |
| 2 | `apply.ts` `scrubRetiredFields` | 顶层过滤用裸正则，若 state 的 `[[roots]]` 表里也有 `lang` 键会被一起删掉（改数据而非删退役字段） | 只过滤第一个 table header 之前；正则接受单引号与行尾注释 |
| 3 | `index.ts` `/ask-init scrub` | 忽略 `--dry-run`：该 flag 承诺「什么都不写」，实际照写 | `scrubRetiredFields(root, { dryRun })` 支持只报告；`--dry-run` 时输出 `would clean … — nothing was written.` |
| 4 | `index.ts` scrub 提示语 | `stateScrubbed=false` 却打印「cleaned state.toml (already clean)」 | 改为按实际变更拼 `parts`，无变更走 nothing-to-scrub |
| 5 | `apply.ts` `applyPlan` 摘要 | `scrubbed retired fields from N` 是内部行话，且对操作者像事故叙述 | 改为 `removed obsolete fields from N plan artifact(s)` |
| 6 | 测试 | `applyPlan` 自动清 plans 的行为**零覆盖**（AGENTS.md 已宣称该行为） | 新增 `retired-field cleanup` 用例 |
| 7 | 测试 | `scrub` 的 dry-run、表内同名键保护、命令层接线均无覆盖 | 新增 3 个用例（apply.test.ts）+ 1 个命令层用例（index.test.ts） |
| 8 | 文档 | README `--lang` 未说明「单次生效」（语言不再落盘后行为变了） | 表格补 `(per run; …)` |

## 未修（记录，不在本轮代码范围内或不应改）

1. `snapshots/` 里的历史快照仍含旧指令字节（本仓 `snapshots/2026-10-26T11-08-56-08-00/files/src/features/init/{dispatch,plan}.ts`）。
   快照是 sha256 manifest 背书的不可变备份，改写即伪造证据。**给的处置**：整体删
   `.agents/framework/snapshots/`（对应源文件都在 git 历史里），已写进 AGENTS.md。
2. `plans/` 每次 run 写一个 JSON 且从不清理；本轮新增的每次 run 扫描解析全部工件，
   随工件数线性增长。体量很小（每份几 KB），不处理；要根治是另开「工件保留策略」。
3. `scrub` 不写快照（删除项可从 git 历史复原），与「先快照后写」的迁移不变量不同；
   已写进 AGENTS.md 作为该命令的明确例外。
4. `scrub` 不在 USAGE / 参数补全里（有意隐藏，见 AGENTS.md）；操作者需要在 AGENTS.md
   或本条记录里查。若将来要公开，只在 USAGE 加一条中性描述即可。

## 验证

- `pnpm typecheck` 绿。
- `pnpm test`：**32 文件 / 659 测试**全绿（本轮起点 655，评审新增 4）。
- 本仓 `state.toml` 用 smol-toml 解析通过、无 `lang` 键；`plans/*.json` JSON 有效、
  无 `language` 键、无内嵌旧指令行。
