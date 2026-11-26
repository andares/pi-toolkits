# 2026-11-26T15:05+08:00 — Release tail self-check: bound every child process and say what it is waiting for

`pnpm release` v1.2.1 printed `▾ 尾部自检（这一版的四处证据）` and then nothing for ~47 minutes (13:38 → 14:22 on 2026-11-26, interrupted by hand). Tag, npm version and GitHub Release were all fine; only the report was stuck.

What the tail step actually does, and what was unbounded:

| 检查 | 调用 | 原来的上限 |
| --- | --- | --- |
| npm | `fetchPublishedVersion` + `npm view` 兜底 | 60 s（deadline 用 `Date.now`） |
| provenance | `fetchAttestations` + `npm view` 兜底 | 120 s（同上） |
| remote tag | `git ls-remote origin`（spawnSync，**无 timeout**） | 无 |
| release | `curl`（spawnSync，**无 timeout**） | 无 |

`spawnSync` 卡住时事件循环被占住，任何 JS 定时器都跑不了；`git ls-remote` 还会把 stdout 管道交给 `ssh`，杀掉 git 也未必能解除阻塞。ssh 自己没有任何默认超时——这正是 WSL 上一条被静默丢弃的 TCP 连接能变成「永远等下去」的路径。而这一步在等待期间**一行都不打印**，于是「正在等」和「已经挂了」在屏幕上完全一样。

改动：

- `scripts/lib/github-release.mjs`
  - `GIT_TIMEOUT_MS` / `CURL_TIMEOUT_MS`（20 s）+ `killSignal: "SIGKILL"` 加在所有 spawn 上；
  - `boundedSshCommand()`：给 `GIT_SSH_COMMAND` 补 `BatchMode=yes`、`ConnectTimeout=10`、`ServerAliveInterval=5`、`ServerAliveCountMax=3`（保留操作者自己的 `-i` 等参数，已有 ServerAlive 就不重复加）——让 ssh 自己先放手；
  - `isSpawnTimeout()` + `resolveRemoteTag`/`releaseTailGap` 新增 `unknown` 状态：被超时杀掉**不等于** ref 不存在，两者混为一谈会把网络卡顿误诊成「远端缺失」；
  - `githubApi` 的 curl 加 `--connect-timeout 5 --max-time 20`。
- `scripts/lib/ci-publish.mjs`
  - `waitForNpmVersion` / `waitForAttestations` 的 deadline 改用单调时钟（`performance.now()`）：WSL 每 30 s 报一次 "Clock change detected"，墙上时钟回跳会让 `now - started >= timeoutMs` 永远不成立；
  - 两个等待都新增 `onWait({ elapsedMs, ... })` 进度回调。
- `scripts/publish.mjs`
  - 尾部自检每一步先打印「在等什么 + 上限 + `t=Ns`」，等待中也按 10 s 打印一行；`TAIL_LABEL` 增加 `unknown`。
- 测试：`scripts/lib/github-release.test.mjs`（新增，7 例：ssh 参数组合、git spawn 的上限与 env、超时→unknown、mismatch/absent 仍能区分、curl 参数）；`ci-publish.test.mjs` 两个等待各加 onWait 断言。

实测：健康路径整步 ~6 s（`npm 2 s → provenance 1 s → remote tag 3 s`），每一步都有进度行；最坏路径（两个等待都超时 + git/curl 各一次超时）约 4 分钟封顶，不再可能无限静默。

门禁：`pnpm typecheck` 绿；`pnpm test` 60 文件 / 1021 测试全绿；真实 pi 1.6.1 冒烟 `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'` 回 `OK`。
