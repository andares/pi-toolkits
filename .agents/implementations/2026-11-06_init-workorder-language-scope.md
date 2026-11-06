# 2026-11-06T01:45:52+08:00 — init 工作单的语言指令只约束仓内正文

## 起因

崔总反馈：最近一轮「运行时可看到文本改英文」之后，`/ask-init` 的框架指令里出现了

```text
Prose language for anything you write: English.
```

模型把它读成「回复也要用英语」，于是用英语跟操作者对话。**语言指令不能规定与用户沟通的语言**——
它只该管写进项目里的正文。

## 追查结论（原文出处）

| 引文 | 位置 | 来源 |
| --- | --- | --- |
| `Prose language for anything you write: English.` | `src/features/init/dispatch.ts:68`（`buildWorkOrder()` 头部） | 自 init 立项起就存在（`f52f82c`），不是 2026-11-05 翻译轮引入的；`language = plan.language === "zh" ? "Chinese" : "English"`（第 29 行） |
| `Language for everything you write: en.` | `src/features/init/plan.ts:252`（`survey` 任务的 detail） | 同上，「everything you write」同样歧义 |
| plan JSON 的 `"language": "en"` | `src/features/init/plan.ts:846` / `types.ts:235` | `Facts.language`：`detectLanguage()` 取 AGENTS.md/README.md 前 20k 字符，CJK 占比 ≥ 8% → `zh`，否则 `en`（`fallback = en`），`--lang` 可覆盖（`detect.ts:462` / `:801`） |
| `state.toml` 的 `lang = "en"` | `src/features/init/apply.ts:377`、`plan.ts:219` | 上面那个值的落盘记录，不是指令 |

模型在工作单里被指向 plan JSON（`Plan (machine-readable): …`），因此 `"language": "en"` 也被读成
「回复用英语」的一部分原因。两个值本身没错（它们记的是**项目正文语言**），错的是措辞把作用域写成了
「anything you write」。

与既有契约的偏离：`spec.ts:311` 的注释早就写明「Text *written into a project* follows that
project's language」——工作单的措辞没有把这层边界说出来。

## 改动

| 文件 | 改动 |
| --- | --- |
| `src/features/init/dispatch.ts` | `Prose language for anything you write:` → `Prose language for files you write into this repository:`；新增一行 `Chat replies and the final report are not covered by that setting — keep them in the operator's language.`；plan 路径行追加 `(its "language" field is the same repository-prose setting)` |
| `src/features/init/plan.ts` | `survey` 任务：`Language for everything you write:` → `Repository prose language: … (chat replies keep the operator's language).` |
| `src/features/init/dispatch.test.ts`（新增） | 2 个用例：英文项目的措辞与作用域声明；中文项目下 `zh` 且 survey 任务同样写明边界 |
| `AGENTS.md`（Feature: init） | 记一条：语言指令只约束写进项目的正文，不覆盖对话与最终报告 |

## 验证

- `pnpm typecheck` 绿。
- `pnpm test`：**32 文件 / 651 测试**全绿（原 31 / 649，新增 2 个用例）。
- 未跑 `pnpm check:compat`：本次只改提示词字面量与一处测试，不触宿主 API；矩阵结论沿用
  `.agents/implementations/2026-11-04_pi-1.5.0-compat.md`。

## 未做（有意）

- 没有把 `plan.language` / `state.toml` 的 `lang` 改名或删掉：它们记的是项目正文语言，
  有检测与 `--lang` 用途；只补了一句「同一设置」的说明。
- 没有在工作单里指定「回复用哪种语言」——按崔总要求，模型跟随操作者即可。
