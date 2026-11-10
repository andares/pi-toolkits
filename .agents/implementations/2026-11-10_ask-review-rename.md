# 2026-11-10T21:06:00+08:00 — `/third-review` → `/ask-review`（旧名保留为兼容别名）

## 范围

纯改名，不改行为：命令名、提示文案前缀、文档。作为 `/ask-*` 家族（ask / ask-perm /
ask-init / ask-review）的第一步，先把这个已经成熟的功能搬进统一前缀。

## 决策

- **canonical = `ask-review`**：所有用户可见文案（notify）、命令描述、README 都以新名为准。
- **旧名继续注册为别名**，同一个 handler、同一个 runner、同一份配置——不是第二套实现，
  也不单独维护状态。留它的理由是兼容性：旧笔记、肌肉记忆，以及 `.pi/autostart.toml` 里
  写着 `/third-review` 的配置。**autostart 的预校验只看命令名是否在注册表里**，名字一旦
  消失，那行配置就会被当成普通消息发给模型（正是 autostart 当初要防的跑偏）。
- 通知文本一律用 `ask-review` 前缀（即使这次是用旧名触发的），让别名顺手也起到「教新名」
  的作用；改名只需改 `REVIEW_COMMAND` 一处。
- 别名没有独立的删除计划，注释里写明「旧拼写连续一两个版本无人使用后再删」。

## 落位

| 文件 | 改动 |
| --- | --- |
| `src/features/review/index.ts` | 新增导出常量 `REVIEW_COMMAND` / `REVIEW_COMMAND_ALIAS`；注册两个命令（同一 handler）；9 处 notify 前缀改走常量；头部注释与 `/review-model` 描述改名 |
| `src/features/review/review.test.ts` | 新增 `registerReview` 用例：断言两个名字都注册、`/review-model` 也在，且两个入口都能走完一次评审（`sendUserMessage` 各一次） |
| `src/index.ts` | 特性清单注释 |
| `src/lib/startup.test.ts` | 「非 startup 命令返回 false」用的样例字符串改为 `ask-review` |
| `README.md` / `README.zh-CN.md` | 概述、命令清单表、review 章节全部改成 `/ask-review`，并加一段「由 `/third-review` 改名、旧名仍是兼容别名」的说明 |
| `plans/review.md` | 标题改名 + 顶部加一条改名横幅；**正文保留原始命名**（那是当时的决策与实现记录，不该被改写） |

未改动：`.agents/implementations/*`（历史记录，一次一记不改写）、
`.agents/framework/snapshots/*`（sha256 背书的不可变快照）。

## 验证

- `pnpm typecheck` 绿；`pnpm test` **32 文件 / 667 测试**全绿（新增 1 例注册用例，其余 666
  例不受影响——说明改名没有动到任何行为断言）。
- 真实 pi 宿主探针（`pi -p --no-extensions -e ./src/index.ts -e /tmp/review-cmd-probe.ts`
  打印 `pi.getCommands()` 里含 review 的项）：

```text
REVIEW-COMMANDS: ask-review[extension], third-review[extension], review-model[extension], ...
OK
```

  即：两个名字都是活的 extension 命令，加载无警告，回包正常。

## 备注

- `/review-model` 没改名（它是配置入口，不属于 `/ask-*` 的动作族）；若要一并挪到
  `ask-review-model` 之类，下一轮再定。
- 下一步：`/ask-plan`（另行讨论）。
