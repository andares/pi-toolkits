# 2026-11-26T15:30+08:00 — Release is done when the workflow run is green — drop the npm/provenance tail checks

崔总 2026-11-26 定：**发版完成判据只有一个 —— tag 触发的 workflow run 绿了**。不要再去求一个「npmjs 上真的出现了这个版本」的结果。「以前没走 Actions 时，脚本推完 npmjs 就完事，谁去管 npmjs 处理好没有？」——同一个道理现在也成立：registry 的传播与 provenance 扫描是 npm 的事，要看自己点开包页面。

## 改了什么

`scripts/lib/ci-publish.mjs` 重写（从 560 行降到 ~300）：

- `waitForCiPublish` 现在只做一件事：盯住 run。`completed + conclusion === "success"` → `published`；`completed` 但不是 `success` → `failed`（带上 `conclusion`，报告里能写明是 failure / cancelled / timed_out / skipped）；run 一直不出现或一直不结束 → `timeout`。返回 `{ status, run, elapsedMs, conclusion }`。
- 删掉：`fetchPublishedVersion` / `fetchAttestations` / `registryVersionUrl` / `registryAttestationsUrl` / `tryFetch` / `npmVersionPublished` / `npmAttestations` / `waitForNpmVersion` / `waitForAttestations`，以及 `waitForCiPublish` 里的 registry 探针、`npm view` 复核、"CI 已绿、等 registry 传播" 那个阶段。
- 保留：按 sha 找 run、按 run id 接管补发的 run、僵尸 run 一次 `workflow_dispatch` 补发（这是 Action 进度问题，属于崔总认可的检测范围）、阶段化进度行 + `t=Ns`、稀疏读取 GitHub（10 s）。

`scripts/publish.mjs`：

- 第 7 步只等 run；失败时报告里带上 `conclusion`；超时提示改成「自己看一眼那个 run，绿了再补 Release」。
- 删掉整个第 9 步「尾部自检（四项证据）」，换成三行 `完成` 摘要：tag → sha、CI run URL、Release URL，外加一条 npm 包页面链接（只打印，不探测）。
- 不再有「npm 缺版本 / provenance 为空 → exit 1」这两条硬闸；Release 仍 best-effort（缺 token 只提示）。
- 清理随之失效的 import（`githubApi` / `parseJson` / `GIT_TIMEOUT_MS` / 两个 wait）与未使用的 `npm` 常量；`--dry-run` 的计划文本同步。

测试：`scripts/lib/ci-publish.test.mjs` 重写等待循环的用例（绿→published、红→failed 带 conclusion、cancelled/timed_out/skipped→failed、超时、僵尸 run 补发一次、running 不补发），删掉 10 个 registry/npm 用例；dispatch rescue 的 4 个用例原样保留。`pnpm test` 60 文件 / **1011** 测试全绿（上一轮 1021，少的正是被删掉的 registry/npm 用例）。

## 与上一条记录的关系

`.agents/implementations/2026-11-26_1505_release-tail-check-bounds.md` 记录的「给尾部自检加超时」仍然有效（`gitToolkit` / `githubApi` / `ssh` 的上限与 `unknown` 状态都留在 `scripts/lib/github-release.mjs`，`releaseTailGap` 还在用于「上一版 tag 校验」）；但那条记录里描述的「尾部自检四项」已经被本轮撤掉——以本轮为准。

## 验证

- `pnpm typecheck` 绿；`pnpm test` 60 文件 / 1011 测试全绿；`node --check` 两个脚本通过。
- `node scripts/publish.mjs patch --dry-run` 输出的计划已是新版（第 6 步「run 绿了就算完成」、第 8 步「收尾摘要（不查 npm）」）。
- 真实发版未跑（工作区有未提交变更，按纪律先提交再发版）。
