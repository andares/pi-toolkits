# 2026-11-26T20:18+08:00 — release: check every release material before running any gate

崔总 2026-11-26 反馈：发版是在**没有 agent 的终端**里按的，而 `pnpm release` 把可预知的物料缺口留到 `typecheck + test + UI` 跑完之后才抛（v1.2.3 那次 `## Unreleased` 空段就是如此），补救提示又只有一句「去改文件」。结论定稿：**物料是阻塞环节，设计了的必须 work —— 脚本执行前就要把物料摸透**。

## 改了什么

**`scripts/lib/release-materials.mjs`（新）** —— 纯函数 `assessReleaseMaterials`，一次判定五项物料，返回 `items`（每项 `ok` / `warn` / `block`）、`blocked`、`blocking`、`promoteNotes`：

| 物料 | 判定 |
| --- | --- |
| 工作区干净 | 脏 → ❌（未提交内容会进 npm 包却不进 tag，v0.4.0 事故） |
| `## Unreleased` 有顶格 `- ` | 缺段 / 空段 → ❌ |
| `package.json.files` 含 `CHANGELOG.md` | 缺 → ❌ |
| 本地没有 `v<next>` tag | 有 → ❌（`tag-current` 会跳过，自检要等提交后才炸） |
| 上一版远端 tag 已完成 | 非 ok → ❌（文案沿用原尾部校验的四种状态） |

`--skip-changelog` / `--skip-tail-check` 是仅有的两个显式旁路，降为 ⚠ 且不改变其它项的判定。

**`scripts/publish.mjs`** —— 预检移到 `typecheck` 之前；先打印清单再决定是否继续，❌ 时 `process.exit(1)` 且什么都没跑（不跑门禁、不写盘、不提交、不推 tag）。原「第 0 步脏树检查」「0b 尾部校验」「2a 备注闸门」的重复逻辑收进预检；2a 只负责提升，并在写盘前重新读文件（预检后被外部改动则中止，不把未校对的文本当成已发布内容）。`--dry-run` 打同一份清单。

**`scripts/lib/changelog.mjs`** —— 新增 `releaseNotesStatus(markdown)` → `{state: "ready"|"empty"|"missing", count}`；`promoteUnreleased` 提升时剥掉 `UNRELEASED_PLACEHOLDER`，已发布段不再残留「notes for the next release go here」（历史 8 处一并清掉）。

**`AGENTS.md`** —— Release 一节新增「发版物料预检 = 硬闸，且在门禁之前」与「『提交』= 变更写完、写对、写清 + 物料齐备」（崔总 2026-11-26 定）；whats-new 一节同步为「备注缺失属于物料不全，预检在跑门禁前就中止」。

## 证据

- `pnpm typecheck` 绿；`pnpm test` **61 文件 / 1036 测试**全绿（新增 `release-materials.test.mjs` 20 例：五项各自的 ❌、一次收齐多个缺口、每个 ❌ 必带 `⇒`、旁路只降级自己、`promoteNotes` 与其它物料解耦；`changelog.test.mjs` 新增 `releaseNotesStatus` 三态与占位注释剥离）。
- 实机：脏树 + 空备注时 `pnpm release patch` **4.5 秒中止**（此前要跑完整个门禁），清单同时列出两项 ❌ 与各自 `⇒`；补齐备注后 `--dry-run` 显示 `CHANGELOG.md ## Unreleased：2 条待发布 → ## 1.2.4`、只剩脏树一项 ❌。
- `node --check scripts/publish.mjs` 通过；`--dry-run` 输出已人工核对（含旁路文案分支）。
