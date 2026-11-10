# 2026-11-10T14:56:00+08:00 — quit-guard 补第二触发源（signal 路径）+ 强制退出前恢复终端

## 起因

崔总报告：`/quit` 之后回不到 shell 提示符，`/quit-guard` 显示 `on`，所以「开了也没效果」。
排查先确认了三件事：

1. **看守确实默认为开**（`DEFAULT_CONFIG.enabled = true`；本机没有配置文件）。
2. **本机 `~/.pi/agent/quit-guard/` 在排查前不存在** —— 看守从未触发过（从未写出报告）。
3. **交互式 `/quit` 的触发链在真实 pty + 本机全套扩展下是通的**：注入「`session_shutdown`
   永不 settle」的探针后，收尾序列武装看守，**10.12 s** 后强制退出并写报告。

所以崔总遇到的那次，看守**没有武装**。继续在 pty 里做对照实验（不用 tmux，`TERM=xterm-256color`，
本机 20 个扩展全开），找到一个确定成立、且必然「开了也没效果」的洞：

**信号触发的退出（`SIGTERM` / 关窗 `SIGHUP`）走的是另一条顺序。**
pi 1.5.1 `interactive-mode.js`：

```text
shutdown({ fromSignal: true })  →  await runtimeHost.dispose()   // 所有扩展 session_shutdown
                                →  ui.stop()                     // 才写 ?2004l / ?1049l
```

即**先 dispose、后停 TUI**。只要有一个 `session_shutdown` 处理器永不 settle，收尾序列就永远
不会写出 → 只盯终端的看守永远不武装 → 进程带着 raw mode 与冻结画面活到被 SIGKILL。
实测：`SIGTERM` + 卡死探针 → 进程存活、看守日志只有 `register`（无 `arm`）。

（对照：交互式 `/quit` 是 `ui.stop()` 在 `dispose()` **之前**，所以序列一定先写出，那条路没问题。）

## 改动

1. **第二触发源**：`pi.on("session_shutdown")` 且 `reason === "quit"` 时武装看守
   （`QuitGuard.armFromShutdown()`，伪标记 `session_shutdown`）。
   - 只认 `"quit"`——`"reload"`/`"new"`/`"resume"`/`"fork"` 都是会话替换或重载，绝不能武装。
   - 已经被收尾序列武装时是空操作（保留最早的截止时间，不重置计时）。
   - 事件武装**跳过 `process.stdin.isRaw` 探针**：信号路径卡死时 TUI 正活着、raw mode 正开着，
     探针会把唯一要抓的场景解掉。
2. **强制退出前恢复终端**：事件武装的到期路径先 `writeSync(1, TERMINAL_RESTORE)`——
   `?2004l`（关括号粘贴）+ `?1049l`（退备用屏）+ `?25h`（显示光标）+ `SGR reset` + 换行，
   再写报告并退出。否则提示符会落在备用屏上，看起来还是「没回到 shell」。
   `writeSync(1, …)` 绕过我们自己的 stdout 包装，不会自我加压。

## 验证（真实 pty，本机全套扩展，`timeoutMs=8000`）

| 场景 | 结果 |
| --- | --- |
| 本包先加载 + `SIGTERM` + 卡死探针 | 事件武装 → **8.03 s** 退出，输出含 `TERMINAL_RESTORE` |
| 探针先加载 + `SIGTERM` + 卡死探针 | **不武装、进程存活**（处理器串行，本包处理器不运行）——如实保留为已知边界 |
| 交互式 `/quit`（两种加载顺序） | 收尾序列武装 → 约 8.0 s 触发（顺序无关） |
| 无卡死探针 + `/quit` | 0.12 s 退出（看守不拖慢正常退出） |

`pnpm typecheck` 绿；`pnpm test` **32 文件 / 666 测试**（quit-guard 45 → 51：新增
`armFromShutdown` 的武装/幂等/禁用/跳过探针四条、事件只认 `quit` 的接线用例、以及
`TERMINAL_RESTORE` 常量断言）。

## 已知边界（写进 AGENTS.md）

- 处理器按**加载顺序串行**：挂在**本包之前**的处理器仍能让我们的 `session_shutdown` 不运行，
  那条信号路径仍然无解（实测成立）。
- TUI 停下之前就卡住、且不来自 `session_shutdown` 的情况（例如 `/quit` 被延后到 idle）没有
  可观测信号，看守不会武装。

## 仍待崔总提供的一条证据

本机复现不出崔总的原始现象。下次发生时（`pi` 仍在另一个窗口里看得到即可）：

```fish
pgrep -a pi                                   # 进程还在不在
ls -la ~/.pi/agent/quit-guard/                 # 有没有新报告
```

- 进程**还在** + 没有新报告 → 看守没武装或已解除；用
  `env PI_QUIT_GUARD_DEBUG=$HOME/qg.jsonl pi` 复跑一次，日志的最后一行就能区分
  「没 arm」/「arm 后 disarm（tui-still-active）」/「arm 后什么都没发生（事件循环被同步阻塞）」。
- 进程**不在** → 不是看守的问题，是终端状态（备用屏/光标/raw mode）没恢复，属于另一条修复线。
