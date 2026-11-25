# 2026-11-25T16:18+08:00 — /ask-talk 回复批注、评审页标题索引与回到顶部

实现 `specs/ask-talk-and-outline.md` 的三件事（M0–M4）。

**M0 共享层搬家**：`spec/{blocks,render}.ts`、测试与构建产物迁到 `src/features/review-page/`。spec 计划里写的是 `src/features/review/`，但那个目录已被 `/ask-review` 占用，改用 `review-page`（记录在 AGENTS.md 的落位表）。同步更新了全部 import、`ui/vite.config.ts` 的 `outDir`、`package.json` 的 `ui:check` 路径、`spec/server.ts` 的默认 assetsDir、`assets.test.ts`。迁移后 `pnpm test` 与迁移前逐条一致。

**M1 talk 后端**（`src/features/talk/`）：
- `reply.ts` 从 `getBranch()` 末尾取证：只取 `text` 块（thinking/toolCall 排除），撞到 user/custom_message/compaction/branch_summary 即停（回合边界），纯工具调用的 assistant 继续往前找；带 `entryId` 给 compact 判定、带 `fingerprint` 给"同一条回复"判定。
- `sections.ts` 块 → 章节路径（外层在前）。
- `message.ts` 两段式模板；引用裁到 600 字符、按行切、切在围栏里补闭合且省略号放在围栏内；标题块引用时去掉 `##`（`### Alpha` 下面紧跟 `> ## Alpha` 是噪声——真机端到端时发现并修掉）；无 note 只发输入框原文，无输入框只发 notes；compact 后整篇附一次。
- `server.ts` 三个路由（state / notes / continue）；`sent` 之后写路由全 409、1.2s 后关端口；端口 3501 起，与 spec/uat 的 3401 池错开。
- `index.ts` `/ask-talk`（`off` 关闭）：非 idle 拒绝、无回复拒绝、同回复刷新保 notes、新回复清空并提示；`session_start` 换会话时关服务。

**M2/M3 页面**：`ui/src/App.tsx` 按 `mode` 分发到 `SpecView` / `TalkPage`（一份 bundle）；新写 `shared.tsx`（索引条 `Outline`、`BackToTop`、可伸缩 `Composer`、`useFooterHeight`）。索引条贴内容区右缘，横杠 2px/6px 间距、宽度按层级递减、`#D3B3AC`、mask 首尾 14px 淡出，>24 条等距抽样并保留首条与当前节；悬停展开 292px 浮窗（180ms 右→左、复刻底栏面板语言、滚轮只滚列表、离开 200ms 收起）；点击跳转 + 块描边闪 1.2s，spec 模式下目标被"只看改动"隐藏时先展开。回到顶部用 IntersectionObserver 判"右栏整体滚出"（`bottom <= 0`），`bottom: calc(var(--footer-h) + 16px)`，`--footer-h` 由 ResizeObserver 写回；≤1040px 隐藏索引条、回顶改判 0.8 视口高。`buildSpecState` 增加 `mode` + 跟随当前查看版本的 `headings`。

**证据**：
- `pnpm typecheck` 绿；`pnpm test` 59 文件 / 1044 测试全绿（talk 35、headings 6）；`pnpm ui:typecheck` 绿；`pnpm ui:build` 产物在 `src/features/review-page/assets/`（已 `git add`；`ui:check` 的 git-clean 断言要等提交后才成立）。
- `pnpm check:compat`：窗口 1.3.0/1.4.0/1.5.0/1.5.1/1.5.2/1.6.0 全绿（每版 1044 passed），探针 1.2/1.1/1.0/0.99 全绿，floor 0.99.0 与 peer 声明一致。
- 真实 pi 冒烟 `pi -p --no-extensions -e ./src/index.ts --tools ''` 回 `OK`。
- 真实会话端到端（tmux + 独立 agent dir）：`/ask-talk` 在 3501 开页，`/api/state` 报 `items=4 headings=[(2,Alpha),(2,Beta)]`，`POST /api/continue` 后会话里出现逐字节符合模板的两段式消息，模型据此改了标题，端口随即关闭。
- Playwright 目检：1440 / 1200 / 1024 三档；索引条 5 根横杠、悬停展开、点击跳转（`scrollY 970`、active 行正确）、回顶在 `rail.bottom=-405` 出现 / `+165` 不出现、1024 下索引条 `display:none`、输入框 24px ↔ 96px。

**文档**：AGENTS.md 新增 `Feature: talk` 段并同步测试数与 `review-page` 路径；README / README.zh-CN 增加 talk 章节、功能表行、目录与回顶说明；CHANGELOG `## Unreleased` 三条 bullet。
