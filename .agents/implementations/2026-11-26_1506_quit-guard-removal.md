# 2026-11-26T15:06+08:00 — Remove quit-guard (the quit watchdog and its force-exit)

崔总 2026-11-26 决定：移除「退出卡住超时后强制退出」的看门狗。理由是实测下来卡住并不总是我们自己的问题（与外部系统有关），强制退出既没解决卡住，又把真正的现场抹掉了——「该卡就卡」比「假装解决」更诚实。

删掉的东西：

- `src/features/quit-guard/`（8 个源文件 + 2 个测试文件，55 个用例）：状态机 `guard.ts`、配置 `store.ts`、诊断报告 `report.ts`、线程杀手 `killer.ts`、命令入口 `index.ts`、常量；
- `src/index.ts` 的 import 与 `registerQuitGuard(pi)`、文件头 feature 清单里的一行；
- `package.json` 描述里的 "a quit watchdog"、keywords 里的 `quit-guard` / `watchdog`；
- README（中英）的章节、目录项、命令表行、项目结构树；
- `AGENTS.md` 的整个 `## Feature: quit-guard` 章节（约 150 行）。

保留/顺带修的：

- `src/lib/approval-log.ts` 的 `redactText` 留在原处（审批日志自己用），注释改成「别处要写进程参数时复用它」，不再说「为看门狗导出」；
- 三处历史文字里的「quit-guard 仍然必要 / 照管 / 会硬退」改成纯宿主事实（`AGENTS.md` 1.5.1 与 1.6.0 的逐文件结论、`specs/keep-sessions.md` 两条），因为那些段落记录的是 pi 的收尾链无超时，与我们的兜底无关；
- `.agents/memory/ARCHITECTURE.md` 的 feature 列表 13 → 12、去掉 `quit-guard`；
- `.agents/memory/FINISHED.md` 新增 M7 收口条目（决定、删了什么、保留了什么、后果、证据）；
- `CHANGELOG.md` 的 `## Unreleased` 加一条移除公告（升级后首次启动由 whats-new 展示）。

已知后果（有意）：宿主 `runtimeHost.dispose()` 仍是无超时串行 await，某个扩展的 `session_shutdown` 永不 settle 时进程会一直挂着（`/quit` 后终端已还原、画面停在最后一帧）。没有兜底之后，卡住时现场还在，可以自己 kill 并留下证据。

磁盘上历史遗留的 `~/.pi/agent/pi-toolkits-quit-guard.json` 与 `~/.pi/agent/quit-guard/*.json` 未删除（属于操作者磁盘，不再被读取）。

门禁：`pnpm typecheck` 绿；`pnpm test` 60 文件 / 1021 测试全绿（1068 − 55 + 8 = 1021，减的是看门狗用例、加的是同轮 release 尾部自检用例）；真实 pi 1.6.1 冒烟 `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'` 回 `OK`、无 Extension 警告。
