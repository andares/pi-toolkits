# 2026-11-10T14:05:00+08:00 — quit-guard 默认值改为 8 s（默认开启不变）

## 需求

> 上一次要我们加 quit guard，能不能默认开启，timeout 设 8 秒

两半分开答：

- **默认开启**：本来就是。`DEFAULT_CONFIG = { enabled: true, timeoutMs: …, report: true }`
  （`src/features/quit-guard/store.ts`），没有配置文件时就是这个值；本机
  `~/.pi/agent/pi-toolkits-quit-guard.json` 不存在，所以一直跑的是默认值。
- **timeout 8 秒**：原来是 10 s，本次改掉。

## 改动

| 文件 | 改动 |
| --- | --- |
| `src/features/quit-guard/constants.ts` | `DEFAULT_TIMEOUT_MS` `10_000` → `8_000`；注释写明依据：实测健康退出端到端最慢 5 s（收尾后最多 2 s），8 s 留约 3 s 余量，同时比 10 s 更早把提示符还回来 |
| `src/features/quit-guard/store.ts` / `index.ts` | 文档注释里的配置示例 `10000` → `8000` |
| `src/features/quit-guard/guard.ts` | 时钟回跳注释里的举例数字跟随新默认值（8 s → 5 s） |
| `README.md` / `README.zh-CN.md` | 配置示例 + 余量说明，并补一句「默认开启（8 s、写报告），装上就有保护」 |
| `AGENTS.md` | 决策段改为「默认开启、8 s」，注明由崔总 2026-11-10 定；已验证段补实测数字 |

钳制区间不变（`MIN_TIMEOUT_MS` 2000 / `MAX_TIMEOUT_MS` 60000），8000 落在区间内；
`/quit-guard <ms>`、`on`/`off` 的行为都不变。

## 为什么不改得更激进

健康退出实测最慢 5 s（20 个扩展包，端到端；其中约 2 s 在收尾序列之后）。再往下压到 5–6 s
就会把「慢但能完成」的收尾（记忆库 flush、MCP 关连接）误杀成强制退出，而强制退出是
`process.exit(0)` + SIGKILL 兜底——代价比多等两秒大得多。8 s 是「比 10 s 早、又明显高于
最慢健康退出」的位置。

## 验证（真实 pi 1.5.1，tmux）

| 场景 | 结果 |
| --- | --- |
| 无配置文件 + 卡死探针（`session_shutdown` 永不 settle，先于本包加载） | **8.12 s** 退出；报告 `timeoutMs=8000 / elapsedMs=8005 / marker=?2004l`；debug 日志 `register … enabled=true timeout=8000` |
| `/quit-guard` 状态 | `quit guard: on · timeout 8000ms · report on · last hang: …` |
| 健康退出（无探针） | **0.12 s**，5 轮（3 轮直接 `/quit`，2 轮先看状态再 `/quit`） |

`pnpm typecheck` 绿；`pnpm test` 32 文件 / 660 测试全绿（quit-guard 45 例不变——测试里
断言的是 `DEFAULT_TIMEOUT_MS` 常量与显式字面量，不依赖具体数值）。

## 观察（不是本改动的回归）

tmux 夹具里偶发「`/quit` 发出后不退出」：本轮 2 次、上一轮（1.5.1 冒烟）1 次，重发或换一次
运行即正常，正常样本连测 5 次全 0.12 s。与 2026-11-05 记录的「tmux 夹具里 `/reload` 后
`/quit` 不生效（无包装时同样）」同属夹具/启动期噪声，未归因本功能。
