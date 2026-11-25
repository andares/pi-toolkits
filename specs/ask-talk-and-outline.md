# SPEC: `/ask-talk` · 评审页标题索引 · 回到顶部

> 状态：**已实现**（2026-11-25，含第三方复核修复）。实施记录见 `.agents/implementations/2026-11-25_1618_ask-talk-outline-back-to-top.md`。

## 1. Context

对话里最贵的一步是复述：想把"第三段那个判断不对"说清楚，得把原文抄一遍，或者绕三段话指位置。ask-spec 已经证明反过来更省——把 agent 的输出当文档读，在块上写批注，回传的是"引用 + 我的一句话"而不是整篇原文。这条通道现在只对 spec 开放，而真正天天发生的是对话。

评审页本身也越用越长：一份 spec 十几块、一屏放不下，右栏（本版统计 + 批注索引）滚两屏就没了，想回到某个章节只能重新滚。DeepSeek 的对话页给了一个现成答案——右缘一列小横杠，指向就展开成章节列表，点一下跳过去。

同一页现在要长两种用法：spec 评审（版本、diff、批准）与回复批注（快照、note、继续）。索引与回顶必须两种都成立，否则要么只服务一半，要么各写一份必然漂移。

## 2. Goal

`/ask-talk` 把 agent 最近一条正式回复在浏览器里摊开：逐块读、逐块批注、底部输入框写一句话，`Continue` 之后作为一条消息回到对话里——消息只含"被引用的块 + 针对它的 note"和"最后说了什么"，不含原文。

评审页右缘常驻一列暖灰色小横杠，指向向左展开成标题索引，滚轮在浮窗里滚标题，点击跳到对应块。当右栏整体滚出视口后，右下角出现"回到顶部"。

## 3. Scope

**做**：`/ask-talk` 命令及页面模式；取"最后一次正式回复"、分块、索引数据、两段式回传；索引条与浮窗（两种模式通用）；回到顶部按钮；`ui/check` 与测试补齐。

**不做**：不注册任何宿主工具、不进系统提示、不注册相位（零常驻 token）；talk 页没有版本、历史、diff、批准/打回；不做行内/选区批注（与 spec 同一取舍）；不自动刷新已打开的页面；不改 spec 的评审与批准流程；不加新依赖。

## 4. Decisions

### 4.1 `/ask-talk`

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 命令名 `/ask-talk`，不注册 `/talk` 别名 | 单一入口；与 ask-spec / ask-uat 家族一致；`talk` 是通用词，留给将来 |
| D2 | **不是相位**：不改工具集、不动权限、不注册工具、不进系统提示 | 不用它的人零成本；在 ask / ask-spec / ask-uat 期间都能用 |
| D3 | "最后一次正式回复" = 当前回合内最后一条带正文的 assistant 消息的 `text` 块 | thinking 是独立块类型，工具调用同理，天然被排除 |
| D4 | `!ctx.isIdle()` 时拒绝并提示 | assistant 消息在 `message_end` 才落盘，边跑边看会静默显示**上一轮** |
| D5 | 打开的是不可编辑快照；再跑一次 `/ask-talk` = 刷新：正文没变保留 notes，变了清空并提示 | 会话不会因为页面开着而漂移 |
| D6 | 块 = `parseBlocks` 的空行段落；标题行只做分段标记，不是批注单位 | 与 spec 同一块模型，渲染与哈希 id 全部复用 |
| D7 | 每块一条 note，点开可修改，**无** verdict | 对话批注没有"必须改/建议/疑问"三分；回传更短 |
| D8 | 只回 notes + 输入框，**不回原文** | 模型上下文里本来就有那条回复，回贴等于再买一遍 |
| D9 | notes 为空时只发输入框原文；输入框为空时只发 notes | 最省，且不留"没消息"之类的废话行 |
| D10 | 会话切换 / `session_shutdown` 关服务；notes 存服务端内存，刷新页面不丢 | 与 spec 一致：刷新不丢，换会话即失效 |

### 4.2 评审页（两种模式通用）

| # | 决策 | 理由 |
| --- | --- | --- |
| D11 | 一份 bundle，state 里 `mode: "spec" \| "talk"`；共享件搬到 `src/features/review-page/` | 同一套视觉语言、同一份构建产物；talk 若另起一份页面，两种模式的差分会立刻漂移 |
| D12 | talk 顶栏 = `Last reply` + 时间 + 模型 + 块数/note 数；无版本、历史、diff | 快照没有"第几版" |
| D13 | talk 底栏 = note 计数 + 可伸缩输入框 + `Continue`；无 `Global notes`、无打回/许可 | 输入框本身就是"整体意见"通道 |
| D14 | 输入框 1 行起步、最高 `min(40vh, 220px)`、失焦收回 1 行（内容不丢，内部滚动）；Enter 换行，Cmd/Ctrl+Enter 提交 | 不打断多行批注，又不长期占屏 |
| D15 | `Continue` 后进入 sent 态、尝试 `window.close()`、服务端 1.2 s 关端口 | 这个页是 OS 开的标签页，`window.close()` 多半被浏览器拦；端口关掉才能保证"没有第二次提交" |
| D16 | 索引条锚在**内容区右缘**（页面右侧留白里）；≤1040px 单栏时整组隐藏 | 宽屏也不会离内容跑远；单栏没有右留白，浮窗会压正文 |
| D17 | 索引列出当前视图版本的全部标题；点击目标被「只看改动」隐藏时先展开再滚 | 沿用现有 `jumpToNote` 的做法，索引永远可点 |
| D18 | 浮窗复用底栏面板语言（surface / 1px border / soft shadow / blur）；展开 180ms 由右向左；滚轮只滚列表；列表上下 12px fade | 用户原话：参考统一底端面板的浮窗样式 |
| D19 | 折叠态最多 24 根横杠，超出等距抽样并保留首条与当前节；横杠用暖玫瑰灰 `#D3B3AC`，当前节用品牌色 | 精度不重要；中性灰在暖纸底上发脏 |
| D20 | 回到顶部：右栏**整体**滚出视口才出现；位于右栏右缘、footer 之上；≤1040px 改为 `scrollY > 0.8 × 视口高` | 崔总 2026-11-25 定，严格按原话；单栏没有右栏，用滚动阈值替代 |

## 5. Approach

### 5.1 取「最后一次正式回复」

从 `ctx.sessionManager.getBranch()` 末尾往前扫，跳过非 `message` 条目；遇到 `role === "assistant"` 就取它 `content` 里 `type === "text"` 的块。

只看**当前回合**：扫到 `role === "user"` 或 `custom_message` 就停。这样"我先说一段、再调工具、再说一段"只取最后一段，不会把中间的过程话当正式回复。

一条正文都没有（纯工具调用、被 abort）时报"没有可批注的回复"，不开页面。空会话同理。

### 5.2 分块与索引

正文交给 `parseBlocks`：标题行独立成块（**不要求前后有空行**），其余按空行分段、围栏代码块整块，id 仍是内容哈希。标题额外抽成索引条目 `{blockId, level, text}`，`text` 去掉 `#` 标记与行内强调符（显示用）。

索引只认 ATX 标题（`## Foo`）。setext 标题（下划线式）和围栏内的 `#` 都不产生条目——与 `parseBlocks` 的现有判定一致，也是"精度不重要"换来的简化。

标题与其后的正文即使相邻也分成两块；标题进入索引但不开放批注，正文单独批注。围栏内的 `#` 行仍只属于代码。

### 5.3 回传消息

`Continue` 把两段拼成一条 `pi.sendUserMessage`。模板是固定的，逐字节可测：

```markdown
## Notes on your last reply

Address every note below; each one is attached to the part of your reply it quotes.

### Approach > M2 · the review page
> The state payload gains a headings array: block id, level and text. The page
> never parses rendered HTML for structure…

- 这一段顺序反了：先给 headings，再说块渲染。

## Operator's message

<输入框原文>
```

标题行是**章节路径**（近的标题在前、逐级用 ` > ` 连接），没有标题时写 `Reply`。引用是块的原文，超过 600 字符按行截断并补 `…`；截断点落在围栏里就把围栏补闭合，避免半截代码块。

notes 按文档顺序排，不按书写顺序。没有 notes 就只发输入框原文（不套壳）；没有输入框文字就只发 notes，并在首句保留"处理每条 note"的指令。

一条例外：如果这条回复已经不在 `buildContextEntries()` 里（中间做过 compact），正文一次性全文附在消息末尾——否则模型不知道引用的是哪一段。

### 5.4 页面：一份 bundle，两种模式

`ui/src/App.tsx` 按 `mode()` 分支，只有五处：顶栏元信息、右栏第一张卡（spec 有 diff 统计，talk 没有）、底栏（决策按钮 vs 输入框）、块头部（状态徽章 vs 空）、note 编辑器（verdict 三选 vs 纯文本）。块渲染、批注卡、note 索引、索引条、回顶按钮全部共用。

服务端两套路由、一套 HTTP 壳：`startWebServer`（token / Host / Origin / 端口池 / SSE / 静态文件）与 `openInBrowser` 直接复用。talk 端口从 3501 起走，和 spec / uat 的 3401 池错开，URL 一眼能分。

### 5.5 索引条

折叠态是一列 16px 宽、2px 高、6px 间隔的横杠，右对齐，宽度按层级递减（h1 最长、h4 之后统一最短）。透明度从中间向两端递减，叠一层 14px 的 CSS mask，顶端和底端自然淡出——这就是"最顶上和下面的灰杠要有 fade out"。

指向整条区域即展开：浮窗从右向左展开 292px，压在右栏上（不挤动布局）。展开期间保留索引条 4px 的贴边位置，收起时用 200ms 延迟，避免鼠标从横杠移进浮窗时闪断。

当前节由滚动位置算：取最后一个"块顶 ≤ 视口顶部 + 140px"的标题，对应浮窗行用品牌色 + 左侧 2px 竖条；其余行 hover 时文字变浅并浮出一层淡粉底。

点击：先 `scrollIntoView`（`scroll-margin-top: 96px`），目标块做 1.2s 的描边闪一下，表明落在了哪里。

### 5.6 回到顶部

`IntersectionObserver` 盯 `.rail`：`!isIntersecting && rect.bottom <= 0` 才显示，即右栏整体越过视口顶部。点击 `scrollTo({top: 0})`，`prefers-reduced-motion` 时直接跳。

按钮贴在右栏右缘、`bottom: calc(var(--footer-h) + 24px)`；`--footer-h` 由 `.footer` 上的 `ResizeObserver` 写回 `:root`——talk 页输入框会长高，写死 96px 会被顶穿。

## 6. Data & contracts

### 6.1 state 载荷

```ts
type Heading = { blockId: string; level: number; text: string };

type PageBlock = { id: string; html: string; label: string };

type SpecState = { mode: "spec"; headings: Heading[]; /* 现有字段不变 */ };
type TalkState = {
  mode: "talk";
  reply: { model: string; at: string; chars: number };
  blocks: PageBlock[];
  headings: Heading[];
  notes: Record<string, string>;   // blockId → note，一票一注
  draft: string;                   // 输入框，刷新不丢
  sent: boolean;
};
```

`headings` 与 `blocks` 同源于服务端，页面不解析 HTML 取结构。

### 6.2 talk 路由

| 路由 | 语义 |
| --- | --- |
| `GET /api/state` | 当前快照 + notes + draft + sent |
| `POST /api/notes` `{notes, draft}` | 全量覆盖（页面 300ms 防抖），`sent` 后一律 409 |
| `POST /api/continue` `{notes, message}` | 定稿回传；成功后 `sent = true`、广播、1.2 s 关端口 |

`sent` 之后所有写路由 409，页面切 sent 态——一条快照只允许提交一次，重开必须 `/ask-talk`。

## 7. Files

| 文件 | 职责 |
| --- | --- |
| `src/features/review-page/blocks.ts` · `render.ts` · `assets/` | 从 `spec/` 迁入的共享层（块模型、markdown 子集渲染、构建产物） |
| `src/features/review-page/headings.ts` | `extractHeadings(blocks)`：ATX 标题抽取与显示文本清洗 |
| `src/features/talk/reply.ts` | 取最后一条正式回复（回合边界、thinking/tool 排除） |
| `src/features/talk/sections.ts` | 块 → 章节路径（breadcrumb），供消息与索引共用 |
| `src/features/talk/message.ts` | 两段式消息拼装（裁剪、补围栏、空段省略、compact 兜底） |
| `src/features/talk/server.ts` | talk 路由与载荷，复用 `lib/web-review.ts` |
| `src/features/talk/index.ts` | `/ask-talk` 命令、快照刷新、会话生命周期、continue → `sendUserMessage` |
| `ui/src/App.tsx` | `mode` 分支（五处）、talk 顶栏与右栏 |
| `ui/src/outline.tsx` · `back-to-top.tsx` · `composer.tsx` | 索引条与浮窗、回顶按钮、可伸缩输入框 |
| `ui/src/styles.css` · `i18n.ts` · `api.ts` | 浮窗/横杠/输入框样式、新文案、类型 |
| `src/index.ts` | `registerTalk(pi)` |
| `package.json` | `ui:check` 的产物路径改为 `src/features/review-page/assets` |

## 8. Milestones

**M0 — 共享层搬家（纯机械）**：`spec/{blocks,render}.ts`、`spec/assets/` 迁到 `review-page/`，更新全部 import 与构建路径。验收 = `pnpm typecheck`、`pnpm test` 与迁移前逐条一致，`pnpm ui:build` 产物可被 `startSpecServer` 正常服务。

**M1 — talk 后端**：`reply.ts` / `sections.ts` / `message.ts` / `server.ts` / `index.ts`。验收 = 单测覆盖"只有最后一段""thinking 被排除""跨回合不取""空回复拒绝""裁剪 600 补围栏""无 notes / 无输入框两种省略""compact 后全文兜底"；真机 `/ask-talk` 打开页面，`curl` 打 `/api/state` 有正确块与索引。

**M2 — talk 页面**：模式分支、talk 顶栏/右栏/底栏、输入框、note 编辑、sent 态。验收 = 真机批注两块 + 写一句话 → Continue → 会话里出现模板消息（逐字节比对）；刷新页面 notes 与草稿还在；再次提交 409。

**M3 — 索引与回顶**：`extractHeadings` 接入两种 mode、`outline.tsx`、`back-to-top.tsx`、`--footer-h` 接线。验收 = 1440 / 1200 / 1024 三档宽度下，spec 与 talk 各走一遍：悬停展开、滚轮只滚列表、点击跳转并高亮、当前节跟随、右栏滚出后回顶出现且不被输入框顶穿。

## 9. Verification

单测：`reply.ts`（回合边界、thinking/tool、空回复）、`sections.ts`（无标题、嵌套标题、标题块带正文）、`message.ts`（模板逐字节、裁剪、围栏闭合、两种省略、compact 兜底）、`headings.ts`（ATX、围栏内 `#` 不算、行内强调符清洗）、`talk/server.ts`（state / notes / continue / sent 后 409）。

页面没有测试运行器，靠 `pnpm ui:typecheck` + `pnpm ui:check`（重建产物必须与提交的一致）+ 真机目检三档宽度。索引的滚动定位与回顶触发在真机上调一次阈值，把最终数值写进注释。

命令：`pnpm typecheck`、`pnpm test`、`pnpm ui:typecheck`、`pnpm ui:check`、`pnpm check:compat`（新代码只碰 `getBranch`、`sendUserMessage`、`isIdle`、`ctx.mode`，按纪律跑一轮，预期 floor 不变）。

## 10. Risks

1. **`window.close()` 不能被脚本关掉**：页面是 OS 打开的标签页，浏览器会拒绝关闭。兜底是 sent 态 + 服务端关端口，用户手关标签页；这一点写进 sent 文案，不能假装窗口会自己消失。
2. **一份 bundle 两种模式的腐蚀**：`mode` 分支一旦漏进块渲染，spec 页就会为 talk 付出维护成本。约束是分支只允许出现在 5.1 列的五处，块与批注永远不看 `mode`。
3. **索引精度**：setext 标题、标题块里被并进来的正文、超长标题都会被"看得清就行"放过；真正的代价是锚点只能到块，不到行。
4. **回顶的严格规则**：右栏很长时按钮出现得很晚，短右栏时又出现得很早。这是 D20 的直接后果，改起来只需换一个阈值常量。
5. **引用不等于原文**：600 字符的裁剪让模型只能靠上下文回忆其余部分；中间做过 compact 的极端情况靠全文兜底，但那一条会明显变贵。

## 11. Open questions

暂无。

## 12. 设计稿

`design/review-outline.ptr`：board 1 = 折叠态整页（横杠 + 回顶按钮），board 2 = 展开态细节（缩进、当前节、hover、底部 fade）。实施时以此为准，实现差异回头补到设计稿里。
