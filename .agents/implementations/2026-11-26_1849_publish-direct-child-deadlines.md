# 2026-11-26T18:49+08:00 — Bound the publish command's own child processes, not only its GitHub helpers

第三方复核 v1.2.2 的 release 改动时发现覆盖缺口：`scripts/lib/github-release.mjs` 里的 `git` / `curl` 已有 deadline，但 `scripts/publish.mjs` 自己通过 `run()` 发起的 `spawnSync` 仍无 timeout；`git push` 走的就是这条路径，所以死 SSH 仍能卡住主流程，与 v1.2.2 changelog 的“Every child process it spawns has a deadline”不一致。

`scripts/publish.mjs` 的 `run()` 现在：

- git 子进程使用共享的 `GIT_TIMEOUT_MS`（20s）与 `SIGKILL`，并注入 `boundedSshCommand`，保留操作者自己的 GIT_SSH_COMMAND / `-i` 等参数；
- pnpm / node 等其他直接子进程使用 15 分钟上限，防止包管理器或门禁子进程永久占住某一个阶段标题；
- 调用方原有 `opts` 仍最后展开，可以显式覆盖 stdio 等选项。

验证：用 PATH 中的 fake git 让直接 `rev-parse`（不是共享 helper 的 `ls-remote`）执行 `exec sleep 60`，实际运行 `node scripts/publish.mjs patch --dry-run --skip-tail-check`，20s 后如期恢复并完成 dry-run（未改工作区），证明 publish 自己的 `run()` 已生效。随后 `node --check scripts/publish.mjs`、release 两组 20 个定向测试、`pnpm typecheck`、`pnpm test`（60 文件 / 1013 测试）、`pnpm ui:typecheck` 与 `git diff --check` 全绿。

`scripts/tag-current.mjs` 自己内部的本地 `git rev-parse` / `git tag` 仍是更早版本留下的无 timeout 调用；它只执行本地操作，且本次发布主流程调用该脚本本身已有 15 分钟上限。这条作为历史边界记录，未扩大本轮修改。
