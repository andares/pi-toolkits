# 2026-11-11T02:55:59+08:00 — `/ask-plan` 第三方评审与修正

## 范围

只审本轮 ask-plan 的实现（`41701dd`…`3514e2e`）及为接线新增的 permission/ask 控制面。
不改其它功能的历史行为。

## 已确认并修复

1. **首版计划被全部折叠**：UI 默认隐藏 `unchanged`，而首版 diff 为空。改为仅在确有变更时折叠；
   浏览器实测首版标题、正文、列表均可见。
2. **历史旧版被当成当前版**：旧版会显示批注编辑器和可用决策按钮。以历史列表的最新编号为准判定只读，
   并在切换版本时清除旧版决策状态；服务端同时拒绝对旧版批注/决策（409）。
3. **历史裁剪后版本号复用**：`n = versions.length + 1` 会重写旧快照。改为 `latest.n + 1`；
   测试连续追加到 v54，编号唯一、快照不覆盖，被决策版本仍保留。文件名同步为约定的 `vNNN.md`。
4. **跨计划串台**：离开后再 `/ask-plan` 会追加进上一轮。新阶段重置 review session；pi 会话切换时清理
   gate、服务器、工具与 permission 快照，不恢复旧会话状态。
5. **未自动退出 `/ask`**：新增 `src/lib/ask-control.ts` 注册表，计划期开始前调用 owning feature 的 exit，
   保持工具快照恢复语义。
6. **计划期写入边界不完整**：write/edit 与 plan_submit 现在都只接受工作区内 `.md/.mdx`，并复用
   permission 的 `canonicalize/isWithin`，阻止 `../`、绝对路径和 symlink 逃逸。
7. **permission 恢复覆盖用户手改**：只有当前策略仍等于计划期策略时才恢复进入前快照；中途的手动策略优先。
8. **diff 输出顺序错误**：移动块曾被放到错误文档位置。改为仅按 LIS 锚点切段，移动块不参与切段；
   新增 80 组确定性重排/编辑用例，校验每个新旧块恰好被解释一次。
9. **删除块批注丢失**：反馈模板现在可从上一版取删除块文本并输出其批注。
10. **未闭合围栏丢最后一行**：渲染器只在末行确实是合法闭合围栏时剔除它。
11. **服务端安全/语义**：非 WSL 不再误用 WSL 绑定；Origin 无端口按协议默认端口而非评审端口；
    缺少 Origin 但有 cross-site/same-site 信号时 fail closed；重复决策返回 409；静态文件用真实路径
    containment；默认 renderer 始终转义；打开器处理异步 spawn error。
12. **迟到的浏览器决定**：退出计划期或换会话后不再回投消息。
13. **UI 检查时机**：release 在 bump 之前运行 `ui:typecheck + ui:check`，prepublishOnly 也保留 UI 门禁，
    防止过期构建进入 npm 包。

## 验证

- `pnpm typecheck`、`pnpm ui:typecheck` 绿。
- `pnpm test`：42 文件 / 773 测试全绿；ask-plan 106 例。
- 真实浏览器（Playwright）：首版可见、旧版只读、块批注保存、deny 后服务器端口关闭、页面显示关闭提示。
- 真实 pi 宿主：`ask-plan[extension]` 注册，`plan_submit` 默认不激活，冒烟回 `OK`。
- `pnpm check:compat --skip-tests`：窗口 1.2.0–1.5.2 全绿；探针 1.1/1.0/0.99 绿，0.87 因既有
  `defaultActive`/`parentToolCallId` 停探；floor 0.99.0。

## 未修 / 备注

- 尚未让真实模型执行完整 `/ask-plan` 工作流；目前覆盖的是单元、真实 HTTP/SSE、浏览器与宿主加载。
- 兼容矩阵发现宿主 1.5.2 已进入窗口且本轮全绿；按本轮范围约束，未另开上游版本迁移/dist 人工 diff 任务。
