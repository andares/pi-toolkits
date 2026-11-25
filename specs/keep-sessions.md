# SPEC: keep 会话暂存（`/keep-quit` · `/keep-load` · `/keep-drop`）

> 状态：**已实现**（2026-11-25）。实施记录见 `.agents/implementations/2026-11-25_0116_keep-session-backlog.md`。

## 1. Context

会话一多就记不住哪个做完、哪个没做完；`/resume` 把所有会话混成一个按时间排序的列表，既不区分「做完」与「没做完」，也不防止同一条会话被两个进程同时打开——两边各自 append，重新打开只看到最后写的那条分支。

`/keep-quit` 把「退出」和「这个任务还没做完」绑成一次动作：退出即入账。反过来，`/keep-load` 是「回到某个没做完的任务」的唯一入口，而不是又一个全量会话列表。

## 2. Goal

退出时一条命令把当前会话放进 keep 集合；下次启动能看到还有几个没载入；`/keep-load` 只列 keep 集合，把没载入的放上面、已载入的置灰放下面（都可选中，允许强行重载）；`/keep-drop` 与列表里的 `ctrl+r` 把会话移出 keep 集合。

## 3. Scope

**做**：三个命令；append-only keep 账本与纯函数折叠；TUI 列表（分组、置灰、`ctrl+r`）；启动的一行 notice；载入后注入一条 keep 备注到模型上下文；`rebuild` 从会话文件尾部重建账本；AGENTS.md / README / CHANGELOG 文档面。

**不做**：租约与心跳；拦截宿主自己的 `/resume`、`-c`、`-r`；不建 claim 文件、不做 pid 级互斥锁；不改宿主会话选择器与 `/resume` 的排序；不做 web 页面；不做跨机器同步；不记录「已完成」（不在 keep 集合里就是完成或未 keep）；不压缩历史账本。

## 4. Decisions

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 命令是 `/keep-quit`、`/keep-load`、`/keep-drop`；不叫 `save` | `save` 会被读成「存盘」，且 `/save-quit` 暗示会写一个文件 |
| D2 | 载入**不**自动出列；出列只有 `/keep-drop` 与列表里的 `ctrl+r` 两条路 | 自动出列会让「已载入」状态无处安放，也无法重开一个死掉的会话 |
| D3 | 「已载入」= 账本里的 `load` 事件带 owner（pid + host），干净退出时写 `unload`；读到 owner 进程已不存在时按未载入处理并补一条 `unload` | 硬杀留下的脏标记能自动纠正；剩下的错判（pid 复用、跨机器、`-ne` 进程）由「强行载入」兜 |
| D4 | 列表顺序：未载入在前、已载入在后，两组内都按最近一次 `keep` 时间倒序；已载入的行整行置灰，但仍可选中、可载入 | 崔总 2026-11-25 定 |
| D5 | 新会话启动时只报数量：「N not loaded · /keep-load」，已载入的不计入，只统计当前项目 | 一行、不吵；`--all` 留给需要跨项目的时候 |
| D6 | 载入时若当前会话「有内容 + 未 keep + 不是要载入的那个」，弹三选 `Keep it & load / Load anyway / Cancel` | 载入不再出列，唯一会丢的是「从没 keep 过的当前会话」 |
| D7 | 账本是 `<agentDir>/pi-toolkits-keep/keep.jsonl`，只追加事件流，状态由纯函数折叠 | 多进程各追加一行即可，没有读-改-写，不需要加锁（与 UAT ledger 同款理由） |
| D8 | 会话内额外写一条 `keep:unfinished` 自定义条目（面包屑） | 不进模型上下文；账本丢了能靠 `rebuild` 从会话尾部找回来 |
| D9 | 载入后注入一条 `custom_message`（`[keep] Resumed … note left …`） | 走上文的 `custom_message` 才进模型上下文；不触发回合，模型下一轮自己知道停在哪 |
| D10 | 全部运行时文案英文（notify、列表、notice、拒绝理由） | 仓库不变量 |
| D11 | 只读当前会话 `getSessionFile()`，从不调用 `SessionManager.list` / `listAll` | 本机实测：本项目 109 会话 576 ms，全量 648 会话 9.8 s；keep 列表只有几行，账本秒开 |
| D12 | v1 不压缩账本；一次操作一行，量级可忽略 | 压缩要整文件重写，会和并发 append 抢 inode |

## 5. Approach

### 5.1 宿主事实（本轮实测，pi 1.6.0 / tmux）

| 事实 | 结论 |
| --- | --- |
| `ctx.switchSession(path, {withSession})` | 真的切换；事件序 `session_before_switch(resume)` → `session_shutdown(resume)`（旧）→ `session_start(resume)`（新）→ `withSession` |
| 切换后旧 `ctx` | 立即 stale，任何调用都抛错——所有后续动作必须写在 `withSession` 里 |
| `ctx.shutdown()` | 走 `/quit` 的同一交互式关停路径，`session_shutdown(quit)` 后退出，quit-guard 照管 |
| 空会话 | 从不落盘（`getSessionFile()` 有值但文件不存在）→ `/keep-quit` 必须拒绝 |
| `session_shutdown.reason` | `quit` / `reload` / `new` / `resume` / `fork`；只有 `reload` 不是「会话真的走了」 |
| 原语可用性 | `switchSession` / `shutdown` / `appendEntry` / `registerEntryRenderer` / `setSessionName` 在 **0.99.0** 的 `types.d.ts` 里就有 → 不动兼容下限 |
| `ctrl+r` | 只被 `app.session.rename` 用（会话选择器作用域），不在 `tui.altScreen.*`，也不在全局绑定 → 我们自己的选择器消费它没有冲突；实施时仍跑 `pnpm check:keybindings ctrl+r` 并把结论写进报告 |
| `appendEntry` vs `sendMessage` | 前者是 `custom` 条目、不进模型上下文；后者是 `custom_message`、进上下文 |

### 5.2 账本与折叠

`keep.jsonl` 每行一个事件，字段 `v / id / ts / type`。事件只有四种：

| type | 附带字段 | 语义 |
| --- | --- | --- |
| `keep` | `session`（id）、`file`、`cwd`、`note`、`name?` | 入账 / 更新笔记（同 id 后者覆盖） |
| `drop` | `session` | 出账 |
| `load` | `session`、`owner`（`pid`、`host`、`since`） | 本进程载入了它 |
| `unload` | `session`、`owner`（只认 `pid`） | 该 owner 不再持有 |

折叠规则：`kept` = 同 id 最后一条 `keep`/`drop` 是 `keep`；`loadedOwners` = 有 `load` 且没有对应 `unload` 的 owner；`loaded` = `loadedOwners` 非空。同 host 上 `kill(pid, 0)` 失败的 owner 视为已消失——读到时就地补一条 `unload`（幂等，重复补也只是多一行空操作）。

`file` 走 `realpath`，`session` 是会话 id；同 id 换路径（迁移过的会话文件）按最后一条 `keep` 的 `file` 为准。文件不存在时条目保留但标记 `missing`，只能靠列表里的 `ctrl+r` 清掉。

### 5.3 `/keep-quit [note]`

前置校验：TUI、`ctx.isIdle()`、会话已持久化且已有对话。任一不满足就 notify 一行英文理由并返回，不写账本。

通过后按顺序做三件事：`pi.appendEntry("keep:unfinished", {note, at})` 写面包屑；追加 `keep` 事件（`note` 省略时沿用该 id 上一次的笔记，再退到会话名，再退到首条用户消息截断 60 字）；会话还没有名字时顺手 `pi.setSessionName(note)`。最后 `ctx.shutdown()`。

退出过程中 `session_shutdown(quit)` 会替本进程此前 `load` 过的会话补 `unload`，所以 keep-quit 之后它出现在列表顶部（未载入），符合「退出＝下次还要回来」的直觉。

### 5.4 `/keep-load [序号|id] [--all]` 与列表

无参且 TUI 时弹列表；带序号/id 时直接载入（非 TUI 也用这条路径）。列表形态：

```text
Keep backlog — 2 not loaded, 1 loaded
  ↑↓ move   enter load   ctrl+r drop   esc cancel

→ ○ 12m   订单表迁移，卡在第 2 步
  ○ 3h    评审页加暗色主题
  ● 2d    shop-api 结算对账 — 只跑了 unit
```

行 = `[→| ] [○|●] [年龄] [笔记]`，`--all` 时末尾再补一列项目路径（末段目录名）。`●` 的行整行用 `theme.fg("dim")`。`missing` 的行整行红字并附 `missing`。笔记超宽按 `truncateToWidth` 截断，选中行由选中色覆盖。

键：`↑↓` 移动、`Enter` 载入、`ctrl+r` 把当前指向的条目 drop 掉（不载入，列表原地重排）、`Esc` 取消、`d` 不占用（避免和宿主会话选择器的删除键撞习惯）。

载入流程：先追加 `load`（owner = 本进程）→ `ctx.switchSession(file, {withSession})`；`cancelled: true` 时补一条 `unload` 并 notify。`withSession` 里发那条 `[keep] Resumed … note left <本地时间>："<note>"`（`display: true`，`triggerTurn` 不设），再 notify 一行载入结果。同一个会话（file 等于当前 `getSessionFile()`）按「已经在当前会话里」拒绝。

### 5.5 切换前的三选

在 `keep-load` 真正切换之前判断：当前会话文件存在、有 user/assistant 消息、该 id 不在 keep 集合里、且不是目标会话——四条同时成立才弹窗。`Keep it & load` 先走 5.3 的入账（不退出）再载入；`Load anyway` 直接载入；`Cancel` 什么都不做。非 TUI 环境不弹，直接载入。

### 5.6 启动 notice

`session_start(reason="startup")` 且 `ctx.mode === "tui"` 且当前项目有未载入条目时，追加一条自定义会话条目（`keep:notice`，`registerEntryRenderer` 渲染，和 whats-new 同款——invalidate 冲不掉、不进模型上下文）：`2 not loaded · /keep-load`。零条则不显示任何东西。

### 5.7 `rebuild`

`/keep-load rebuild`：扫当前项目会话目录（`ctx.sessionManager.getSessionDir()`）里所有 `.jsonl`，每个文件读尾部 16 KB 找 `keep:unfinished`（本机实测 109 文件 ≈ 7 ms），缺失的 `keep` 事件补进账本。这条路径只补不删，是账本丢失后的兜底，不参与日常流程。

## 6. Files

| 文件 | 职责 |
| --- | --- |
| `src/features/keep/ledger.ts` | 事件类型、追加（自愈缺尾换行）、解析与去重、`deriveKeepState`、owner 探活与就地补 `unload` |
| `src/features/keep/store.ts` | 路径解析、会话元信息（只读首行 header 的 `cwd`/`id`）、笔记缺省与截断、`rebuild` 尾部扫描 |
| `src/features/keep/format.ts` | 行文本、年龄、notice 文本、宽度截断 |
| `src/features/keep/picker.ts` | 列表组件（分组、置灰、`ctrl+r`、滚动窗口）与非 TUI 回落 |
| `src/features/keep/index.ts` | 三个命令、启动 notice、`session_shutdown` 的 `unload`、切换前三选、`withSession` 注入 |
| `src/features/keep/keep.test.ts` | 账本折叠、探活补写、笔记缺省、rebuild、命令层用例 |
| `src/lib/event-ledger.ts` | 从 `src/features/uat/ledger.ts` 抽出的追加/解析/去重工具；抽不干净就维持各自实现并在注释写明理由 |
| `AGENTS.md` · `README.md` · `README.zh-CN.md` · `CHANGELOG.md` | 新 feature 段、命令表、Unreleased 条目 |

## 7. Milestones

**M1 — 账本与折叠（无 UI）**：`ledger.ts` + `store.ts` + 单元测试；验收 = 折叠/去重/owner 探活/笔记缺省/rebuild 全绿，且不调用任何 `SessionManager.list`。

**M2 — `/keep-quit`、`/keep-drop`、启动 notice**：三条拒绝理由、面包屑、`setSessionName`、`session_shutdown` 的 `unload`、notice 渲染；验收 = tmux 里 keep-quit 一次后重开 pi 能看到 `1 not loaded`，`/keep-drop` 后消失。

**M3 — `/keep-load` 与列表**：列表组件、分组/置灰/`ctrl+r`、三选弹窗、`withSession` 注入备注；验收 = 载入后列表里该行变灰在下、`ctrl+r` 能在不载入的情况下清掉一行、强行重载同一条不报错。

**M4 — 文档与真机**：AGENTS.md / README / CHANGELOG；`pnpm typecheck`、`pnpm test`、`pnpm check:keybindings ctrl+r`、`pnpm check:compat`、真实 pi 冒烟；验收 = 门禁全绿 + 冒烟四条场景过。

## 8. Verification

单元测试至少覆盖：`keep`/`drop` 覆盖顺序；`load` 带两个 owner 时退出其中一个仍是已载入；owner pid 不存活时自动补 `unload` 且重复读取不重复补；坏行跳过不炸；笔记缺省三级回退；`missing` 文件；`rebuild` 只补不删；命令层的四条拒绝理由；切换取消后补 `unload`；`--all` 的分组与项目列。

手工验收（真实 pi + tmux）四条：`/keep-quit` 退出后重启看到 notice 并 `/keep-load` 回到原处；`/keep-load` 后该行变灰、再选它仍能重载；`kill -9` 掉持有进程后列表自动把它当未载入；`ctrl+r` 与 `/keep-drop` 各自清掉一行。

命令：`pnpm typecheck`、`pnpm test`、`pnpm check:keybindings ctrl+r`、`pnpm check:compat`（新代码碰了 `switchSession`/`appendEntry`/`registerEntryRenderer`，按仓库纪律跑一次，预期窗口与探针结论不变、floor 仍是 0.99.0）。

## 9. Risks

1. **「已载入」是记账不是锁**：`-ne` 与 headless 进程不写 `load`，硬杀/跨机器/pid 复用会留脏状态——`kill(pid,0)` 能自动纠正大部分，剩下的靠强行载入，两个进程同时开同一条会话仍会静默分支（这是 D3 明确接受的代价）。
2. **账本会长期留脏条目**：会话文件删掉后条目只能靠 `ctrl+r` 清；列表里表现为红字 `missing`，不会自动清理（自动清理要猜，猜错就是丢任务）。
3. **新 UI 组件**：`SelectList` 的 `SelectItem` 只有 `{value,label,description}`，没有分组、没有单行置灰、没有 `setItems`（`ctrl+r` 后要重建）——所以写一个约 120 行的专用列表组件，逐行用 `theme.fg()` 渲染（先例：`src/features/favorites/patch-selector.ts` 也是逐行自绘）。宽度、置灰与选中态叠加的转义序列必须在真实终端目检，不能只靠单测。
4. **`ctrl+r` 与宿主同名键分属不同作用域**：宿主只在会话选择器里绑 `app.session.rename`，将来若提到全局或 `tui.altScreen.*`，我们的键就成了死键——升级时 `pnpm check:keybindings` 会报出来，届时按仓库纪律先上报再换键。
5. **`keep-quit` 依赖 `session_shutdown` 写 `unload`**：比本扩展更早加载的处理器挂住时，`session_shutdown` 可能根本轮不到我们跑（quit-guard 会硬退）——结果是「已载入」脏标记，同样由探活与强行载入兜住。

## 10. 明确不做（2026-11-25 崔总定）

1. 启动 notice 只统计当前项目，**不**追加 `· N in other projects`。
2. 列表行**不**显示「距上次 keep 有几条新消息」。

两项都毫无意义，**也不写进 `.agents/memory/FUTURE.md`**——不要再当延期项捡回来。
