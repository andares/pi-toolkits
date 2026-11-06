# 2026-11-06T10:27:05+08:00 — init 工作单彻底去掉语言指令（取代上一条记录的方案）

## 起因

上一条记录（`2026-11-06_init-workorder-language-scope.md`）把 `Prose language for anything you write` 改成
「只管仓内正文」的限定措辞。崔总否了这个方案：**提示词里关于 agent 用什么语言的内容一句都不要有**——
「我们库内用的提示词改用英文」指的是提示词**本身**是英文，不是要在提示词里**指示** agent 用英文
（或任何语言）写东西、回复谁。模型读项目文档自然跟随语言，不需要教。

## 最终形态

| 文件 | 改动 |
| --- | --- |
| `src/features/init/dispatch.ts` | 删掉 `Prose language for files you write into this repository: …`、`Chat replies and the final report are not covered …` 两行，`Plan (machine-readable)` 行尾的 `(its "language" field …)` 备注也删；`const language = …` 映射随之删除 |
| `src/features/init/plan.ts` | `survey` 任务 detail 里的 `Repository prose language: … (chat replies …)` 行删除 |
| `src/features/init/dispatch.test.ts` | 断言改为**完全不出现**：`/prose language/i`、`/\blanguage\b/i`、`/\b(English\|Chinese)\b/`，en/zh 两个项目都验 |

保留不动（它们不是发给模型的指令，是渲染数据）：

- `Plan.language` / plan JSON 的 `"language"` 字段、`state.toml` 的 `lang = "en"` —— 驱动**代码渲染**的
  模板（SEEDS、AGENTS.md 骨架、索引表头、`CONTRACT_LINES`、`HEADINGS`）选中文还是英文，`--lang`
  覆盖与 `detectLanguage()` 检测也在这条链上。模型读 plan JSON 时看到的 `"language": "en"` 是中性
  数据字段，不再有任何指令措辞把它升级成「回复用英语」。

## 验证

- `pnpm typecheck` 绿。
- `pnpm exec vitest run src/features/init`：8 文件 / 81 测试绿；全量 `pnpm test` 在提交前跑
  （上轮全量 32 文件 / 651，本条改 2 处源码 + 1 个测试文件）。

## 关联

- 被取代：`2026-11-06_init-workorder-language-scope.md`（其中的措辞补丁已全部回退，出处追查仍有效）。
- `AGENTS.md` §Feature: init 的「框架自带文本英文」条目已按最终形态改写。
