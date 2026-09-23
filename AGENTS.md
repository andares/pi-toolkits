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
