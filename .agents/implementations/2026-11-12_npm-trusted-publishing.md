# 2026-11-12T02:04:38+08:00 — npm 发布迁移到 GitHub Actions + OIDC trusted publishing（本仓）

## 需求（崔总 2026-11-11）

把本仓的 npm 发布从「本地 bypass token 直接 `pnpm publish`」迁到 GitHub Actions 的
trusted publishing（OIDC）：CI 发布不需要 token、不需要 2FA，自动带 provenance。
**最后的发版动作仍由人做**——问题不在「谁按按钮」，在「哪一步算发版」。结论：
**推 tag 就是发版**，`pnpm release` 保留为唯一的发版命令。

## 改动

- `.github/workflows/publish.yml`（新增）
  - 触发：`push: tags: ['v*']` + `workflow_dispatch`（输入已存在的 tag，用于失败后重跑）。
  - `permissions: {contents: read, id-token: write}`、`environment: npm`、无任何 token。
  - action 钉 SHA：checkout `fbc6f39…`(v5)、pnpm/action-setup `b906aff…`(v4)、
    setup-node `a0853c2…`(v5)；`node-version: 22`、`pnpm 12`。
  - 步骤：`npm install -g npm@^11.15.0`（OIDC 交换要 ≥11.5.1；npm 12 的 sigstore
    打包坏，会报 Cannot find module 'sigstore'）→ `pnpm install --frozen-lockfile`
    → typecheck / test / ui:typecheck / ui:check → 校验 tag == package.json version
    → 已发布则跳过（幂等）→ `pnpm publish --no-git-checks --ignore-scripts
    --access public --provenance`。
  - 刻意不加 `registry-url`（会写 `_authToken=${NODE_AUTH_TOKEN}`，本工作流没有任何
    token）与 `cache: pnpm`（发布作业带 `id-token: write`，不接受无法校验的缓存；
    zizmor cache-poisoning）。
- `scripts/lib/ci-publish.mjs`（新增）
  - `waitForCiPublish`：轮询 npm 版本 + GitHub workflow run；run 失败立即返回（带
    run URL），不白等 15 分钟；`published | failed | timeout` 三态。
  - `waitForAttestations` / `npmAttestations` / `npmVersionPublished`：
    `npm view <pkg>@<ver> dist.attestations --json` 解析。
  - 只读：npm registry + GitHub REST（有 `GITHUB_TOKEN` 就用，没有也能读公开仓）。
- `scripts/publish.mjs`（改造，保留旧路径）
  - 默认：干净检查 → 上一版尾部校验 → gates → bump → commit + tag → 自检
    （tag == HEAD、工作区干净）→ **推分支 + 推 tag（发版信号）** → 等 CI（失败即中止）
    → 远端 tag 校验 + 幂等建 Release → 尾部自检。
  - `--prepare-only`：停在 push 之前，打印推送命令（"准备都做完、发不发由人按最后一次"）。
  - `--no-wait`：推完 tag 就返回，不轮询、不建 Release。
  - `--local`：保留旧的本机 `pnpm publish` 路径（应急；2027-01 起 bypass-2FA
    granular token 失去直接发布能力，届时应改 `npm stage publish` + 网页审批）。
  - 尾部自检从三项变四项：npm 版本、**provenance**、远端 tag、Release。
    npm 缺版本或 provenance 为空 → 退出码 1（迁移的硬验收）；Release 缺失仍只提示。
  - 等待顺序是「先等 CI，再建 Release」：Release 不应指向一个没发出去的版本。
- `AGENTS.md` / `README.md` / `README.zh-CN.md`：发布章节改写（tag 约定、一次性
  trust 配置、失败重跑、flags、尾部四项）。

## 关键决定（与替代方案）

- **`pnpm publish` 而不是 `npm publish`**：pnpm 11+ 原生支持 OIDC，并把 token 交换
  委托给 npm CLI（所以镜像里必须装 npm ≥11.5.1）；同时保留 pnpm 对
  `workspace:` / `publishConfig` 的发布期改写——虽然本仓没有 workspace 依赖，但
  未来加也不至于埋雷。
- **发布作业不用 setup-node 的 `cache: pnpm`**：缓存可被同仓写者投毒，而发布作业
  有 `id-token: write`；省十几秒不值这个风险。
- **tag 是唯一发版信号**：`workflow_dispatch` 只是同一 tag 的重跑入口（版本检查
  用 tag 输入），不是第二个发版入口。
- **不用 `actionlint`**（本机没有）：用 pi-lens 的 GitHub Workflow schema 校验 +
  人工逐行核对；`pnpm release --dry-run` 只读。

## 验证

- `pnpm typecheck`、`pnpm ui:typecheck`、`pnpm ui:check` 绿；`pnpm test`
  **42 文件 / 777 测试**全绿。
- `pnpm release patch --dry-run`：计划输出与实现一致（推送分支+tag、等 CI、
  Release、四项自检）；上一版 v0.12.4 远端 tag 校验为「已就位」。
- `pnpm pack --dry-run`：tarball 仍只含 `src/**`（+ README/LICENSE/package.json）。
- 辅助器实测（只读）：`npmVersionPublished(0.12.4)=true`；
  `npmAttestations(vite@8.3.8)` 解析出 1 条（本仓 0.12.4 为 0，旧 token 发布无 provenance）；
  `waitForCiPublish` 在版本已存在时立即返回 `published`；`waitForAttestations` 有效。
- `.github/workflows/publish.yml` 通过 YAML/GitHub Workflow schema 校验。
- 无法在本机验证的部分：真实 Actions 运行、OIDC 交换、provenance 附着——第一次
  发版时验证（见下）。

## 待人工执行（不能由 agent 代做：需要交互式 2FA）

```bash
npm trust github @andares/pi-toolkits \
  --repo andares/pi-toolkits --file publish.yml --env npm --allow-publish
```

前置：npm ≥ 11.15.0、`npm login --auth-type=web`（安全密钥/通行密钥）。当前本机
`~/.npmrc` 里是 bypass-2FA 的 granular token，`npm trust list` 已实测 403——
必须先用 web 登录换掉，再跑上面这条。

第一次发版：`pnpm release patch` → 推 `v0.12.5` → CI 发布 → 脚本核验
`npm view @andares/pi-toolkits@0.12.5 dist.attestations` 非空。

## 并发说明

`scripts/publish.mjs` 的初版改动由同一 cwd 的另一个 agent 会话先写入（用户已让其
停止）；本次接管后统一为上面的实现（去掉了重复的内联轮询），没有回退它的
`--prepare-only` 设计。

## 第三方复核修正（2026-11-12T02:16:59+08:00）

复核发现 `scripts/lib/ci-publish.mjs` 的 `findWorkflowRun` 在「本次 sha 还没有对应
workflow run」时会回落到「仓库里任意 run」，可能把别的提交的失败误判成这次发版失败。
已改为**只接受 head_sha 匹配的 run**（不匹配返回 undefined，继续轮询）。
其余结论（`prepublishOnly` 会被 pnpm 从发布 manifest 中剥掉、`npm view` 对未发布版本
E404 非零退出、`pnpm publish --provenance` 在 npm 官方有实证）经核实均成立。
