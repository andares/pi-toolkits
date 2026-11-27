# 2026-11-27T10:31+08:00 — Drop the /third-review and /ask-plan compatibility aliases

崔总 2026-11-27 定：`/third-review` 与 `/ask-plan` 这两个**兼容性指令**去掉——改名后的别名只教会人旧拼写，留着没有价值。

## 改了什么

- `src/features/review/index.ts`：删掉 `REVIEW_COMMAND_ALIAS` 常量与其 `registerCommand` 块，`/ask-review` 成为唯一入口。
- `src/features/spec/index.ts`：删掉 `SPEC_COMMAND_ALIAS`，注册从「循环两个名字」改回一次 `registerCommand`。
- `src/index.ts` 头部注释、`README.md` / `README.zh-CN.md`（ask-spec 段）、`AGENTS.md` 的 spec 一节同步为「别名已移除」。
- 测试改为反向断言：`[...commands.keys()]` 只含规范名，且 `commands.has("third-review")` / `has("ask-plan")` 为 false。

**有意保留的两处兼容**（它们不是命令别名，而是数据/会话兼容）：

- `<agent-dir>/ask-plan/` 历史目录仍会在首次使用时迁移到 `ask-spec/`——那是磁盘上的旧评审记录，删掉就是丢数据。
- 相位判定仍识别旧工具名 `plan_submit`——升级前就已打开的会话里可能还有它。

**旧配置不会跑偏**：autostart 派发前用 `pi.getCommands()` 预校验，未注册的命令名跳过并告警，不会变成普通消息发给模型。

## 顺带修的红

`src/features/init/audit-uat.test.ts` 的「recent non-canonical record」用例把日期写死成 `2026-11-13`，而 `W-REC-01` 只查 14 天内——今天（2026-11-27）窗口正好越过它，代码没动却变红。改成用 `isoMinute(new Date()).slice(0, 10)` 现算。

## 证据

- `pnpm typecheck` 绿；`pnpm ui:typecheck` 绿；`pnpm test` **61 文件 / 1035 测试**全绿（去掉 2 个别名用例、新增 1 个「只注册 /ask-spec」用例）。
- 全仓 grep：`REVIEW_COMMAND_ALIAS` / `SPEC_COMMAND_ALIAS` 已无引用。
