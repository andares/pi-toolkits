# SPEC: `/ask-plan` — 浏览器批注式计划评审（简化版 plannotator）

> 状态：**已定稿待实施**（崔总 2026-11-11 拍板）。实施后本文件随代码一起维护。
> 调研底稿见同目录 git 历史（`85112d7` 的调研版）。

## 0. 目标

`/ask` 讨论 → `/ask-plan` 调研 → 模型把结论写成计划 → **浏览器里按块批注** → 多轮 → 批准 →
落 `specs/<slug>.md` → 直接实施。

一句话：把 plannotator 的「计划评审」那一小块拿出来，用**块**替代它的**文本引用锚**，
其余全部砍掉。

## 1. 范围

**做**：计划期状态机、`plan_submit` 工具、块解析与块级 diff、本地 HTTP 服务 + SolidStart 界面、
两级批注（全局 / 块）、版本落盘与回看、批准后写 spec、ask-perm 自动开启。

**不做**（明确边界）：

- **绝不切模型。** 本功能任何代码路径都不得调用 `pi.setModel`；plannotator 的自动切模型
  在 2026-09 把崔总的现金额度烧掉 100 多元，这类错误不再犯。（守卫见 §9.4）
- 不做 live-app 反代批注、代码/PR 评审、Inbox、Ask-AI、浏览器终端、Mermaid/Graphviz、
  Obsidian/reference、多标签租约、remote TLS、VS Code 集成。
- 不做字符级/行级 diff：diff 的粒度就是块。
- 不做「计划期允许写仓库文件」：计划期唯一的写入通道是 `plan_submit`。

## 2. 已确认的决策（崔总）

| # | 决策 | 说明 |
| --- | --- | --- |
| D1 | 调研期允许用 `ask_user_question` 提问 | 问完再提交计划；提问走 pi 现有对话框，不在浏览器里答 |
| D2 | 界面用 **SolidStart** 搭 | 用 SPA 模式（`ssr: false`），产物是静态资源 |
| D3 | **块 = markdown 的一段**（空行分隔） | 不解析 AST；围栏代码块内不切分 |
| D4 | 批注只有两级：**全局 + 块** | 不做文本选区锚、不做行内批注 |
| D5 | 历史落盘 | `<agent-dir>/ask-plan/<slug>/vNNN.md` + `state.json` |
| D6 | spec 位置固定为 `specs/<slug>.md` | 沿用 ask-init 框架 |
| D7 | 批准后**直接开工** | 不再二次确认 |
| D8 | 界面中英双语可切换，记忆在 `localStorage` | 默认跟 `navigator.language` |
| D9 | 闸门复用现有 permission | 进入计划期自动 `/ask-perm` 默认参数，用户可手动关 |
| D10 | 服务器要能唤起 **Windows 浏览器** | WSL 内 chrome 不算数（见 §3） |

## 3. WSL 打开 Windows 浏览器：已实测，方案确定

本机实测（2026-11-11，WSL2 NAT 模式，`/mnt/c/Users/*/.wslconfig` 无 `localhostForwarding`）：

| 场景 | 结果 |
| --- | --- |
| 服务绑 `127.0.0.1:8123`，Windows 访问 `localhost:8123` | ❌ 连不上 |
| 服务绑 `127.0.0.1:8123`，Windows 访问 `127.0.0.1:8123` | ❌ 连不上 |
| 服务绑 `0.0.0.0:8124`，Windows 访问 `localhost:8124` | ❌ 连不上 |
| 服务绑 `0.0.0.0:8124`，Windows 访问 `172.24.47.146:8124`（WSL eth0 IP） | ✅ 200 |
| `cmd.exe /c start "" "http://172.24.47.146:8125/"` | ✅ Windows 浏览器真的打进来了（服务器日志有 `GET /`） |

同时确认了旧坑：本机 **`/usr/bin/google-chrome` 存在**，`xdg-open` 会把它拉起来——正是
「WSL 内的 chrome」那种失败。

**结论（必须照做）**：

1. **绑 `0.0.0.0`**（WSL 下），URL 用 **WSL 的 eth0 IP**，不用 `localhost`。
2. **打开器按序探测**：`wslview`（wslu，本机未装）→ `cmd.exe /c start "" "<url>"` →
   `powershell.exe -NoProfile -Command Start-Process '<url>'` →（非 WSL）`xdg-open`。
   WSL 下**绝不先试 `xdg-open`**。
3. `cmd.exe` 的 cwd 要设成 `/mnt/c`（或任意 Windows 路径），否则它把 UNC 路径
   `\\wsl.localhost\...` 当 cwd 并打印警告（实测出现过，URL 仍能打开但要消掉噪声）。
4. 非 WSL：绑 `127.0.0.1`，URL 用 `127.0.0.1`，`xdg-open`/`open` 均可。
5. 永远把 URL 打出来（TUI notify + 工具返回值），打开失败也能手动复制。
6. 每次提交**不重复弹新标签**：第一次打开发 URL，之后靠 SSE 刷新；需要重开时
   `plan_submit` 的返回值和 `/ask-plan open` 都给 URL。

## 4. 用户旅程

```text
/ask 讨论 ──▶ /ask-plan ──▶ 计划期(只读 + ask_user_question)
                              │
                              ├─ 模型调研、提问、写计划
                              ▼
                        plan_submit(content)          ← 工具立即返回，回合结束
                              │
                              ├─ 落 v001.md，算块，开服务器，开 Windows 浏览器
                              ▼
                   浏览器：块级 diff 徽标 + 块批注 + 全局批注
                              │
              ┌───────────────┴───────────────┐
        提交修改意见(deny)                  批准(approve)
              │                               │
              ▼                               ▼
   pi.sendUserMessage(反馈 markdown)      写 specs/<slug>.md
   → 模型改计划 → plan_submit(v002)      → 退出计划期、恢复闸门状态
   → 浏览器 SSE 刷新（v1↔v2 块级 diff）   → 模型直接开工
```

## 5. 块模型

### 5.1 解析（`blocks.ts`）

- 逐行状态机，跟踪 ``` / ~~~ 围栏；围栏内**不切分**。
- 以「空行（≥2 个 `\n`）」分段；每段 = 一个块。标题行自然是单行块。
- 去掉首尾空行，块内保留原始 markdown（渲染时再走 markdown 渲染器）。
- 块字段：

```text
{ id, kind, text, hash, index }
  kind: heading | text | list | code | table | quote
  hash: sha1(归一化文本).slice(0,12)   // 归一化 = 压空白、去行尾空格
  id  : hash + (同 hash 的第几次出现)   // 重复段落也能区分
```

### 5.2 块级 diff（`diff.ts`，无依赖）

1. **同 id 匹配** → `unchanged`。
2. 未匹配的，在相邻缺口里两两配对：token Jaccard ≥ 0.5 → `modified`；
   否则旧的记 `removed`、新的记 `added`。
3. 输出 `{ id, status, prevId? }`，界面按状态上徽标（新增/已改/删除/未变）。

> 为什么不用行级 diff：块是「讨论单元」，改一个字和改一段在评审里是同一件事；
> 行级 diff 还要处理表格/围栏对齐，收益与成本不成比例。

### 5.3 批注数据

```json
{
  "global": [{ "verdict": "change|suggest|question", "comment": "..." }],
  "blocks": [{ "blockId": "ab12cd34ef56#0", "verdict": "change", "comment": "..." }]
}
```

- `verdict` 三档：`change`（必须改）/ `suggest`（建议）/ `question`（疑问，可不改）。
- 每块可挂多条；界面显示条数徽标。
- 提交时前端拼成固定模板的 markdown（模板在 `feedback.ts`，单测覆盖）：

```text
## Plan feedback — v2 (3 blocks changed)

### Global
- [change] 整体方向没问题，但不要把权限开关藏进计划流程里。

### Block: ## 5. 里程碑  (modified)
> 原块首行：1. 块模型 + 服务器
- [change] 里程碑 1 太大了，拆成 块模型 与 服务器 两步。
```

## 6. 服务器（`server.ts`，`node:http`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/` | 静态资源（SolidStart 构建产物） |
| GET | `/api/state?t=<token>` | 当前版本、块、diff、历史、批注、决策状态 |
| GET | `/api/version/:n` | 指定版本原文（历史抽屉用） |
| GET | `/api/events` | SSE：版本变化、批注变化、决策 |
| POST | `/api/annotate` | 增/改/删某块或全局批注 |
| POST | `/api/decide` | `{ action: "approve" \| "deny" }` |

安全（因为 WSL 必须绑 `0.0.0.0`）：

- 每个会话一个随机 token，放在打开 URL 的 query 里；页面把它写进 `X-Plan-Token` 头，
  所有写请求校验该头——外部站点拿不到 token（同源策略）。
- Host 白名单：`127.0.0.1:<port>`、`<wsl-ip>:<port>`、`localhost:<port>`。
- 写请求校验 `Origin`/`Sec-Fetch-Site`，跨站一律 403（照 plannotator 的立场）。
- 服务器只在计划评审打开期间存活；决策落地或 `session_shutdown` 即关闭；空闲 2 小时自关。

## 7. 界面（`ui/`，SolidStart SPA）

```text
ui/
├── vite.config.ts        # solidStart({ ssr: false }) + 静态输出
├── src/
│   ├── app.tsx           # 单页：计划视图 / 历史抽屉
│   ├── i18n.ts           # zh/en 词典 + localStorage 记忆
│   ├── blocks.tsx        # 块卡片：徽标、批注气泡、编辑框
│   ├── diff.tsx          # 块级 diff 视图（默认折叠未变块）
│   └── api.ts            # fetch + EventSource 封装
└── dist/  → 构建产物拷到 src/features/plan/assets/（随包发布）
```

- 顶部：版本选择（v3 of 5）、`3 changed`、语言切换、全局批注按钮、Approve/Deny。
- 主体：块列表。未变块默认折叠成一行「… 4 blocks unchanged …」；变了的块带左边框色标
  （新增=绿、修改=黄、删除=灰删除线）。
- 块批注：点击块右侧「+」→ 气泡（verdict 三选 + 文本框）；再次点开可改/删。
- 全局批注：顶部按钮打开侧栏。
- 历史抽屉：v1…vN 列表（时间、块数、变更数），点开只读查看并可「与上一版对比」。
- 首次进入显示「URL 已复制/打开方式」提示（若自动打开失败）。

## 8. 与 pi 的接线（`index.ts`）

### 8.1 命令

| 命令 | 作用 |
| --- | --- |
| `/ask-plan [标题]` | 进入计划期（自动开 ask-perm 默认参数；若在 ask 模式则先退出并提示） |
| `/ask-plan open` | 重新打开浏览器（或打印 URL） |
| `/ask-plan off` | 退出计划期（不产生 spec） |

### 8.2 工具 `plan_submit`

```text
plan_submit({ content: string, slug?: string })
```

- 写入 `vNNN.md`，解析块、算 diff、广播 SSE，**立即返回**：
  `{ version, blocks, changed, url }`。
- 返回即结束回合（与 plannotator 同一套「不阻塞」语义，理由：评审期间两边都能继续说话）。
- 批准/驳回从浏览器回到会话时，用 `pi.sendUserMessage(feedbackMarkdown)` 作为**新消息**进入。

### 8.3 门与模式

- 计划期不提供写仓库的工具通道：`write`/`edit`/`bash` 的写操作由 **复用 permission 的既有闸门**
  拦截（D9）；额外注册一条 plan gate：`write`/`edit` 一律拒绝（计划期唯一写口是 `plan_submit`）。
- 进入计划期：若 permission 未启用 → 用 `DEFAULT_MODES` 启用；若已启用 → 记住原状态。
  退出/批准：**恢复**进入前的状态（user 若中途手动改过，以他的手改为准，不再覆盖）。
- ask 模式：进入计划期时若 `/ask` 开着 → 自动退出并提示（计划期本身就是只读+提交）。

### 8.4 模型

**本功能不读写模型状态。** 代码里不出现 `pi.setModel` / `ctx.model` 的写操作；
计划期的"模型"就是当前会话模型，用户要换自己 `/model`。

## 9. 落盘

### 9.1 目录

```text
<agent-dir>/ask-plan/<slug>/
├── v001.md … vNNN.md     # 每版原文
├── state.json            # 版本元数据、批注（按版本）、决策、时间戳
└── spec.md               # 批准时的最终产物快照（与 specs/<slug>.md 同字节）
```

### 9.2 保留策略

- 版本默认全留（文本很小）；超过 50 版时删最旧的**未批准**版本，保留被批准的那一版。
- 同一 slug 的下一轮（第二天再来一遍）新建 `-2` 后缀目录，不覆盖历史。

### 9.3 spec 写入

- 批准时由**代码**写 `specs/<slug>.md`（不是模型调 `write`）：内容 = 被批准的版本原文，
  末尾追加半行元数据注释：`<!-- ask-plan: v3 of 5, approved 2026-11-11T01:20+08:00 -->`。
- 目标目录不存在则创建；已存在同名文件则写 `-2` 并在 notify 里说明。

### 9.4 不切模型的守卫

- 单测：`plan` 目录下所有源码 `grep` 不到 `setModel`（源码级断言，防回退）。
- AGENTS.md 不变量段追加一行：「除 `/ask-review` 外，任何功能不得切换模型」。

## 10. 实施里程碑

| M | 内容 | 验收 |
| --- | --- | --- |
| **M1** | `blocks.ts` + `diff.ts` + `feedback.ts`（纯函数，无 IO） | 单测：围栏/表格/重复段落/三态 diff/反馈模板 |
| **M2** | `store.ts`（版本落盘）+ `server.ts`（路由、token、SSE、WSL 打开器） | 单测 + 手工：curl 打全部路由；WSL 下 `cmd.exe start` 打开 |
| **M3** | `ui/`（SolidStart SPA）：块卡片、diff 徽标、两级批注、i18n、历史抽屉 | 手工 + Playwright 冒烟（可选） |
| **M4** | `index.ts` 接线：命令、`plan_submit`、plan gate、ask-perm 开关、spec 写入；文档 | 端到端冒烟：`/ask-plan` → 提交 → 浏览器批注 → 批准 → `specs/x.md` 出现 |

## 11. 测试

- 单测（vitest，与现有 667 例同套）：块解析边界、diff 三态、反馈模板字节、token/Host/Origin 守卫、
  打开器选择（用假 spawn 断言命令串）、版本保留、spec 写入路径冲突。
- 手工冒烟（tmux + 真实 pi）：§10 M4 的端到端，外加「不开浏览器也能用 URL 手工打开」。
- 不引入浏览器 E2E 到 CI（Playwright 已有 skill，按需手跑）。

## 12. 风险

| 风险 | 对策 |
| --- | --- |
| WSL 与 Windows 的网络差异（mirrored 模式、localhostForwarding 开启） | bind 0.0.0.0 + 依次尝试 WSL IP 与 localhost；URL 里两条都打印 |
| 端口被占 | 随机端口 + 3 次重试；`PLAN_PORT` 环境变量可指定 |
| 模型不按模板提交（漏块、整篇重写） | 提示词里写死「只改被点名的块」+ 反馈模板；diff 徽标会暴露整篇重写 |
| 批注指向的块被删 | 界面明确标「该块已删除」，反馈里保留引用文本 |
| 服务器进程泄漏 | 会话结束/决策后关闭，空闲 2h 自关，端口文件写 pid |
| SolidStart v2 的构建链折腾 | 先用 SPA 模式；若 Nitro 预设不配合，**退回 Solid + Vite 单页**（产物形态相同，接口不变） |

## 13. 我的建议（供拍板）

1. **SolidStart 只用它的 SPA 模式**，不要 SSR：我们没有 SSR 需求，多一个 Nitro 运行时只会多一类 bug；
   若构建链卡住，直接退到 Solid + Vite（同一份界面代码，去掉路由层）。
2. **构建产物提交进仓库**（`src/features/plan/assets/`）并加 `pnpm ui:check`
   （重建后 `git diff --exit-code`），避免「源码改了、包里还是旧界面」；产物预计 150–300 KB。
3. **不阻塞的提交工具 + 决定走新消息**是这套交互的命门，先做 M1/M2 把它跑通，界面再漂亮也是后话。
4. **token + Origin 守卫不要省**：为了 Windows 浏览器我们必须绑 `0.0.0.0`，这就比纯 loopback 多开了一扇窗。
5. **计划期彻底禁写仓库**（只留 `plan_submit`），比「prompt 里请求模型别写」可靠一个数量级。
6. 先做「单文件计划 + 单页界面 + 全局/块两级批注」的最小闭环，**历史抽屉和 i18n 放最后**——
   它们不影响主流程是否正确。
