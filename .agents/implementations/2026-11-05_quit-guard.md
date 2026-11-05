# 2026-11-05T15:45:54+08:00 — quit-guard：退出卡死时强制收尾

## 起因

崔总反馈：pi 1.0 之后 `/quit` 经常回不到 shell，画面停在退出界面，每天很多次，只能重开终端。

当天在崔总机器上核实并复现：

- `pgrep -a pi` 里有 **7 个 PPID=1、tty 已删除、0% CPU、存活 2–10 小时**的孤儿 pi 进程
  （关窗后残留），说明「退出」从未真正完成。
- tmux + `PI_TUI_WRITE_LOG` 实测（20 个扩展包，用 `-ne -e` 复刻）：
  健康退出 2134 ms / 5019 ms；`pi -ne` 121 ms；**三次里有一次永不退出**。
- 卡死时终端已恢复 cooked mode（`icanon`/`echo`/`isig` 在），画面是最后一帧；
  Ctrl+C 与 `kill -TERM` 都无效（宿主 `isShuttingDown` 把后续 shutdown 请求吞掉），
  只有 `kill -9` 生效。
- 代码路径：`shutdown()` → `stop()` → `await runtimeHost.dispose()` →
  `emitSessionShutdownEvent()` 串行 await 所有扩展的 `session_shutdown`，**无超时**；
  1.5.0 与 `main` 一致。上游 issue #9997（0.86/0.87 起）被机器人自动关闭，未修。

## 决策（与崔总确认「直接做进插件」）

1. **触发源 = 终端收尾序列**，不是 `session_shutdown`。pi 串行 await，若卡死处理器比本包先
   加载，本包自己的 `session_shutdown` 不会运行——按事件挂看门狗会漏掉要抓的场景。
   实现在 `process.stdout.write` 上做单例观察：`\x1b[?2004l`（`ProcessTerminal.stop()`）
   与 `\x1b[?1049l`（fullscreen 退备用屏）都在收尾阶段之前。
2. **解除条件 = TUI 重新进入 / resume**：`\x1b[?2004h`、`\x1b[?1049h`、`SIGCONT`。
   覆盖 `/settings` 切 TUI 模式（`switchTuiMode` 先 stop 旧渲染器）与 Ctrl+Z 挂起/resume
   （`handleCtrlZ` → `ui.stop()`，SIGCONT → `ui.start()`）。到期回调经 `setImmediate`
   延后一拍，保证 resume 先解除。
3. **默认开、10 s、写报告**。计时从收尾序列起算（不含 TUI 自己停下来的时间）。
   `/quit-guard [on|off|<ms>]`，配置落 `<agent-dir>/pi-toolkits-quit-guard.json`，
   ms 钳制 2000–60000。
4. **触发时先落盘报告，再退出**：`<agent-dir>/quit-guard/quit-hang-<ts>-<pid>.json`，
   含 arm/fire 时序、触发的 marker、`activeHandles`、`activeRequests`、libuv 表。
5. **退出走 `process.exit(0)` + 500 ms 后 SIGKILL 兜底**（先排定时器再 exit；正常路径
   不会触发）。调试中真实撞到过一次「exit 之后进程仍在事件循环里」，因此保留兜底。
6. **触发前复核 `process.stdin.isRaw`**：收尾序列也可能是被渲染的内容（工具输出/文件正文
   恰好含该转义序列）；raw mode 是独立信号——TUI 收尾时会关掉它，`isRaw===true` 即说明
   会话还活着，解除而不杀。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/features/quit-guard/constants.ts` | 标记常量、默认/钳制区间、理由注释（新建） |
| `src/features/quit-guard/guard.ts` | 纯状态机 + `findMarker`，依赖注入 clock/scheduler/defer（新建） |
| `src/features/quit-guard/store.ts` | 配置存储：损坏回落默认、原子写、时长时间钳制（新建） |
| `src/features/quit-guard/report.ts` | 报告采集/同步写盘，失败只警告（新建） |
| `src/features/quit-guard/index.ts` | stdout 单例包装、SIGCONT、`/quit-guard` 命令、`PI_QUIT_GUARD_DEBUG`（新建） |
| `src/features/quit-guard/quit-guard.test.ts` | 45 个用例（新建） |
| `src/index.ts` | 注册 `registerQuitGuard(pi)`，头部功能清单补一行 |
| `README.md` / `README.zh-CN.md` | 新章节 + 目录 + 功能表 + 项目结构；简介「七个」→「九个」并补上 init |
| `AGENTS.md` | 新增 `## Feature: quit-guard` 段 |

不变量：stdout 包装每进程只装一次（`globalThis` + `Symbol.for`，`/reload` 只刷新配置）；
时间用 `performance.now()`（单调）；报告写盘失败绝不阻塞退出。

## 验证

- `pnpm typecheck` 绿；`pnpm test` **31 文件 / 649 测试**全绿（本功能 45 例）。
- 真实 pi 1.5.0 冒烟（tmux；卡死探针 = `session_shutdown` 返回永不 resolve 的 Promise，
  且**先于**本包加载，证明不依赖处理器顺序；每轮用临时 `PI_CODING_AGENT_DIR` 与独立
  `pi-toolkits-quit-guard.json`）：

  | 场景 | 结果 |
  | --- | --- |
  | fullscreen + 卡死，timeout=2000 | 收尾后 **2.15 s** 退出，报告写出 |
  | `tuiMode: "regular"` + 卡死，timeout=2000 | **2.15 s** 退出（走 `?2004l`） |
  | 无卡死探针 | **0.11 s** 退出（看守不拖慢正常退出） |
  | `/quit-guard 4500` 后卡死退出 | **4.66 s**；配置已持久化 |
  | 默认 10 s（真实 agent dir，首次冒烟） | 报告 `elapsedMs≈10000`、`marker=?2004l` |
  | 默认 10 s（真实 agent dir，加 raw-mode 复核后复测） | **10.12 s** 退出，报告 `elapsedMs=10006` |

- 报告样本（真实 agent dir 首次冒烟）：`activeHandles=['ChildProcess','ReadStream','Socket',
  'WriteStream']`，`libuv` 44 条；临时 agent dir 的纯探针场景为
  `['ReadStream','WriteStream']` 且 libuv 表基本为空——正是「卡在永不 settle 的 Promise」
  的特征。样本另存 `/mnt/c/src/tmp/quit-guard-smoke/sample-report.json`（未入库）。
- 宿主事实（写进 AGENTS.md）：`?2004l` 由 `ProcessTerminal.stop()` 直接
  `process.stdout.write`，**不进** `PI_TUI_WRITE_LOG`；调试只能用
  `PI_QUIT_GUARD_DEBUG=<file>`。

## 测试期间的噪声（不影响结论）

- 首轮冒烟把超时 (10 s) 的实际耗时记成 7241 ms：WSL 墙上时钟回跳，`Date.now()` 差值失真。
  已把看门狗默认时钟换成 `performance.now()`。
- 临时 agent dir（无凭据/模型）下，桩扩展的 `session_shutdown` 不再阻塞退出（去掉本包、不加
  任何包装也复现），因此「off 开关」「/reload 后退出」两组反向用例在该夹具里不可判定；
  这两条逻辑由单测覆盖（`enabled:false` 不 arm、reload 复用共享状态）。
- tmux 夹具里 `/reload` 后 `/quit` 整体不生效（无包装时同样），属宿主/夹具噪声，未归因本功能。
- 全量测试在机器上同时跑着 22 个 `pi` 进程时出现过 **1 次 / 638 的偶发失败**（未留下用例名，
  机器负载高，符合 vitest 配置注释里记过的内存压力型抖动）；随后连跑 3 次全绿（638/638）。
  未改任何断言。

## 边界与后续

- 只覆盖交互式 TUI；print/JSON/RPC 不写收尾序列，看守不生效。
- 只覆盖收尾之后的卡死（`drainInput` 上限 1 s，之前就卡住未观察到）。
- 触发即跳过剩余扩展清理——这是设计目标；会话 JSONL 增量落盘，已写入内容不丢。
- pi 若给 `session_shutdown` 加上限（修 #9997），本功能可整体删除；届时只需清理
  README/AGENTS 段落与 `src/index.ts` 的注册行。
