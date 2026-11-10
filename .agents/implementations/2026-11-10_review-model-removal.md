# 2026-11-10T21:14:00+08:00 — 移除 `/review-model`；文档不再提任何已删/待废弃指令

## 范围

接上一轮改名（`third-review` → `ask-review`）之后的两处清理：

1. **`/review-model` 彻底移除**（不是别名、不是隐藏）。
2. **对外文档只写现行指令**：已删除的（`/review-model`）与准备废弃的（`/third-review`）
   在 README / README.zh-CN 里一句话都不出现。

## 为什么删 `/review-model`

每次 `/ask-review` 本来就要弹模型选择器（当前配置预选、回车即用），配置命令只是「同一件事的
第二个入口」：看配置要它、改配置要它，而真正用配置的地方又不经过它。删掉之后 `/ask-review`
就是唯一入口——选完即写回，取消即不变，"看"和"改"都发生在用它的那一刻。

## 落位

| 文件 | 改动 |
| --- | --- |
| `src/features/review/index.ts` | 删除 `pi.registerCommand("review-model", …)` 与它的注释，换成一条「配置没有独立命令」的说明；`pickReviewModel` 的 doc 去掉 `/review-model` 的引用；`REVIEW_COMMAND_ALIAS` 注释标注 **slated for removal**（对外文档不提、待无人使用后删除） |
| `src/features/review/review.test.ts` | 注册用例改为「只有 `ask-review` 与 `third-review` 两个」，并新增 `expect(commands.has("review-model")).toBe(false)` 作为删除守卫（防止以后又加回来） |
| `README.md` / `README.zh-CN.md` | 删除 `/review-model` 条目与「由 `/third-review` 改名、旧名仍是别名」的说明；目录树里 `review-model config store` 改为 `review model config store`（那里指的是配置文件，不是命令） |
| `.agents/memory/FUTURE.md` | 新增 **F5**：`/third-review` 别名待删除（触发条件 + 落点），并注明 `/review-model` 已于同日彻底移除 |

未动：`.agents/implementations/*`（历史）、`plans/review.md`（正文是当时的决策记录，顶部横幅已说明改名）。

## 验证

- `pnpm typecheck` 绿；`pnpm test` **32 文件 / 667 测试**全绿（注册用例的期望值从 3 个命令改成 2 个，
  其余断言不变——删除没有碰到任何行为逻辑）。
- 真实 pi 宿主探针（`pi.getCommands()` 过滤 review）：

```text
REVIEW-COMMANDS: ask-review[extension], third-review[extension], parallel-review[prompt], review-loop[prompt]
OK
```

  `review-model` 已不在命令表里；`ask-review` 与别名都还在，加载无警告。
- `grep -c` 复核：README.md / README.zh-CN.md 里 `third-review` 与 `review-model` **各 0 次**。

## 备注

- `third-review` 仍是可用命令（只是不出现在任何对外文档里），删除节奏见 `.agents/memory/FUTURE.md` F5。
- 下一步：`/ask-plan`（含 web 批注界面）另行调研，见 plannotator 分析。
