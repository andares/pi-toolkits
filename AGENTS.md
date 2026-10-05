# pi-toolkits Project Guidelines

## Package Management

- **This project uses `pnpm` as the sole package manager.**
- Use pnpm equivalents for everything:
  - `pnpm install` / `pnpm add -D <pkg>` / `pnpm remove`
  - `pnpm publish` (never `npm publish`)
  - `pnpm dlx <pkg>` instead of `npx`
  - `pnpm typecheck` / `pnpm test` for scripts
- Do **not** run `npm install`, `npm publish`, `npx`, or `npm whoami` in this
  project — always use the pnpm form.

## pi 宿主兼容

**核心纪律：兼容区间必须覆盖「最近 4 个已发布中版本线」，且每次改动宿主依赖或
宿主内部 API 都要重跑验证。**（当前区间 `>=0.86.0 <2.0.0`，覆盖 0.86 / 0.87 /
0.99 / 1.0 —— 0.88–0.98 从未发布。）

- **窗口纪律**：兼容下限必须 **≤「最近 4 个已发布中版本线」中最旧的一条**（不能只支持最新几版）。
  随着 pi 发布新的中版本，窗口滑动时方可抬升下限：例如 1.1 发布后，最近 4 条变为
  1.1 / 1.0 / 0.99 / 0.87，下限可从 0.86.x 抬到 0.87.x，但不得提前抬到 1.0。
  下限的每次抬升必须在提交信息里写明「老版本为何不再支持」的实测结论。
  README 的 Requirements 段与该区间必须同步修改。
- **peer 声明规则**（pi ≥ 0.99 启动时校验）：宿主提供的包（`@earendil-works/pi-*`）
  **只能**放进 `peerDependencies`，进 `dependencies` 会被 pi 告警
  「Host-provided extension packages must be declared in peerDependencies」。
  其中 `pi-tui` 用 `"*"`（运行时由宿主 virtual modules 重定向到宿主副本，值导入
  也不需要 `dependencies`）；`pi-coding-agent` 用实测支持区间——pi 托管安装禁用
  peer 解析（`--legacy-peer-deps` / `--omit=peer`），区间不参与安装求解，只作兼容声明。
  （规则按 pi 1.0.2 源码核实：只校验 `dependencies` 成员，不校验 peer 区间；pi 升级时重新确认。）

**改 pi 依赖或动用宿主内部 API 时的验证义务（三步全做）：**

1. **区间内全部已发布版本比对宿主 dist**：解包 tarball 后 diff 受影响的内建文件，
   重点盯运行时 patch 目标 `ModelSelectorComponent`
   （`modes/interactive/components/model-selector.js`）与 `AgentSession.cycleModel`
   （`core/agent-session.js`）。取 tarball 可用 `pnpm view <pkg> dist.tarball` + `curl`，
   或 `npm pack <pkg>@<ver>`（只下载不解包安装，不属 Package Management 禁止的
   install/publish；不要用 `npx`）。
2. **多版本矩阵 typecheck + 测试**：至少在区间端点与最新版上跑 `pnpm typecheck`
   与 `pnpm test`。矩阵做法：复制仓库到 **Linux 本地盘**（`/tmp`），逐版本改
   `devDependencies` 后安装验证；**不要在 `/mnt/c` 等 Windows 挂载盘上跑
   pnpm/vitest**——那里 1 秒的测试要跑 2 分钟（I/O 慢两个数量级）。
3. **真实 pi 冒烟加载**：
   `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'`，
   要求无 Extension 警告、正常回包。

**内建行为同步义务**：`compact` 的摘要 prompt 与预算公式逐字复刻 pi 内建实现，
`favorites` 的两个 patch 复刻内建语义——pi 升级时 diff
`core/compaction/compaction.js`、`core/compaction/utils.js`、`model-selector.js`、
`agent-session.js`，有变化就同步代码或改正注释里的版本声明（注释中的「已验证区间」
必须与 peer 下限一致）。

## Release

- **前置条件：工作区必须干净**——release 提交只含版本号（`git add package.json`），
  有未提交变更时脚本会在任何改动前直接中止。否则未提交内容会被打包进 npm
  包（pnpm 从工作区打包）却不进 tag，造成「tag 内容 ≠ 实际发布内容」
  （v0.4.0 事故）
- `pnpm release <patch|minor|major> [--dry-run]` 一键发布：干净检查 →
  typecheck+test → bump → commit + tag（`scripts/tag-current.mjs` 打
  `vX.Y.Z`，已存在则跳过）→ **自检：tag == HEAD 且工作区干净**（否则中止）
  → `pnpm publish`（失败即中止，版本已锚定）
  → **npm 成功后**：只推当前分支 + 当前 tag（`git push origin <分支>` +
  `git push origin refs/tags/vX.Y.Z`，不再 `--tags`）→ **校验远端分支/tag
  哈希与本地一致**；远端 tag 不一致 → 跳过 Release 创建并给出修复命令
  → 创建 GitHub Release `vX.Y.Z`（仅在远端 tag 校验通过后；best-effort，不中止）
- GitHub Release 依赖 `GITHUB_TOKEN` 环境变量（fine-grained token，
  Contents: write）；未设置时只提示。创建失败（403/422/网络等）后脚本会
  自动 `GET /releases/tags/{tag}` 查询确认：200 = 已存在（并发/重试/手动
  补建过）→ 视为成功跳过；404 = 真失败 → 提示可稍后手动补建，均不影响
  npm 已发布的结果
- `pnpm tag-current` 可独立使用：给当前版本打本地 tag（已存在跳过，不推送）
- 发布失败回滚：`git tag -d vX.Y.Z && git reset --hard HEAD~1`
- 需要覆盖远端 tag（如本地 tag 已重指）时：
  `git push origin refs/tags/vX.Y.Z --force`
