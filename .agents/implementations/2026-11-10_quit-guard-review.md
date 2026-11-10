# 2026-11-10T15:53:00+08:00 — quit-guard 第三方评审修正（非 TUI 模式过滤）

## 范围

只评审 `cd2a6d8`：quit-guard 的 `session_shutdown(reason="quit")` 第二触发源与强制退出前的
终端恢复。此前的 pi 1.5.1 兼容迁移和默认 8 s 不在本轮范围。

## 已确认并修复

**非 TUI 的退出事件会把终端转义序列写进 RPC/JSON/print 的 stdout。**
`session_shutdown(reason="quit")` 并非 TUI 独有；`rpc-mode.js` 的 stdin EOF / SIGTERM 同样调用
`runtimeHost.dispose()`。原实现没有检查 `ctx.mode`，因此看守在 RPC 中武装，到期后把
`TERMINAL_RESTORE` 写到 stdout，违反 RPC「stdout 只放 JSON 协议」的约定。

真实复现（pi 1.5.1，RPC，`src/index.ts` 先于永不 settle 的探针加载，关闭 stdin）：

- 修复前：`register` → `arm session_shutdown` → 8.01 s 后 `fire`；stdout 尾部含原始
  `\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m`。
- 修复：`src/features/quit-guard/index.ts` 的事件处理器要求 `ctx.mode === "tui"`；
  RPC/JSON/print 不再武装，也不会做终端恢复。
- 修复后同一夹具：无 `arm`，进程 **0.01 s** 自然退出（没有其他 ref'ed handle），stdout 不含
  任何转义序列。

测试夹具 `emit()` 现在传入带 `mode` 的事件上下文；原有接线用例扩展为同时验证
`rpc/json/print` 的 quit 事件全部不武装。测试总数不变（仍 51 个 quit-guard 用例），是增强
原断言而不是新增用例数。

## 同轮文档纠偏

- AGENTS.md 的 quit-guard 用例数 45 → 51、套件计数 660 → 666，进程接线补上事件触发；
  「非 TUI 不发 quit 事件」的错误说法改为「会发，但显式过滤」。
- 中英 README 的功能总览与目录说明不再把触发条件写成只有「TUI 已停」；正文明确事件触发
  只限 TUI，机器可读 stdout 不写终端序列。

## 复核

- `pnpm typecheck` 绿；`pnpm test` **32 文件 / 666 测试**全绿。
- `pnpm check:compat --versions 0.99.0,1.2.0,1.5.1` 三版 install / typecheck /
  666 tests / keys 全绿，public floor 与 peer 校验通过。
- 真实 pty + SIGTERM + 卡死探针（本包先加载）：仍按时强制退出，`TERMINAL_RESTORE` 存在；
  退出后 pty 的 `ICANON` / `ECHO` / `ISIG` 均恢复。
- pi-lens 对本轮两个源码文件无错误；仅报告 `index.ts` 既有的 nested-ternary / sort / 索引风格
  提示，均在本轮改动之外，未处理。

## 不属本轮已修范围 / 剩余风险

- 扩展 `session_shutdown` 按加载顺序串行，挂在 pi-toolkits 之前的处理器仍会使本包的事件
  处理器不运行；已有文档明确，本轮不改宿主顺序。
- 崔总原始的交互式 `/quit` 卡住现象仍未在本机复现；信号路径是已证实并修好的另一条路径，
  不能把它当作原始问题的已证实根因。仍需原现象发生时的进程状态与 `PI_QUIT_GUARD_DEBUG`
  日志来收口。
