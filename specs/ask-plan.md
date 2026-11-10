# SPEC: `/ask-plan` — 浏览器批注式计划评审（简化版 plannotator）

> 状态：**M1–M4 已实现，并通过第三方评审修正**（2026-11-11）。
> 调研底稿见 git 历史（`85112d7`），第一版方案 `b4c3052`。

## 0. 目标

`/ask` 讨论 → `/ask-plan` 调研 → 模型写计划 → **浏览器里按块批注** → 多轮 → 批准 →
`specs/<slug>.md` 定稿 → 直接实施。

## 1. 范围

**做**：计划期状态机、`plan_submit` 工具、块解析与块级 diff、本地 HTTP 服务 + Solid 界面、
两级批注（全局 / 块）、版本落盘与回看、批准后开工、ask-perm 自动开启。

**不做**：

- **绝不切模型**（任何代码路径都不得调用 `pi.setModel`）。plannotator 的自动切模型在 2026-09
  把崔总的现金额度烧掉 100 多元；我们的计划期用什么模型就是会话当前模型。
- 不做 live-app 反代批注、代码/PR 评审、Inbox、Ask-AI、浏览器终端、Mermaid/Graphviz、
  Obsidian/reference、多标签租约、remote TLS、VS Code 集成。
- 不做字符级/行级 diff：diff 粒度就是块。

## 2. 已确认的决策

| # | 决策 |
| --- | --- |
| D1 | 调研期允许 `ask_user_question` 提问，问完再提交计划；提问在终端对话框，不在浏览器 |
| D2 | 界面用 **Solid 1.9 + Vite 8**（单页 SPA，**不用 SolidStart**，理由见 §7） |
| D3 | **块 = 空行分隔的段落**；围栏代码块内不切分 |
| D4 | 批注只有两级：**全局 + 块** |
| D5 | 历史落盘到 `<agent-dir>/ask-plan/<slug>/` |
| D6 | spec 固定落 `specs/<slug>.md`（ask-init 框架） |
| D7 | 批准后直接开工 |
| D8 | 界面中英双语可切换，`localStorage` 记忆 |
| D9 | 闸门复用现有 permission；进入计划期自动开默认参数，可手动关 |
| D10 | 服务器要能唤起 **Windows 浏览器**（WSL 内 chrome 不算数） |
| D11 | 端口从 **3401** 起自增，**不做可配置**（有需要再加） |
| D12 | 决策（approve/deny）落地后**窗口关闭、服务器停止**；下一轮重开新窗口；直接关，不问、不倒计时 |
| D13 | 计划期**不按 ask 那么严**，对齐 plannotator：可写工作区内的 markdown，其余靠 permission 闸门 |
| D14 | 不引入 unix socket：浏览器只能说 HTTP，服务器就在 pi 进程内，信号是同进程的 promise |

## 3. WSL 打开 Windows 浏览器：已实测

本机（2026-11-11，WSL2 NAT，`.wslconfig` 无 `localhostForwarding`）：

| 组合 | 结果 |
| --- | --- |
| 绑 `127.0.0.1`，Windows 访问 `localhost` / `127.0.0.1` | ❌ |
| 绑 `0.0.0.0`，Windows 访问 `localhost` | ❌ |
| 绑 `0.0.0.0`，Windows 访问 WSL eth0 IP `172.24.47.146:8124` | ✅ 200 |
| `cmd.exe /c start "" "http://172.24.47.146:8125/"` | ✅ Windows 浏览器真的打进来（服务器日志有 `GET /`） |

旧坑确认：本机存在 `/usr/bin/google-chrome`，`xdg-open` 会拉起 WSL 内的 chrome。

**规则**：

1. WSL 下绑 `0.0.0.0`，URL 用 eth0 IP；非 WSL 绑 `127.0.0.1` 用 `127.0.0.1`。
2. 打开器按序：`wslview`（wslu）→ `cmd.exe /c start "" "<url>"`（cwd 设为 `/mnt/c`，避免 UNC
   警告）→ `powershell.exe -NoProfile -Command Start-Process '<url>'` →（非 WSL）`xdg-open`。
   **WSL 下绝不先试 `xdg-open`。**
3. 永远把 URL 打进 notify 与工具返回值（打开失败可手抄）。
4. 每轮评审第一次打开发；之后靠 SSE 刷新，不重复弹标签。

## 4. 用户旅程

```text
/ask 讨论 ──▶ /ask-plan ──▶ 计划期(读工具 + ask_user_question + 仅 .md 可写)
                              │ 模型调研、提问、写 specs/<slug>.md 草稿
                              ▼
                        plan_submit({ path })      ← 立即返回，回合结束
                              │ 快照 v001、算块、起服务器、开 Windows 浏览器
                              ▼
              浏览器：块级 diff 徽标 + 块批注 + 全局批注
                              │
              ┌───────────────┴───────────────┐
        deny(带批注)                        approve
              │                               │
   pi.sendUserMessage(反馈 md)          记录批准、复制快照
   → 模型改草稿 → plan_submit(v002)    → 窗口关闭/服务器停 → 直接开工
   → 浏览器重开、v1↔v2 块级 diff
```

## 5. 块模型

### 5.1 解析（`blocks.ts`）

- 逐行状态机跟踪 ``` / ~~~ 围栏，围栏内不切分。
- 以空行（≥2 个 `\n`）分段，每段一个块；标题是单行块。
- `{ id, kind, text, hash, index }`
  - `kind: heading | text | list | code | table | quote`
  - `hash = sha1(归一化).slice(0,12)`（压空白、去行尾空格、保留大小写）
  - `id = hash + '#' + 同 hash 的出现序号`（重复段落也能区分）

### 5.2 块级 diff（`diff.ts`，无依赖）

1. 同 `id` → `unchanged`。
2. 相邻缺口里两两配对，token Jaccard ≥ 0.5 → `modified`，否则 `removed` + `added`。
3. 输出 `{ id, status, prevId? }`；界面按状态上徽标（新增 / 已改 / 删除 / 未变）。

### 5.3 批注

```json
{
  "global": [{ "verdict": "change|suggest|question", "comment": "..." }],
  "blocks": [{ "blockId": "ab12cd34ef56#0", "verdict": "change", "comment": "..." }]
}
```

提交时前端拼固定模板（`feedback.ts`，单测覆盖字节）：

```text
## Plan feedback — v2 (3 blocks changed)

### Global
- [change] 整体方向没问题，但别把权限开关藏进计划流程里。

### Block: ## 5. 里程碑  (modified)
> 原块首行：1. 块模型 + 服务器
- [change] 里程碑 1 太大，拆成 块模型 与 服务器 两步。
```

## 6. 服务器（`server.ts`，`node:http`）

**端口**：从 3401 起自增（3401→3421 试 20 次），不做配置项；被占就顺延，URL 打在 notify 里。

**进程模型**：服务器与 pi **同进程**。浏览器 → HTTP → 进程内的 handler → resolve 一个 promise。
**不需要 unix socket**（浏览器无法连接 unix socket；同进程也没有"间"可通信）。若将来把服务器
拆成独立进程（例如为了 `/reload` 后仍存活），才需要「浏览器↔进程 HTTP + pi↔服务器 unix socket」
两段，本轮不做。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/` | 静态资源（index.html + assets） |
| GET | `/api/state?t=<token>` | 版本、块、diff、历史、批注、决策状态 |
| GET | `/api/version/:n` | 指定版本原文（历史抽屉） |
| GET | `/api/events` | SSE：版本变化、批注变化、决策 |
| POST | `/api/annotate` | 增/改/删批注 |
| POST | `/api/decide` | `{ action: "approve" \| "deny" }` |

安全（绑 `0.0.0.0` 的补偿）：

- 每轮一个随机 token，放打开 URL 的 query；页面写进 `X-Plan-Token` 头，写请求校验。
- Host 白名单：`127.0.0.1:<port>`、`<wsl-ip>:<port>`、`localhost:<port>`。
- 写请求校验 `Origin` / `Sec-Fetch-Site`，跨站 403。

**生命周期**：`/api/decide` 收到决策 → 广播 SSE `decided` → 200 响应 → 1.5 s 后 `server.close()`
并 `unref()` 掉定时器；页面尝试 `window.close()`（`cmd.exe start` 打开的标签浏览器会拒绝，
此时页面显示「✓ 已提交，可以关闭此标签」）。`session_shutdown` 与空闲 2 h 同样关闭。

## 7. 框架：Solid 1.9 + Vite 8（不用 SolidStart）

**结论**：单页 SPA，`vite` + `vite-plugin-solid` + `solid-js`，产物是 `index.html` + 哈希命名的
JS/CSS，由我们的 `node:http` 直接服务。版本相容性已核对：
`vite 8.3.7` ↔ `vite-plugin-solid 2.11.15`（peer 允许 `^8`）↔ `solid-js 1.9.18`；Node 26 满足
Vite 8 的引擎要求。

**为什么不用 SolidStart**：它的价值是 SSR、文件路由、server functions、部署适配器——我们一样都不需要
（单页；API 是自己的 `node:http`）。留着它只多一层 Nitro / Vite Environment API 的耦合与
v2 的版本抖动（`@solidjs/start` 现为 2.2.2，v1 仍以 `v1-latest 1.5.1` 并行维护）。
真需要路由时，单页 Solid SPA 迁到 SolidStart 是机械改动。

**工程落位**：

```text
ui/                      # pnpm workspace 成员（packages: ["ui"]）
├── package.json         # 私有包：solid-js + vite + vite-plugin-solid（dev）
├── vite.config.ts       # build.outDir → ../src/features/plan/assets，空目录后重建
├── tsconfig.json
└── src/
    ├── index.tsx        # 挂载
    ├── App.tsx          # 计划视图 + 历史抽屉
    ├── i18n.ts          # zh/en 词典 + localStorage
    ├── api.ts           # fetch + EventSource
    ├── BlockCard.tsx
    └── DiffView.tsx
```

- `pnpm ui:dev`：`vite` 开发服务器 + `server.proxy` 把 `/api` 转到 `127.0.0.1:3401`（我们的服务器），
  改界面不用重装扩展。
- `pnpm ui:build`：直接产出到 `src/features/plan/assets/`（随包发布，已 `.gitignore` 的 `dist/`
  不参与）。
- `pnpm ui:check`：重建 + `git diff --exit-code src/features/plan/assets`（防"源码改了、包里还是旧界面"）。
- **兼容矩阵不受影响**：`scripts/check-compat.mjs` 的沙箱只复制 `src/`、`scripts/`、`tsconfig.json` 与
  `package.json`/`pnpm-workspace.yaml`，`ui/` 不进去；且实测 `packages: ["ui"]` 指向不存在的目录时
  pnpm 照常 `install`（exit 0），沙箱不会因此变红。

## 8. 界面

- 顶部：`v2 of 5`、`3 blocks changed`、语言切换（中/EN）、全局批注、Approve / Deny。
- 主体：块列表。未变块折叠成一行「… 4 blocks unchanged …」；新增=绿、已改=黄、删除=灰删除线，
  每块右上角批注数徽标；点「+」开气泡（verdict 三选 + 文本）。
- 历史抽屉：v1…vN（时间、块数、变更数）+ 与上一版对比的只读视图。
- 决策后：整页变「✓ approved / ✗ feedback sent」状态卡，尝试 `window.close()`。

## 9. 与 pi 的接线（`index.ts`）

### 9.1 命令

| 命令 | 作用 |
| --- | --- |
| `/ask-plan [标题]` | 进入计划期：自动开 ask-perm 默认参数；若在 ask 模式则自动退出并提示 |
| `/ask-plan open` | 重开浏览器（或打印 URL） |
| `/ask-plan off` | 退出计划期（不产生批准记录；草稿留在原处并 notify） |

### 9.2 工具 `plan_submit`

```text
plan_submit({ path?: string })   // 默认 specs/<slug>.md；读取磁盘内容
```

- 快照到 `vNNN.md` → 解析块 → 算 diff → SSE 广播 → **立即返回**
  `{ version, blocks, changed, url }`，回合结束。
- 批准/驳回从浏览器回会话：`pi.sendUserMessage(feedbackMarkdown)` 作为新消息；批准时追加一句
  「计划已批准，可以开始实施」。

### 9.3 计划期的工具面（对齐 plannotator，不按 ask 那么严）

- `write` / `edit`：plan gate 只放行 **`.md` 文件**（工作区内），其余一律拒绝并说明原因。
- `bash`：放行，破坏性操作交给 permission 的危险命令表。
- 只读工具与 `ask_user_question`：照常。
- ask-perm：进入计划期若未启用 → 用 `DEFAULT_MODES` 启用并记住原状态；退出/批准时恢复
  （用户中途手动改过则以他为准，不覆盖）。

### 9.4 模型

不读不写模型状态；代码里不出现 `pi.setModel`。守卫见 §11。

## 10. 落盘

```text
<agent-dir>/ask-plan/<slug>/
├── v001.md …         # 每版快照（提交时的磁盘内容）
└── state.json        # 版本元数据、各版批注、决策与时间戳
```

- 版本默认全留；>50 版删最旧的未批准版本，保留批准的那一版。
- 同 slug 再来一轮 → 新目录 `<slug>-2`，不覆盖历史。
- **spec 就是仓库里的 `specs/<slug>.md`**（模型自己写，批准后不再改写内容）；
  批准记录只进 `state.json`，**不往文件里塞注释**（保持批准字节 = 落盘字节）。

## 11. 不切模型的守卫

- 单测：`src/features/plan/` 下全部源码 grep 不到 `setModel`（源码级断言，防回退）。
- AGENTS.md 不变量段追加：「除 `/ask-review` 外，任何功能不得切换模型」。

## 12. 里程碑

| M | 内容 | 验收 |
| --- | --- | --- |
| **M1** | `blocks.ts` + `diff.ts` + `feedback.ts`（纯函数） | 单测：围栏/表格/重复段落/三态 diff/模板字节 |
| **M2** | `store.ts` + `server.ts`（路由、token、SSE、3401 起端口、WSL 打开器、决策后关闭） | 单测 + curl 打全部路由 + 真机 `cmd.exe start` 打开 |
| **M3** | `ui/`（Solid+Vite）：块卡片、diff 徽标、两级批注、i18n、历史抽屉、决策态 | 手工冒烟；`pnpm ui:dev` 走 proxy |
| **M4** | `index.ts` 接线：命令、`plan_submit`、plan gate、ask-perm 开关、文档/测试 | 端到端：`/ask-plan` → 提交 → 批注 → 批准 → 开工 |

## 13. 风险与对策

| 风险 | 对策 |
| --- | --- |
| WSL 网络模式差异（mirrored / localhostForwarding 开启） | 绑 `0.0.0.0`；URL 依次试 WSL IP 与 localhost，两条都打印 |
| 端口被占 | 3401→3421 顺延；仍失败则报错并打印手工 URL |
| 模型整篇重写导致 diff 全红 | 提示词要求「只改被点名的块」；diff 徽标会立刻暴露 |
| 批注指向的块被删 | 界面标「该块已删除」，反馈里保留引用首行 |
| 服务器泄漏 | 决策/会话结束/空闲 2 h 关闭；端口文件写 pid |
| 界面产物过期 | `pnpm ui:check` 进 CI 门禁 |

## 14. 建议

1. 先做 M1/M2（块模型 + 服务器 + 非阻塞提交），界面再漂亮也是后话。
2. 产物提交进仓库 + `ui:check`，否则一定出现「源码改了、包里还是旧界面」。
3. token + Origin 守卫别省：为 Windows 浏览器必须绑 `0.0.0.0`。
4. 计划期只放行 `.md` 写入，比 prompt 里"请求模型别写"可靠一个数量级，又不像 ask 那样断手断脚。
5. 历史抽屉与 i18n 放最后，它们不影响主流程正确性。
