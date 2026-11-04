# 2026-11-05T02:33:28+08:00 — 运行时可看到文本统一英文（含 third-review 提示词）

## 起因

崔总要求：库里所有**运行时的对外提示**（能看到的部分）改成英文；内置提示词也改英文，
但不丢原意。

## 范围（崔总 2026-11-05 确认）

只翻 **pi 扩展运行时**：`ctx.ui.notify`、选择器标题、发给模型的提示词。不含：

- `src/features/init/` 的 `--lang zh` 模板与索引正文 —— 「框架自带文本英文、写进项目的正文
  跟随项目语言」是既有契约（AGENTS.md §Feature: init），改英文等于废掉 `--lang zh`。
- `scripts/*.mjs` 的控制台输出 —— 维护者工具，不是包运行时。

## 改动

| 文件 | 改动 |
| --- | --- |
| `src/lib/model-picker.ts` | 无可用模型提示、默认选择器标题 → 英文 |
| `src/features/compact/index.ts` | 8 条 `/compact-model` 通知与选择器标题 → 英文 |
| `src/features/review/index.ts` | 9 条 `/third-review` 通知与选择器标题 → 英文 |
| `src/features/review/prompt.ts` | `REVIEW_PROMPT` 整篇 → 英文；注释保留三个焦点原来的中文措辞 |
| 三个对应测试 | 断言子串同步成英文 |

`REVIEW_PROMPT` 语义逐条对应，未删减：

1. 三点检查（需求覆盖 / 是否有遗漏 / 是否有错误，每点给结论）；
2. 硬范围约束（只评审本轮改动；范围外问题只记录不动手）；
3. 交付要求（确认的问题直接 write/edit 修复并说明、不确定的列位置与建议、最后出评审报告
   与剩余风险）；
4. 原始出处 `本轮需求实现 / 是否有遗漏 / 是否有错误` 保留在 `prompt.ts` 文件头注释里。

## 未改动（有意）

- `plans/review.md` 里的旧提示词原文（历史计划，按「记录不改写」保留）。
- `README.zh-CN.md` 对三点检查的中文描述（面向中文读者的文档）。
- 源码注释与 `compact/prompt.ts` 的逐字镜像说明（不是运行时文本）。

## 约定沉淀

`AGENTS.md` 新增 `## 文案语言（不变量）`：运行时可见文本一律英文（notify / 选择器 / footer /
拒绝理由 / 工具声明 / 提示词 / 系统提示横幅），测试断言写英文子串；中文只留注释、
`README.zh-CN.md`、`AGENTS.md`、维护脚本与 init 按 `--lang` 生成的项目正文。

## 验证

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（无输出） |
| `pnpm test` | **30 文件 / 604 测试全绿**（改动前同为 604） |
| `pnpm check:keybindings` | 无上游冲突（本轮不动键位） |
| 复查 | `grep -P '[\x{4e00}-\x{9fff}]' src --include=*.ts` 在非 init 文件里只剩注释、测试夹具里的中文实参（`customInstructions` 透传用例）与 `prompt.ts` 的出处注释 |

`pnpm check:compat` 未跑：本轮只改字符串与测试断言，无宿主接口、类型或 dist 语义变化。
