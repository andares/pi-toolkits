# 2026-11-13T02:44+08:00 — 发版等待：registry 改走 HTTP 探测、进度分阶段、排队卡死的 run 自动补发

v0.14.0 发完的真机复盘指出的三个问题，都在 `scripts/lib/ci-publish.mjs` 里改掉了。

## 1. registry 探测不再 spawn `npm view`

`npmVersionPublished` 每轮起一个子进程（本机实测 1.15 s），旧的等待循环 5 s 一轮、还带 30 s 的日志节流，
于是「等 npm」的每一轮都比被等的东西慢。现在 `fetchPublishedVersion` 直接 `GET
https://registry.npmjs.org/<name>/<version>`（`%2f` 编 scoped 名）：本机实测稳态 ~290 ms/次，
每 1.5 s 一轮。HTTP 返回 `undefined`（离线 / 5xx / 异常）**不当成「版本不在」**，而是退回 `npm view`
（每 10 s 一次）；HTTP 正常时仍每 30 s 用 `npm view` 做一次权威复核。provenance 轮询同样改成先打
`/-/npm/v1/attestations/<name>@<version>`。

## 2. 进度按阶段说话

原来整段等待只有一条被节流到 30 s 的 `waiting: completed / success`：v0.14.0 的 CI 只跑了 49 s
（18:26:38→18:27:27），之后 ~2 min 全在等 registry 读副本，日志却看不出在等什么。现在阶段是
`discovering / queued / running / registry`，每次阶段变化必打一行，另外每 15 s 补一行，都带 `t=Ns`；
进入 register 阶段时明确写「这段是 npm 的传播延迟，不是 CI 卡住」。

## 3. 僵尸 run 自动补发

GitHub 的 tag 触发的 run 会永久停在 `queued`（先例：v0.13.0 的 `43096640287` 至今 `queued`、
`started_at` 为空，永远不开始也不失败），等待本身救不了它。现在 run 是 `queued`、`started_at` 为空、
创建已超 `PI_RELEASE_RESCUE_QUEUE_MS`（默认 60000；`0`/`off` 关闭；健康时 3 s 内就开始）时，
补发**一次** `workflow_dispatch`（同 tag、ref=当前分支）并接管新 run。

接管必须按 **run id** 跟踪：dispatch run 的 `head_sha` 是分支头、不一定是 tag 的提交，用 sha 找会找丢
（所以加了 `fetchWorkflowRunById`）。只补发一次，新 run 也卡住就走原来的 15 min 超时。
没有 `GITHUB_TOKEN` 时不做补发（dispatch 需要写权限），并明确打印「不会自动补发」。

两个 run 同时在场不会重复发布：工作流自带的「已发布则跳过」那步兜住，最多多一条 publish 步骤被跳过的绿 run。

## 证据

- `pnpm typecheck` 绿；`pnpm test` **51 文件 / 915 测试**全绿（新增 `scripts/lib/ci-publish.test.mjs` 17 例：
  registry 200/404/5xx/异常、npm 兜底、红 run 立即 failed、超时、排队卡死补发并接管、运行中不补发、
  dispatch 204/422、dispatch run 的选取窗口、attestation 轮询）。
- 真机探针（本机 WSL，2026-11-12）：HTTP 探 0.14.0 → true（771 ms 含 TLS，稳态 290 ms），探 9.9.9 → false（329 ms），
  attestation → 2 条（511 ms），`npm view` → true（1150 ms）。
- 真实 GitHub 只读路径：`findWorkflowRun`（sha=732b0e4）→ `43279877439`；`findDispatchedRun` → `43170630173`；
  `fetchWorkflowRunById` 均正常。
- 补发路径**真机跑通**：对已发布的 `v0.14.0` 补发 → 7.0 s 拿到并接管新 run `43282484846`，
  该 run 46 s 绿、`Publish with provenance` 跳过（幂等为真）。
- `pnpm release patch --dry-run` 正常，第 6 步如实写出 `PI_RELEASE_RESCUE_QUEUE_MS=60000`。

脚本不在 npm 包里（`files: ["src", "CHANGELOG.md"]`），所以 **CHANGELOG 未加条目**——这是维护者的工具，
不是使用者看到的功能。
