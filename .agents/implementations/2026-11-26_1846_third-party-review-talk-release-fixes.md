# 2026-11-26T18:46+08:00 — Third-party review fixes: isolate talk refreshes and diagnose release probe failures

对 2026-11-26 的 9 个提交及当前未提交的 outline 修复做第三方复核时，额外确认并修复了四个问题（outline 本体另记于 `2026-11-26_1629_outline-popup-row-height.md`）。

## Talk：旧回复的防抖保存污染新快照

`ui/src/TalkPage.tsx` 的 `reload()` 会载入新回复，但此前没有取消旧回复尚未触发的 300ms `scheduleSave`。真实构建产物 + mock HTTP/SSE + headless Chrome 复现：输入 `draft from old reply` 后 40ms 触发 refresh，浏览器已经显示新回复且草稿为空，服务端新快照却被随后的旧定时器写入 `draft from old reply`。

现在 `reload()` 在取新状态前取消并清空待执行的保存定时器。相同探针复测：新回复浏览器与服务端草稿均为空，`/api/notes` 写入次数为 0。

## Release：把“探测失败”与“tag 不存在”分开

- `scripts/lib/github-release.mjs` 的 `resolveRemoteTag` 以前只把 spawn timeout 判为 `unknown`；`git ls-remote` 因 SSH / DNS / 认证等普通错误退出（status 128、stdout 为空）会被判成 `absent`，进而给出错误的“远端没有 tag，去 push”指引。现在只有 status 0 的空输出才算 absent，所有非零退出与 timeout 都返回 `unknown`。
- `scripts/publish.mjs` 为 `unknown` 新增了处理提示；此前这个今日新增状态没有 hint，真实执行会输出 `...undefined`。标签改为“git 探测失败或超时”，提示先 `git ls-remote` 人工复核，不把失败等同于缺失。
- `boundedSshCommand` 以前只要命令里出现 `ServerAliveInterval` 就完全不加其余选项；例如 `ssh -o ServerAliveInterval=7` 会没有 `BatchMode` 和 `ConnectTimeout`。现在逐项补齐缺失选项，操作者已有的值保持优先。

`scripts/lib/github-release.test.mjs` 新增两个回归用例：普通 ls-remote 失败必须返回 unknown；部分 SSH 自定义配置必须补齐其余 deadline。发布主流程用 fake git 做了真实路径验证：status 128 时按预期 exit 1，输出 unknown 与恢复步骤，且不含 `undefined`。

## 验证

- `pnpm typecheck` 绿；`pnpm test` 60 文件 / 1013 测试全绿；`pnpm ui:typecheck` 绿。
- `pnpm ui:build` 连续两次产物哈希一致；已更新 `src/features/review-page/assets/`，UAT 产物未变。
- 真实 pi 1.6.1 冒烟：`pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'` 返回 `OK`。
- 19 行 outline 复测行高均 31.55px，文字上下留白均 7px，列表 419px 可视 / 627px 内容正常滚动。

未跑 `pnpm ui:check` 的 git-clean 断言：本轮构建产物尚未提交，该断言设计上要等提交后才能成立；已用连续构建哈希一致验证产物不过期。
