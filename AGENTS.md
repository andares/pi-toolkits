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

- `pnpm release <patch|minor|major> [--dry-run]` 一键发布：校验 → typecheck+test
  → bump → commit + tag（`scripts/tag-current.mjs` 打 `vX.Y.Z`，已存在则跳过）
  → `pnpm publish`（失败即中止，版本已锚定）
  → **npm 成功后**：`git push origin <当前分支> --tags`（尝试一次，失败仅警告
  ——可能此前已推过）+ 创建 GitHub Release `vX.Y.Z`（best-effort，不中止）
- GitHub Release 依赖 `GITHUB_TOKEN` 环境变量（fine-grained token，
  Contents: write）；未设置 / 已存在（422 already_exists）/ 其他失败都只提示，
  不影响 npm 已发布的结果，可稍后手动补建
- `pnpm tag-current` 可独立使用：给当前版本打本地 tag（已存在跳过，不推送）
- 发布失败回滚：`git tag -d vX.Y.Z && git reset --hard HEAD~1`
