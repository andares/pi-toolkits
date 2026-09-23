# PLAN: @andares/pi-toolkits — compact-model 独立压缩模型

## Context

**为什么做**:pi 的 `/compact` 与 auto-compact 默认**用当前会话模型**做上下文总结。主模型往往贵且慢，而压缩总结是典型的"便宜快模型就能干好"的任务。给 pi-toolkits 增加"compact 专用模型"能力:配置一个独立模型接管所有压缩总结，主模型专注对话。

**需求拆解**:

1. 三种压缩触发全部走独立模型:手动 `/compact [instructions]`、auto-compact 阈值触发、context overflow 恢复
2. 模型**可配置**:持久化到 agent-dir JSON + `/compact-model` 命令查看/更换/清除
3. **无损回落**:未配置、模型不可用、总结失败/为空时，回落 pi 默认压缩行为(用当前会话模型)，功能零侵入
4. 保持 pi 默认的切分行为(保留最近 `keepRecentTokens`)与**默认摘要格式**(Goal/Progress/... 结构化 checkpoint)，只换执行模型

**调研结论(pi 0.84.0 与 0.87.1 源码级确认)**:

- ❌ **pi 原生 settings 不支持**:`compaction.modelOverrides` 只是"当会话模型为 X 时调整 token 预算"，不是指定总结模型;`_runDefaultCompaction` 的 `requestModel` 恒为当前会话模型
- ✅ **`session_before_compact` 扩展事件**是官方接管点(0.84.0 已存在,`SessionBeforeCompactEvent` 从主包导出):
  - 三种触发(`reason: "manual" | "threshold" | "overflow"`)都会**先**经过扩展 handler
  - 返回 `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }` → 完全接管本次压缩;返回 `undefined` → 回落 pi 默认压缩;`{ cancel: true }` → 取消
  - 扩展产出的压缩条目 `fromHook: true` → pi **不会自动 carry** 其中的文件清单，`details` 格式由扩展自管
  - `event.signal`(AbortSignal)支持用户取消压缩，必须传给底层 LLM 调用
- ✅ `preparation` 字段(0.84.0 types 已确认):`messagesToSummarize` / `turnPrefixMessages` / `previousSummary?` / `fileOps: { read, written, edited }`(三个 Set) / `tokensBefore` / `firstKeptEntryId` / `settings: { enabled, reserveTokens, keepRecentTokens }`(已解析 `modelOverrides` 的最终生效值)
- ✅ `event.customInstructions?`:用户 `/compact 注意保留XX` 传入的自定义 focus，接管时应注入 prompt
- ✅ `serializeConversation` / `convertToLlm` 从 `@earendil-works/pi-coding-agent` 导出(0.84 已有):把 AgentMessage[] 序列化为 `[User]: ...` / `[Tool result]: ...` 纯文本，防止模型把它当对话续写
- ✅ `ctx.modelRegistry.complete(model, context, options)`:直接用任意已配置模型发一次性请求;options 传 `maxTokens` / `signal` / `cacheRetention: "none"`
- ✅ 官方完整参考示例:pi 0.87.1 安装目录 `examples/extensions/custom-compaction.ts`(用 Gemini Flash 做总结)
- ✅ pi 内建压缩 prompt 原文已提取(0.87.1 `dist/core/compaction/compaction.js`),见下文 Prompt 节，接管版**原样沿用**以保证摘要格式一致

## Approach

### 0. 升级 pi 兼容版本(实现本功能前先做)

- **动机**:开发与验证以 0.87.x 的 hook 行为为基准(官方 custom-compaction 示例随 0.87 提供;overflow recovery / `willRetry` 等行为在 0.85→0.87 持续演进);0.84 理论可用但不再承诺
- 操作(pnpm,cwd = 仓库根):
  ```bash
  pnpm add -D @earendil-works/pi-coding-agent@latest @earendil-works/pi-ai@latest
  pnpm add @earendil-works/pi-tui@latest   # runtime dep(favorites 用),与主包同版本线
  ```
  以 pi-coding-agent 当前 latest(≥ 0.87.1)为准;`@earendil-works/pi-tui` 是 runtime 依赖,沿用 favorites 的"与 pi-coding-agent 同版本保证运行时同一实例"原则
- `package.json`:
  - `peerDependencies` 保持 `"@earendil-works/pi-coding-agent": "*"` 不动
  - devDependencies / dependencies 按上面升级结果落盘
- **README 徽章**:`pi >= 0.84.0` → `pi >= 0.87.0`,正文 Requirements 同步
- 升级后先跑全量 `pnpm typecheck && pnpm test` 回归,确认 favorites 的两处 prototype patch(`ModelSelectorComponent` / `AgentSession.cycleModel`)在 0.87 下目标仍命中(有版本守卫,失败只降级，但要确认没降级)
- 顺手检查 `pnpm-workspace.yaml` 无版本相关硬编码

### 1. 模块 `src/features/compact/`

```text
src/features/compact/
├── index.ts           # registerCompact(pi): session_before_compact 接管 + /compact-model 命令
├── store.ts           # CompactStore: { model: "provider/id" } 持久化(agent-dir JSON,原子写,共享实例 + test hook)
├── prompt.ts          # SUMMARIZATION_PROMPT / UPDATE_SUMMARIZATION_INSTRUCTIONS(内建原文) + 组装函数
├── constants.ts       # COMPACT_FILE = "pi-toolkits-compact.json" / 状态 key
└── compact.test.ts    # vitest 单测
```

`src/index.ts` 追加 `registerCompact(pi)`;README 增加 compact-model 功能条目。

配置文件形态(与 review 完全同构,`<agent-dir>/pi-toolkits-compact.json`):

```json
{ "model": "google/gemini-2.5-flash" }
```

未配置 = 未启用 = 全部走 pi 默认,零开销。

### 2. 核心流程:`session_before_compact` handler

```text
读配置 CompactStore.getModel()
  └ 无 → return undefined(pi 默认压缩)
解析模型 resolveConfiguredModel(ctx, key)   ← 从 review/index.ts 导入复用
  └ 不可用(如在 pi models.json 被删) → notify warning + return undefined(回落)
serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]))
组装 prompt(见下节,含 previousSummary 迭代 + customInstructions 注入)
ctx.modelRegistry.complete(compactModel, { messages }, {
    maxTokens: preparation.settings.reserveTokens,   // 已解析 modelOverrides,对齐内建输出上限
    signal,                                          // 必须:支持 Esc 取消
    cacheRetention: "none",                          // 对齐内建:一次性总结不写 prompt cache
    sessionId: uuidv7(),                             // @earendil-works/pi-ai 导入
})
  ├ 成功 → 提取 text,拼 <read-files>/<modified-files> 尾部
  │    └ return { compaction: { summary, firstKeptEntryId, tokensBefore,
  │                             usage: response.usage,                 // 计入 session 用量
  │                             details: { readFiles, modifiedFiles } } }
  ├ 空摘要(且未 abort)→ notify warning + return undefined(回落)
  └ 异常 → notify error + return undefined(回落)
```

**不改** `firstKeptEntryId` / `tokensBefore`:保持 pi 默认"保留最近 `keepRecentTokens`"的切分，只换总结模型。

**details 文件清单计算**(与内建 `CompactionDetails` 同形状;`fromHook: true` 后 pi 不自动 carry，扩展自己维护):

```ts
const modified = new Set([...fileOps.written, ...fileOps.edited]);
const readFiles = [...fileOps.read].filter((f) => !modified.has(f));
const modifiedFiles = [...modified];
```

### 3. Prompt(pi 0.87.1 内建原文，原样搬进 prompt.ts)

`SUMMARIZATION_PROMPT`(首连总结):

```text
The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

`UPDATE_SUMMARIZATION_INSTRUCTIONS`(存在 `previousSummary` 时改用，迭代更新):

```text
Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

**消息组装**(单条 user message,`<conversation>` 包裹序列化文本，迭代时附 `<previous-summary>`;`customInstructions` 存在时追加 focus 段):

```text
<conversation>
{serializeConversation(...)}
</conversation>

<previous-summary>          ← 仅 previousSummary 存在时
{previousSummary}
</previous-summary>

[SUMMARIZATION_PROMPT 或 UPDATE_SUMMARIZATION_INSTRUCTIONS]

Additional instructions for this summary:   ← 仅 customInstructions 存在时
{customInstructions}
```

### 4. `/compact-model` 命令

- 已配置 → 标题带当前值的选择列表(`ctx.ui.select`,与 review 的 `pickReviewModel` 同模式)
- 列表选项 = 可用模型(`${m.name} (${m.provider}/${m.id})`)+ 首项 **「✕ 清除配置(用 pi 默认压缩)」**
- 选中模型 → 写回 store;选清除 → 删配置;取消 → 不变,均 notify 结果
- `!ctx.hasUI`(json/print/headless)→ notify 提示手动编辑 `<agent-dir>/pi-toolkits-compact.json`(照 review 的降级)
- **auto-compact 路径绝不弹任何 UI**:handler 内只允许 notify

### 5. 关键实现点 / 坑

- **回落优先**:任何异常路径都 `return undefined` 让 pi 默认压缩兜底,扩展永不把压缩"做挂"
- **`signal` 必须透传**给 `complete`(用户 Esc 取消;abort 后不要 notify "失败")
- **`cacheRetention: "none"`**:对齐内建,一次性总结 prompt 不写 prompt cache
- **`maxTokens` 用 `preparation.settings.reserveTokens`**:这是解析过 `modelOverrides` 的生效值，内建就是拿它当总结输出上限的
- **`usage` 回传**:不然压缩的 token 消耗不计入 session 统计
- `/tree` 分支总结(`session_before_tree`)是另一个事件,**本期不做**，留作后续迭代(需要时同模式接管)
- footer 状态 key `compact`(已配置时灰色显示)，照 review 模式，可选
- `resolveConfiguredModel` / `modelKey` 直接从 `../review/index.js` 导入;若愿意可顺手抽到 `src/lib/model-config.ts` 供两处共用(favorites 的 key 逻辑同构，不强求)

### Reuse

- `getAgentDir()` + review `store.ts` 的 JSON 持久化模式(原子写 tmp+rename、损坏降级 console.warn、共享单例 + test hook)
- `resolveConfiguredModel` / `modelKey`(review/index.ts 已导出)
- `serializeConversation` / `convertToLlm`(`@earendil-works/pi-coding-agent`)
- `ctx.modelRegistry.getAvailable()` / `ctx.modelRegistry.complete()` / `ctx.ui.select()` / `ctx.ui.notify()`
- `uuidv7`(`@earendil-works/pi-ai`,devDep 已有)
- 斜杠命令注册模式(`registerCommand`,照 ask/review)

### Verification

- `pnpm typecheck && pnpm test`(vitest:store 读写/损坏降级、resolve 回落、details 文件清单计算、prompt 组装——previousSummary 切换 UPDATE 版、customInstructions 注入、空摘要回落)
- 手工:
  1. `/compact-model` 选一个便宜模型 → 触发 auto-compact(灌长上下文)→ 确认压缩条目由该模型产出、格式仍为 Goal/Progress 结构、`usage` 计入统计
  2. `/compact 保留XX细节` → 确认 customInstructions 进了总结
  3. 清除配置 → 压缩回落 pi 默认(当前会话模型)
  4. 配置后在 pi models.json 删掉该模型 → 压缩时 warning + 回落默认，不阻塞
  5. 压缩进行中按 Esc → 干净取消，无错误通知刷屏
  6. 反复多次压缩(迭代 `previousSummary`)→ 摘要延续不丢信息
