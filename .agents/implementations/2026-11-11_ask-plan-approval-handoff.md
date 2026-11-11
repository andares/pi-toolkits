# 2026-11-11T10:43:31+08:00 — 批准消息回填 spec 原文 + todos 追踪指令；提示词语言边界

## 需求（崔总 2026-11-11）

1. 批准时，把 **spec 文件与批注** 一起回填给 agent，提示开始实施的同时提示：
   「将任务记录进 todos，并随着工作开展随时更新便于追踪进度」。
2. 复核 plan 前后相关提示词是否使用英文。
3. 补充说明（同轮）：框架性提示词用英文是**我们写提示词的语言**，不等于要求 spec 用英文——
   提示词里不得出现任何关于书写语言的建议，由模型按用户语言习惯自判。

## 改动

- `src/features/plan/feedback.ts`
  - `FeedbackInput` 新增 `planPath` / `planText`；批准时在消息尾部附
    `### Approved plan (<path>)` + 该版本原文。**取的是 `vNNN.md` 快照**，不是当前磁盘内容——
    文件可能在提交后被改过，模型要实施的是它被批准的那一版。
  - 批准指令扩成三句：开始实施 / 批准不代表作废批注 / 把实施任务记进 `todo` 并随进展更新
    （started / finished / blocked），以便追踪。deny 指令不变。
- `src/features/plan/index.ts`：`decisionMessage()` 传入 `planPath`（`source` 优先）与
  `readApprovedText(version)`（读 `vNNN.md`，失败回落为块文本拼接）。
- 提示词复核：`prompt.ts` 两段（PLAN_MODE_BANNER / SPEC_FRAMEWORK_GUIDE）、工具描述、
  反馈模板全部为英文，**没有**任何语言指令；把 `write in statements, not hedges` 改成
  `prefer direct statements over hedges`，避免「write in」被误读成语言要求。
- 新增守卫测试：`buildPlanSystemPrompt()` 不得包含 `in English` / `in Chinese` / `language` /
  `write in`（小写比对），防止以后有人把语言建议写进提示词。
- `ui/src/App.tsx` + `ui/src/i18n.ts`：页脚最后一句硬编码中文挪进词典（`noteCount`），
  UI 文本统一走 i18n。

## 验证

- `pnpm typecheck`、`pnpm ui:typecheck` 绿；`pnpm test` **42 文件 / 776 测试**全绿（plan 109 例）。
  新增用例：批准消息含 spec 原文与 todo 指令、deny 不回填原文、提示词无语言指令。
- `pnpm ui:check` 绿（产物与源码一致）。
- 端到端（既有集成用例）：`plan_submit` → `POST /api/decide approve` → 消息体含
  `### Approved plan (specs/topic.md)`、原文、`Record the implementation work in the todo list`。
- 语言复核：`grep -P '[\p{Han}]' src/features/plan --include='*.ts'`（排除测试）为空；
  中文只出现在 `ui/src/i18n.ts`（界面文案，崔总要求的中英双语）与中文注释里。

## 追加（同日）：批注的两级更明确

崔总问：deny 不回填原文时，模型分得清哪条批注是全局、哪条针对某块吗？

原来的格式靠 `### Global` 与 `### Block: <首行> (状态)` 区分——能分，但定位弱：只有首行，
两个相似的列表项无从分辨，也没有行号。

现在：

- `### Global notes (apply to the whole plan)` / `### Block notes (apply to the quoted block only)`
  —— 标题本身就把作用域说死；
- 块条目 `#### line 9 · 1. blocks, then the server (modified)`，下面是**整块原文引用**
  （多行逐行加 `>`，超过 600 字符截断）；删除块标 `was in the previous revision` 并引用旧文本；
- 批注 key 命中不到当前块时按 `prevId` 反查：旧标签页/被改名的块不再静默丢批注（这条是实测
  示例时发现的真 bug——原先 `byId.get()` 落空就 `continue`）。

验证：`pnpm test` 42 文件 / 777 测试（plan 110 例），新增「按 prevId 反查」用例；`ui:check` 绿。
