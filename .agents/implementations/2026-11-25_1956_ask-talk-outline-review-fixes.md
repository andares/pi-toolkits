# 2026-11-25T19:56+08:00 — ask-talk 与标题索引的第三方评审修复

对 `/ask-talk`、标题索引与回到顶部做第三方代码复核，并直接修复本轮确认的问题。

**已修复**
1. `talk/index.ts`：新回复到来时原 server 仍闭包旧 TalkSession，导致刷新和 Continue 都用旧文。现在在活动页面上原位替换同一快照对象，路由与回调都读取新内容；新增命令级真实 HTTP 回归。
2. `talk/reply.ts`：同一 assistant 消息内，工具调用/thinking 前的过程话不再被拼进正式回复，只取最后一个边界后的连续 text 段。
3. `review-page/blocks.ts`：ATX 标题即使没有前后空行也独立成块；围栏内 `#` 仍是代码。标题进入索引但不开放批注，正文独立批注，与批准稿 D6 对齐。
4. `TalkPage.tsx`：Continue 收集正在编辑、尚未 Save 的批注（清空即删除）；提交中锁定表单，避免双击造成第二次请求与误导性 409；语言切换同步页面标题。
5. `talk/index.ts`：Continue 到达时重新检查 reply entry 是否仍在 active context；off/shutdown/换会话后的旧快照回调直接丢弃。重启 server 的错误路径统一 notify。
6. `shared.tsx`：快速连续跳转先清掉上一个高亮，1.2 秒后清理当前高亮；滚动定位按 animation frame 节流；尊重 reduced-motion；折叠面板的不可见按钮退出 Tab 顺序；索引条最多 24 根（先给首条/当前节保留名额）。

**验证**
- `pnpm test`：60 文件 / 1054 测试全绿；`pnpm typecheck`、`pnpm ui:typecheck` 绿。
- 新增 `talk/index.test.ts` 覆盖：非 idle/空回复拒绝、同回复保留 notes、新回复在原页面显示新块并清空 notes、Continue 使用当前快照、Continue 时 compact 附全文、会话切换关服务。
- Playwright 真实 DOM：未保存正文批注进入 Continue 请求；标题无批注入口；连续跳转只有一个高亮且随后清除；30 标题时横杠不超过 24；右栏滚出后回顶出现。
- `pnpm ui:build` 后产物与暂存内容逐字节一致；`git diff --check` / `git diff --cached --check` 绿。
- 真机 `pi -p --no-extensions -e ./src/index.ts --tools ''` 返回 `OK`。
- `pnpm check:compat`：窗口 1.3.0/1.4.0/1.5.0/1.5.1/1.5.2/1.6.0 全绿，探针 1.2/1.1/1.0/0.99 全绿，floor 仍为 0.99.0。矩阵 1.5.1 为 1053 passed + 1 个既有条件跳过，其余 1054 passed。

**未处理/边界**
- `pnpm ui:check` 的 git-clean 断言按仓库约定要在构建产物提交后运行；本轮未提交、未发布，只验证了产物内容一致。
- 旧的 spec 历史版本若保存了「标题 + 无空行正文」的合并块，历史 `renderHeading` 仍只画首行；新解析已杜绝新数据，旧数据如需修复应单独做迁移/渲染兼容，不在本轮扩大修改。
