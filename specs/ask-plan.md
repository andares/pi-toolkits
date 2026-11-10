# SPEC（草案）: `/ask-plan` — 从 ask 讨论出计划，在浏览器里按「块」批注，确认后落成 spec

> 状态：调研 + 提案，待崔总拍板。
> 调研对象：本机 `~/.pi/agent/npm/node_modules/@plannotator/pi-extension@0.28.59`
> （pi 里已 disable），以及同目录 `@plannotator/webtui@0.1.0`。

## 1. plannotator 实测画像

| 维度 | 实测值 |
| --- | --- |
| 代码量 | TypeScript ≈ **93k 行**（根 7.9k / `generated/` 66.9k / `server/` 19k），另 7.5k 行测试 |
| 前端 | 预构建单文件 HTML：`plannotator.html` **24 MB**、`review-editor.html` **17.8 MB** |
| 依赖 | `@pierre/diffs`、`diff`、`chokidar`、`turndown`+`parse5`（md→html）、`@plannotator/webtui`（xterm + node-pty + ws） |
| 命令面 | `/plannotator-plan-mode`、`-review`、`-annotate`、`-last`、`-inbox`；可选 `plannotator` / `plannotator_inbox` 工具 |
| 玩法面 | 计划评审 + 代码/PR 评审 + 任意 md 批注 + **live-app 反代批注** + 消息批注 + Inbox + 归档浏览 + Ask-AI 面板 + 浏览器内终端 |
| 传输 | `node:http` + **SSE** 推送；端口 19432（remote）/ 本机随机 |

### 1.1 值得抄的五件事

1. **提交工具不阻塞**（README 与 `generated/plannotator-tool.ts` 均明说 "returns at once"）：
   `plannotator_submit_plan` 打开评审就返回，agent 的回合**当场结束**；用户的决定稍后作为
   **新消息**回到会话。代价是工具不再能"等待结果"，收益是评审期间两边都能继续说话。
2. **决定回投走 `pi.sendUserMessage`**（普通用户消息），不是工具返回值。浏览器 POST
   `/api/approve` / `/api/deny` → 服务器 resolve 一个 awaited promise → 扩展拼一条消息。
   **格式化的活在前端做**（`feedback` 是一整段 markdown），服务端只搬运。
3. **版本历史按「文件路径」记，不按内容**：slug = 文件名 + 路径哈希，内容哈希去重，
   每次打开把当前内容与上一版一起发下去（`diffCurrent` / `previousPlan`），前端算 diff。
   写历史失败只降级、不报错（"storage is an enhancement, never a gate"）。
4. **安全姿态**（`server/request-origin-guard.ts` + `request-host-guard.ts`）：绑回环、
   Host 白名单、跨站发起的写请求一律 403（防 DNS rebinding / 恶意网页 CSRF）、端口可配。
5. **阶段约束靠「指令 + 工具裁剪」**（`plannotator.json` 的 `phases`）：计划期把 activeTools
   收窄到 `grep/find/ls/submit`，并写死一段指令（不许改代码、每轮只能"提问"或"提交"）。

### 1.2 两处我们可以做得更好

- **锚定方式**：他们的批注是**引用文本锚**（`originalText` + `anchor` + `additionalAnchors`），
  改版后要重新锚定——`generated/annotate-draft.ts` 里有 "an annotate client re-anchors" 的补丁
  逻辑。我们改成**块身份**（block id），批注直接挂在块上，改版后按块 diff 定位，不需要重新猜位置。
- **粒度**：他们的 round-over-round diff 是文本级（`diff` 包在前端跑，24MB 的 UI 里渲染）。
  我们只做块级：不细到字/行，改动在块上标「新增 / 修改 / 删除」。

### 1.3 明确不抄（简化项与理由）

| 不抄 | 理由 |
| --- | --- |
| live-app 反向代理批注（`bridge-script.ts` 1000+ 行） | 我们要批注的是计划文本，不是运行中的网页 |
| 代码/PR 评审（`review-editor.html` 17.8 MB） | 本轮目标是 `/ask-plan`；`/ask-review` 已经覆盖代码评审 |
| Inbox / 归档浏览 / Ask-AI 面板 | 各自是独立产品面，与"计划评审"无关 |
| 浏览器内终端（node-pty + xterm） | 我们要的是批注，不是第二个终端 |
| Mermaid / Graphviz / Obsidian / reference | 计划文本用不着；`parse5`+`turndown` 只是为了 md↔html 互转 |
| 多标签租约、remote TLS、VS Code 集成 | 单机会话用不上 |
| 预构建大 HTML 包 | 我们直接手写一个单文件 HTML + 原生 JS，无构建链 |

## 2. 我们要的工作流

```text
/ask 讨论  ──▶  /ask-plan 进入计划期  ──▶  计划 v1 落盘(草稿)
                    ▲                         │
                    │                         ▼
              模型改计划 ◀── 浏览器批注/答题 ◀── 服务器 + 界面（SSE）
                    │                         │
                    └── 新一轮 v2/v3 … ──────▶│  块级 diff 高亮
                                              ▼
                                    Approve ──▶ 写 specs/<slug>.md ──▶ 实施
```

- **进入方式**：`/ask-plan`（可在 `/ask` 讨论后直接进，也可直接进；带上刚讨论的内容作为上下文）。
- **计划期约束**：只允许写计划文件（+ 只读工具），复用现有 permission/ask 的闸门能力。
- **提问**：计划里的「待你回答」是块的一种（`question` 类型），浏览器里渲染成问题卡
  （单选 / 多选 / 自由文本），答案随提交一起回到会话。
- **多轮**：每次模型提交新版本，浏览器收到 SSE 刷新；未变的块折叠，变了的块打徽标。

## 3. 块模型（本轮的核心创新）

```text
parse(markdown) → blocks[] {
  id     短哈希(path + 归一化文本)  ← 稳定的块身份
  kind   heading | para | list-item | code | table | quote | question
  path   标题链（如 "Approach > 2. 步骤"），给人看的定位
  text   原始 markdown 片段
  hash   归一化文本的哈希（用于判"改没改"）
}
```

版本比较（`diffBlocks(prev, next)`）：

| 情形 | 判定 |
| --- | --- |
| 同一 `id` 两版都在 | 未变（可折叠） |
| `path` 相同、`hash` 不同 | **修改**（徽标「已改」） |
| 只在下一版出现 | **新增**（徽标「新增」） |
| 只在上一版出现 | **删除**（徽标「删除」，展示为删除线卡片） |

批注 = `{ blockId, verdict: change | suggest | question, comment }`。反馈模板按块输出：

```text
### ## Approach > 2. 步骤  （已改）
> 原第 2 条：先写 store 再写 UI
批注（必须改）：顺序反了，先定 UI 结构再定 store 字段。
```

## 4. 架构（提案）

```text
src/features/plan/
├── index.ts     # /ask-plan 命令、计划期状态机、submit 工具、会话接线
├── blocks.ts    # markdown → blocks（解析 + 归一化 + 哈希）
├── diff.ts      # 块级 diff（LCS on id，产出 added/modified/removed/unchanged）
├── store.ts     # <agent-dir>/ask-plan/<slug>/{v001.md,state.json}（原子写）
├── server.ts    # node:http @ 127.0.0.1:随机端口 + SSE + Host/Origin 守卫
├── feedback.ts  # 批注/答题 → 喂给模型的消息（模板固定，可测）
├── prompt.ts    # 计划期指令（照 plannotator.json 的思路写死）
└── assets/plan.html  # 单文件界面：无构建、原生 JS、fetch + EventSource
```

HTTP 面（最小集）：`GET /`（界面）、`GET /api/state`（当前版本 + 块 + 批注 + 历史）、
`GET /api/events`（SSE）、`POST /api/annotate`（增删批注）、`POST /api/answers`（答题）、
`POST /api/decide`（approve / deny）。

不引入构建链、不引入前端框架；`node:http` + 手写 HTML 与 `SSE`，与 plannotator 的安全姿态一致
（回环绑定 + Host 白名单 + 跨站写 403）。

## 5. 待崔总拍板（5 个问题）

1. **答题在哪**：浏览器里答（问题块）还是终端对话框？——建议浏览器，能批量答完再提交。
2. **每版是否落盘**：`v001.md`…（历史可回看）还是只留最新版 + 一份 diff 日志？——建议落盘，成本极低。
3. **spec 落地**：`specs/<slug>.md`（本仓已有 `specs/`）？外部项目是否可配置（`plans/` 之类）？
4. **approve 之后**：直接开始实施，还是先落 spec、看一眼 diff 再开工？
5. **界面语言**：英文（与现有运行时文案一致）还是中英双语？——建议英文。

## 6. 规模与风险

- 预计实现量：块模型 + diff ≈ 300 行，服务器 + 反馈模板 ≈ 300 行，界面（HTML/JS）≈ 400–600 行，
  测试 ≈ 400 行；合计 **1.2–1.6k 行**，是 plannotator 的 1.5% 左右。
- 主要风险：① 块的边界（一个长列表算一块还是每项一块）——先按「标题 + 原子块」定；
  ② 版本漂移下批注失效——有 block id 兜底，块被删就明确告诉用户"批注所在块已删除"；
  ③ 服务器常驻泄漏——只在评审打开期间活着，`session_shutdown` 关掉，退出时清理端口文件。
