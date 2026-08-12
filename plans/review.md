# PLAN: @andares/pi-toolkits — third-review 第三方评审指令

## Context

**为什么做**:开发任务完成后,用户想"召唤另一个模型"以第三方身份对刚完成的代码做检查与修复。需要:

- 识别 `third-review` 指令(聊天关键词 + `/third-review` 斜杠命令,两种都支持)
- 用**配置的评审模型**执行 review,提示词重点强调:`本轮需求实现` / `是否有遗漏` / `是否有错误`
- 评审模型**保留完整工具权限,是"查+修"**——发现问题直接改代码,不是只读检查
- 评审完成后**不切回原模型**(会话保持评审模型,用户手动切换)
- 支持配置一个评审模型(持久化到 agent-dir JSON,沿用 favorites 的 store 模式)
- 未配置模型 / 配置的模型已不可用(如在 pi 内被删掉)→ 提示"review 模型不存在",弹模型选择列表(`ctx.ui.select`)让用户选 → 选完**写回配置并立即执行**

**已确认的决策**:

- Q1 触发形式:**两者都支持**(聊天关键词 `third-review` / `third review` + 斜杠命令 `/third-review`)
- Q2 评审权限:**不限制** —— 提示词明确要求"查+修",评审模型可以改代码
- Q3 模型恢复:**不恢复** —— 评审完成后会话保持在评审模型上

## Approach

### 触发与执行流程

1. **识别**(两条路径,共用同一个 `runReview(pi, ctx)` 核心):
   - 关键词:`pi.on("input", ...)` 拦截,`event.text.trim().toLowerCase()` 精确命中 `third-review` / `third review`(忽略 `source === "extension"` 的注入消息)→ `{ action: "handled" }`,后台执行
   - 命令:`pi.registerCommand("third-review", ...)`(斜杠命令在 input 事件之前被 pi 命令管线处理,天然不冲突)
2. **空闲守卫**:`ctx.isIdle()` 为 false(开发任务仍在跑)→ notify "等当前任务完成后再触发 third-review",不执行
3. **读配置**:`<agent-dir>/pi-toolkits-review.json` → `{ "model": "provider/id" }`
4. **校验可用性**:`ctx.modelRegistry.getAvailable()`(与 `/model` 选择器同源的快照)中查找 `provider/id`;缺失/不可用(如在 pi 内被删)→ `ctx.ui.notify("Review 模型不存在,请选择评审模型")` + `ctx.ui.select("选择评审模型", 可用模型列表)`;用户取消 → 中止;选中 → **写回配置**并继续
5. **执行**:`pi.setModel(reviewModel)`(返回 false = 无 API key → notify 报错中止)→ `pi.sendUserMessage(REVIEW_PROMPT)`(评审回合出现在当前会话记录里)→ notify "third-review 已交给 <模型名> 执行(评审+修复)"
6. **收尾**:无恢复逻辑。评审回合结束后会话保持在评审模型上(notify 提示用户当前模型)

### REVIEW_PROMPT(待用户确认)

```
请以第三方代码评审的身份，对本次会话中刚完成的开发任务进行 Review。

本轮需求、开发过程和代码改动都在当前会话上下文中，请结合上下文，并用 read/grep 等工具实际检查仓库代码，不要凭空猜测。

请重点检查以下三点（逐项给出结论）：
1. 本轮需求实现：本轮需求是否已完整、正确地实现？实现与需求描述是否一致？
2. 是否有遗漏：需求中是否有遗漏的功能点、边界情况、异常处理、兼容性、测试等？
3. 是否有错误：代码中是否存在逻辑错误、潜在 bug、类型/编译错误、安全与性能隐患等？

要求：
- 对确认的问题直接修复（write/edit），并简要说明改了什么、为什么改；
- 无法确认或不宜直接改的问题，列出：位置（文件/行）、问题描述、建议方案；
- 最后输出评审报告：发现问题清单（已修复 / 未修复）、修复说明、总体结论（通过 / 需修改）与剩余风险。
```

### 模块 `src/features/review/`

```
src/features/review/
├── index.ts      # registerReview(pi): runReview 核心 + input 拦截 + /third-review 命令 + /review-model 命令
├── store.ts      # ReviewStore: 配置持久化(agent-dir JSON,原子写,共享实例 + test hook)
├── prompt.ts     # REVIEW_PROMPT + TRIGGER_WORDS 常量
├── constants.ts  # REVIEW_FILE / REVIEW_STATUS_KEY
└── review.test.ts # vitest 单测
```

`src/index.ts` 追加 `registerReview(pi)`;README 增加 third-review 功能条目。

### 关键实现点

- **模型列表展示**:`getAvailable().map(m =>`${m.name} (${m.provider}/${m.id})`)`;选中后按 index 反查 `Model` 对象,`modelKey = provider/id` 与 favorites 一致
- **配置写入即执行**:选中模型 → `store.set(modelKey)` → 继续走 setModel + sendUserMessage,一个流程完成
- **`/review-model` 命令**:notify 当前配置的评审模型;未配置时走同一个 `ui.select` 流程设置(也作为手动预配置入口)
- **状态 key**:footer 可显示 `review` 状态(可选,与 favorites 的 status 模式一致)
- **非 TUI 降级**:`ctx.mode !== "tui"` 时 `ui.select` 不可用 → notify 提示"third-review 需要交互式终端",中止
- 触发词匹配用 `Set` + trim/lowercase,避免误吞 "third-review" 之外的消息

### Reuse

- `getAgentDir()`(pi-coding-agent 导出)+ favorites `store.ts` 的 JSON 持久化/共享实例/test hook 模式
- `ctx.modelRegistry.getAvailable()`(模型列表,与 /model 选择器同源)、`ctx.ui.select()`、`pi.setModel`、`ctx.model`、`pi.sendUserMessage`
- `pi.on("input")` 拦截模式(参考 pi 自带示例 `examples/extensions/input-transform.ts`)
- 斜杠命令注册模式(`registerCommand`,参考 ask/favorites)

### Verification

- `pnpm typecheck && pnpm test`(vitest 单测:触发词匹配、store 读写、模型 key 解析、选择后写回)
- 手工:
  1. 完成一个开发任务 → 输入 `third-review` → 观察切换到评审模型、评审回合输出(含修复)、会话保持在评审模型
  2. `/third-review` 斜杠命令同样触发
  3. 未配置模型时触发 → 弹选择列表 → 选中后配置写入且立即执行
  4. 在 pi 的 models.json 删掉已配置的模型 → 触发 → 提示模型不存在 → 弹列表重选
  5. 开发任务进行中触发 → 提示等待,不执行

---

## 实现记录(已落地)

- `src/features/review/constants.ts` / `store.ts` / `prompt.ts` / `index.ts` / `review.test.ts` 全部创建,`src/index.ts` 接线 `registerReview(pi)`,README 新增 review 章节
- REVIEW_PROMPT 按用户确认的最终文案(查+修、三点重点)落地
- 触发:聊天关键词(`third-review` / `third review`,大小写/空白不敏感,精确匹配)+ `/third-review` 斜杠命令共用 `createReviewRunner`;`running` 标志串行化并发触发
- 模型校验:`ctx.modelRegistry.getAvailable()`(与 `/model` 同源);未配置/不可用 → notify + `ctx.ui.select` 弹列表 → 选中写回 `pi-toolkits-review.json` 并立即执行;`setModel` 返回 false(缺鉴权)→ error 中止
- 空闲守卫:`!ctx.isIdle()` 时提示等待;非 TUI 模式拒绝选择流程
- 不恢复模型;footer 显示灰色 `review`(已配置时);`/review-model` 命令查看/更换配置(始终弹选择列表,标题显示当前配置,取消不改)
- **复查修正**:① `pickReviewModel` 原用 `ctx.mode !== "tui"` 拒绝选择,会误伤 RPC 模式(官方 `hasUI` 在 TUI/RPC 均为 true)——改为 `!ctx.hasUI` 守卫;② `/review-model` 原已配置时仅 notify 且文案误导("可随时更换"实际无法更换)——改为始终弹选择列表支持更换,取消保留旧配置;③ 取消文案从"未配置评审模型"改为"配置未变更"
- 验证:`pnpm typecheck` ✅、`pnpm test` 93/93 ✅(review 26 例)、lens 诊断无问题(knip 的 unused-file 为接线前的过期缓存误报)
