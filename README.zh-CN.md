<!-- markdownlint-disable MD033 -->
<!-- Inline <a name> anchors are the only reliable TOC targets for CJK headers on GitHub. -->
# ⚙️ @andares/pi-toolkits

[English](README.md) · **中文**

> pi 编码代理的集成扩展工具包 — 一个包,持续生长新能力。

[![npm version](https://img.shields.io/npm/v/@andares/pi-toolkits?label=npm&logo=npm)](https://www.npmjs.com/package/@andares/pi-toolkits)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Package Manager](https://img.shields.io/badge/package%20manager-pnpm-orange?logo=pnpm)](https://pnpm.io)
[![pi >= 0.86](https://img.shields.io/badge/pi-%3E%3D0.86.0%20%3C2.0.0-blueviolet)](https://github.com/earendil-works/pi)
[![GitHub](https://img.shields.io/badge/github-andares%2Fpi--toolkits-181717?logo=github)](https://github.com/andares/pi-toolkits)

一句话介绍:目前包含六个开箱即用的功能——**只读咨询模式** `ask`、**模型收藏** `favorites`、**提示词暂存** `stash`、**第三方代码评审** `third-review`、**独立压缩模型** `compact-model`、**会话启动自动化** `autostart`,后续持续追加。

**版本要求**:pi `>=0.86.0 <2.0.0`(覆盖最近 4 个中版本线 0.86.x / 0.87.x / 0.99.x / 1.0.x —— 0.88–0.98 从未发布。区间内全部 10 个已发布版本逐版本比对宿主 dist:用到的扩展 API 无差异,favorites 两处运行时 patch 目标 `ModelSelectorComponent` / `AgentSession.cycleModel` 字节级一致;并在 0.86.0、0.86.1、0.87.1、0.99.2、1.0.2 上逐一通过 typecheck + 全量测试,在真实 pi 1.0.2 上冒烟加载无警告)。注:pi ≥ 0.99 的宿主要求 `@earendil-works/pi-tui` 声明为 peerDependencies `"*"`(由宿主提供),本包已按要求声明。

---

## 📦 安装

<a name="install"></a>

```bash
# 从 npm 安装(推荐)
pi install npm:@andares/pi-toolkits

# 本地开发安装
pi install .

# 单次会话加载,不安装
pi -e ./src/index.ts
```

安装后在任意 pi 会话中验证:

- `/ask` → footer 出现灰色 `ask` 状态,`write`/`edit` 被硬禁用
- `/model`(或 `ctrl+l`)→ 选择器顶部出现收藏提示行
- 输入框内按 `ctrl+alt+y` → 当前提示词被暂存并清空输入框
- 完成一个开发任务后输入 `/third-review` → 切换到评审模型执行查+修
- `/compact-model` 选一个便宜快模型 → 之后 `/compact` 与自动压缩的总结都由它执行(footer 出现灰色 `compact` 状态)

---

## 📚 目录

- [安装](#install)
- [功能总览](#features)
  - [🛡️ ask — 只读咨询模式](#ask)
  - [⭐ favorites — 模型收藏](#favorites)
  - [📥 stash — 提示词暂存](#stash)
  - [🔎 review — 第三方代码评审](#review)
  - [🗜️ compact — 独立压缩模型](#compact)
  - [🚀 autostart — 会话启动自动化](#autostart)
- [开发](#development)
- [贡献](#contributing)
- [许可](#license)

---

## ✨ 功能总览

<a name="features"></a>

| 功能 | 入口 | 一句话说明 |
| --- | --- | --- |
| 🛡️ **ask** 只读咨询模式 | `/ask` | 进入只读问答模式,`write`/`edit` 硬禁用,`bash` 只读沙箱 |
| ⭐ **favorites** 模型收藏 | `/model` 内 `ctrl+A` / `ctrl+J` | 收藏常用模型(加粗亮黄标记),`ctrl+p` 仅在收藏间循环 |
| 📥 **stash** 提示词暂存 | `ctrl+alt+y` | 一段提示词的暂存槽,按键交换 / 连按两次暂存并清空输入框 |
| 🔎 **review** 第三方代码评审 | `/third-review` | 召唤配置的评审模型,对刚完成的任务做查+修,重点检查「本轮需求实现 / 是否有遗漏 / 是否有错误」 |
| 🗜️ **compact** 独立压缩模型 | `/compact-model` | 给 `/compact` 与 auto-compact 配一个便宜快模型做总结,主模型专注对话;未配置零开销、任何异常回落 pi 默认 |
| 🚀 **autostart** 会话启动自动化 | `.pi/autostart.toml` | 项目内声明启动时自动执行的斜杠命令(首批用例:`/add-dir` 多仓库挂载);未信任不执行、未注册命令跳过不发给模型 |

---

## 🛡️ ask — 只读咨询模式

<a name="ask"></a>

用 `/ask` 进入(再按一次退出)。适合只想要"问问题、读代码",绝不希望模型改动任何文件的场景。

**进入后**:

- **`write` / `edit` 硬禁用** —— 从活跃工具集中移除,pi 运行时对未激活工具的调用直接拒绝("Tool not found"),文件修改在机制上不可能发生
- **`bash` 保留但只读沙箱** —— 基于 shell 分词 + 写盘意图检测(`curl -o/-O`、`wget -O`、`dd of=`、`tee`、重定向等一律拦截)。启发式,非安全边界
- **系统提示词追加** —— 追加一段模式说明,模型会遵守只读约束行事
- **灰色 `ask` footer 状态** —— 常驻提示当前处于只读模式

**退出**:再按 `/ask`,完整恢复进入前的工具集快照。

---

## ⭐ favorites — 模型收藏

<a name="favorites"></a>

标记常用模型,让模型切换「粘」在收藏上。收藏**跨会话、跨项目全局持久化**。

**在 `/model` 选择器内**(`/model` 或 `ctrl+l` 打开):

- 顶部提示行显示按键与当前过滤状态
- `ctrl+A` —— 对当前选中模型开/关收藏;收藏的模型文字显示为**加粗亮黄**
- `ctrl+J` —— 开/关「仅显示收藏模型」过滤(可与内置搜索叠加使用)

**模型循环**:只要存在 ≥1 个收藏,`ctrl+p` / `ctrl+shift+p` 就**只在收藏模型间循环**。当前模型不是收藏时,`ctrl+p` 跳到第一个收藏、`ctrl+shift+p` 跳到最后一个;收藏仅 1 个时停在原地(`Only one model available`)。`ctrl+l` / `/model` 始终可自由选择任意模型(含非收藏)。在状态文件中设 `"cycleOnlyFavorites": false` 可恢复全量循环。

**状态文件**:`<agent-dir>/pi-toolkits-favorites.json`(默认 `~/.pi/agent/`,与 auto-naming-session 配置同目录):

```json
{
  "favorites": ["anthropic/claude-sonnet-4"],
  "config": { "cycleOnlyFavorites": true }
}
```

`/favorites` 命令列出当前收藏与循环模式。

> **实现说明**:pi 的 `app.model.cycleForward`(`ctrl+p`)与 `cycleBackward` 是**保留键位**,扩展快捷键无法覆盖;且扩展快捷键只在编辑器聚焦时生效。因此本功能不重绑任何按键,而是在运行时 patch 两个内置原型(带版本守卫、`/reload` 幂等):`ModelSelectorComponent`(提示行、`ctrl+A`/`ctrl+J`、亮黄渲染、仅收藏过滤——按键仅在选择器内消费,编辑器里 `ctrl+j` 换行不受影响)与 `AgentSession.cycleModel`(收藏循环)。若 pi 升级导致 patch 无法应用,会 warn 并优雅降级,不影响其它功能。
>
> **为何是 `ctrl+A` 而不是 `ctrl+F`**:pi 自 1.0 起 `tuiMode` 默认 `fullscreen`(0.86–0.99 默认 `regular`),而在 Windows/WSL 上宿主把 `tui.altScreen.search` 解析为 `ctrl+f`;`TuiAltScreen.handleViewportInput()` 在**把输入交给聚焦覆盖层之前**先检查该绑定,于是 `ctrl+f` 打开了会话记录搜索、根本到不了选择器。曾过渡性地选过 `ctrl+alt+f`——pi 层完全空闲,却被 Windows 侧截图工具作为全局热键截走:**宿主表空闲 ≠ 机器层空闲**。最终从 "favorite" 一词里逐字母审计:`v` 是 Windows Terminal 的粘贴键,`o`/`r`/`t` 是宿主 app 层动作,`i` 与 Tab 字节恒等(选择器的 scope 切换),`e` 可用但无记忆点;`a` 仅遮蔽搜索框内的行首跳转、读作 *add favorite*,且选择器上游无任何消费者。完整依据见 `src/features/favorites/constants.ts` 与 `pnpm check:keybindings`。

---

## 📥 stash — 提示词暂存

<a name="stash"></a>

一个热键 + 一个暂存槽,在「当前提示词」与「暂存提示词」之间腾挪,方便把一段提示词先放一边、空出输入框写新的,需要时再取回。

| 操作 | 效果 |
| --- | --- |
| 按一次 `ctrl+alt+y` | 当前提示词 → 入缓存;缓存内容 → 填入输入框(**交换**) |
| 间隔再按 | 在两段提示词之间**来回切换** |
| **400ms 内连按两次** | 当前提示词入缓存 + **清空输入框**(旧暂存被丢弃),直接开写新提示词;之后按一次取回 |

缓存为空时,单按一次即「暂存 + 清空」。缓存为**进程内内存、不落盘**(提示词可能含敏感内容);`/new` 切会话不清缓存,`/reload` 清空。选择器(`/model`、`/tree` 等)打开时按键不生效(焦点在组件,不在编辑器)。

**为什么是 `ctrl+alt+y`**(四级兼容性调研结论):

| 层面 | 状态 | 说明 |
| --- | --- | --- |
| pi 键位 | ✅ | 无默认 `ctrl+alt+字母` 绑定;扩展快捷键在编辑器内最先分发 |
| Linux 终端 | ✅ | `alt` 以 ESC 前缀编码(`ctrl+alt+y` = `ESC + ctrl+y`),不依赖 kitty 协议即可区分 |
| Windows Terminal | ✅ | 无默认 `ctrl+alt` 绑定 |
| Windows 操作系统 | ✅ | 系统级仅保留 `ctrl+alt+del` |

**被排除的候选**:`ctrl+shift+字母` —— Linux 与 Windows 的终端 emulator 都占用复制/粘贴/标签页;且无 kitty 协议的终端上会坍缩成 `ctrl+字母`(`ctrl+shift+m` 即回车,会直接提交提示词,危险)。纯 `ctrl+字母` —— pi 几乎全部占用,唯一空闲的 `ctrl+q` 是 XON 流控字符,有历史包袱。

---

## 🔎 review — 第三方代码评审

<a name="review"></a>

开发任务完成后,输入 `/third-review` 指令召唤**另一个模型**以第三方身份,对刚完成的代码做「查 + 修」:评审模型拥有**完整工具权限**,确认的问题直接改,不是只读审计。评审回合留在当前会话记录里,评审完成后**会话保持评审模型**(不自动切回)。

> **仅指令触发**:只有 `/third-review` 能发起评审。聊天中直接输入 `third-review` 不会触发(作为普通消息发给模型),避免误发。

**评审提示词重点检查三点**(逐项给出结论):

1. **本轮需求实现** —— 需求是否已完整、正确地实现,与需求描述是否一致
2. **是否有遗漏** —— 功能点、边界情况、异常处理、兼容性、测试等
3. **是否有错误** —— 逻辑错误、潜在 bug、类型/编译错误、安全与性能隐患等

**范围强约束** —— 评审仅限**当前本轮修改内容**,避免扩大范围;本轮改动范围内确认的问题才直接修复,范围外的历史遗留/无关问题只记录提示、不动手改。

**评审模型选择**(每次 `/third-review` 都会弹出选择界面):

- `/third-review` → 弹出 **`/model` 同款选择器**(限高滚动 + 模糊搜索):**默认选中当前配置的模型**(✓ 标记),直接**回车**即用它开始评审
- **换选其他模型** → 立即写回配置(**落盘 + 内存**),**下次默认使用该模型**
- **取消**(Esc)→ 不执行评审,配置不变
- 配置持久化于 `<agent-dir>/pi-toolkits-review.json`(默认 `~/.pi/agent/`):

```json
{ "model": "anthropic/claude-sonnet-4" }
```

- `/review-model` —— 单独的配置入口:弹出同一列表(不改会话模型,只更新默认配置)
- **未配置 / 配置的模型已不可用**(如在 pi 的 models.json 里删掉了该模型)→ 提示后照常弹出列表(此时无默认项)
- 任务仍在进行中(agent 未空闲)时触发 → 提示等待,不执行;同一时间只允许一个评审
- footer 出现灰色 `review` 状态 = 已配置评审模型

---

## 🗜️ compact — 独立压缩模型

<a name="compact"></a>

pi 的 `/compact` 与 auto-compact 默认**用当前会话模型**做上下文总结——主模型往往贵且慢,而压缩总结是典型的「便宜快模型就能干好」的任务。本功能配置一个独立模型接管**全部三种压缩触发**的总结:

| 触发 | 接管后 |
| --- | --- |
| 手动 `/compact [instructions]` | 压缩模型总结,自定义 focus 照常注入 |
| auto-compact 阈值触发 | 压缩模型总结 |
| context overflow 恢复 | 压缩模型总结,重试行为不变 |

**接管后与 pi 内建行为完全一致的部分**(逐字同步 pi 内建实现,0.87.1 起字节级不变、已核对至 1.0.2,只换执行模型):

- **摘要格式** —— Goal / Progress / Key Decisions 结构化 checkpoint;已有摘要时用迭代更新版 prompt,信息延续不丢
- **切分行为** —— 保留最近 `keepRecentTokens` 的策略、`firstKeptEntryId` / `tokensBefore` 原样回传,不动
- **输出预算** —— 与内建同公式(历史段 0.8×、切分前缀段 0.5× `reserveTokens`,再按模型输出上限收敛)
- **文件清单尾部** —— `<read-files>` / `<modified-files>` 标签照常拼在摘要尾部,details 同形状维护
- **用量统计** —— 压缩模型的 token/cost 计入 session 统计
- **可取消** —— 压缩进行中 `Esc` 干净取消(信号透传到底层调用)

**配置**(`<agent-dir>/pi-toolkits-compact.json`,默认 `~/.pi/agent/`):

```json
{ "model": "google/gemini-2.5-flash" }
```

- `/compact-model` —— 查看/更换:`/model` 同款选择器(限高滚动 + 模糊搜索),**默认选中当前配置的模型**,回车即确认;换选即写入;取消则不变(清除配置:编辑 `pi-toolkits-compact.json` 把 `model` 置为 `null`)
- 未配置 = 功能未启用,全部走 pi 默认,零开销;footer 出现灰色 `compact` 状态 = 已配置

**无损回落**(本功能永远不会把压缩「做挂」):

| 情形 | 行为 |
| --- | --- |
| 未配置 | 直接回落 pi 默认压缩 |
| 配置的模型不可用(如从 models.json 删除) | warning 提示 + 回落 |
| 总结失败 / 摘要为空 / 命中 token 上限 | 提示 + 回落 pi 默认压缩 |
| 用户取消(`Esc`) | 干净取消,无错误刷屏 |

> **实现说明**:接管点是官方的 `session_before_compact` 扩展事件(三种触发都会先经过);返回压缩结果即完全接管,返回 `undefined` 即回落内建。auto-compact 路径绝不弹任何对话框(handler 内只 notify)。`/tree` 分支总结(`session_before_tree`)是另一个事件,本期不接管,留作后续迭代。

---

## 🚀 autostart — 会话启动自动化

<a name="autostart"></a>

多仓库项目的第一步:在项目内声明「开新会话时要自动执行的斜杠命令」,首批用例是 `/add-dir` 挂载兄弟仓库——新会话无需手动重放。

**配置**(`<项目根>/.pi/autostart.toml`,随项目进 git;`.pi/` 是 pi 的项目级配置惯例,先例 `.pi/mcp.json`):

```toml
version = 1

[command]
run = [
  "/add-dir ../shop-frontend",
  "/add-dir ../shop-api",
]
```

无文件 = 功能未启用,零开销、静默跳过。

**执行时机**:

| session_start reason | 是否重放 | 原因 |
| --- | --- | --- |
| `startup` / `new` | ✅ | 新会话,按声明重放 |
| `fork` | ✅ | 分支点可能早于配置出现 |
| `resume` | ❌ | 恢复的分支已携带当时的挂载状态,重放反而会冲突 |
| `reload` | ❌ | 扩展重建,重放会重复副作用 |

**安全门**(按序):

1. **project trust** —— 未信任目录不自动执行任何命令(warning 提示);配置解析失败同样不执行(error 提示)
2. **命令预校验** —— 只执行「扩展注册的命令」;未注册的命令名**跳过并警告**,绝不发给模型(sendUserMessage 对未处理的 `/x` 会当作普通消息发给 LLM,这是必须预校验的原因)

**关键约束:只支持扩展命令**。`/add-dir`(pi-add-dir)、`/cd`(pi-cd)等 `registerCommand` 注册的命令可以;内置命令(`/compact`、`/reload`、`/resume`…)在 TUI 层分发,扩展层触发不了;skill 命令(`/skill:name`)是展开机制而非执行机制。依赖的目标扩展(如 pi-add-dir)需要先安装。

> **实现说明**:执行用 `sendUserMessage(cmd, { expandPromptTemplates: true })` —— 该选项把 `/cmd args` 路由到命令分发而不是模型 prompt 路径(包装层默认 `false`,已对照 pi 0.86–1.0.4 源码核实,见 AGENTS.md 宿主兼容纪律)。预校验用 `pi.getCommands()`(只认 `source: "extension"`)。依赖 `smol-toml`(零依赖、~10KB、TOML 1.0)。

---

## 🛠️ 开发

<a name="development"></a>

**pnpm 是本仓库唯一受支持的包管理器** —— 本仓库内不得使用 `npm install` / `npm publish`。

```bash
pnpm install      # 安装依赖
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest(全部功能单元测试)
```

### 项目结构

```text
src/
├── index.ts              # 入口:聚合各功能模块
├── lib/                  # 共享基础设施(工具集快照/恢复、
│                         # review 与 compact 共用的模型 key 解析)
└── features/             # 功能模块 —— 一个功能一个目录
    ├── ask/              # ask 模式:命令 + 状态机、bash 沙箱、
    │                     #           系统提示词横幅、测试
    ├── autostart/        # 会话启动自动化:autostart.toml 解析、
    │                     #           命令预校验 + 重放、测试
    ├── compact/          # 独立压缩模型:session_before_compact 接管 +
    │                     #           /compact-model、配置存储、prompt、测试
    ├── favorites/        # 模型收藏:选择器与循环 patch、
    │                     #           持久化存储、测试
    ├── review/           # 第三方评审:输入/指令触发、
    │                     #           评审模型配置存储、提示词、测试
    └── stash/            # 提示词暂存:热键状态机 + 测试
```

**新增功能**:新建 `src/features/<name>/`,导出 `registerXxx(pi)`,在 `src/index.ts` 中调用;已有模块保持不变。每个功能自带 `*.test.ts`(vitest)——保持确定性(时钟/状态可注入,不写真实 agent-dir)。

**发布**(仅 pnpm 一条命令):

```bash
pnpm release patch   # 0.1.2 → 0.1.3
pnpm release minor   # 0.1.2 → 0.2.0   (patch 清零)
pnpm release major   # 0.1.2 → 1.0.0   (minor + patch 清零)
pnpm release patch --dry-run   # 预览,不做任何改动
```

`release` 要求且仅要求 `major | minor | patch` 之一;上级递增清零下级。执行链:**工作区必须干净(有未提交变更直接中止,保证 tag 内容 == 发布内容)** → `typecheck + test` 门禁 → 改版本 → git commit + `vX.Y.Z` tag(自检 tag==HEAD 且工作区干净) → `pnpm publish`(`prepublishOnly` 二次门禁) → 只推当前分支 + 当前 tag 并校验远端哈希一致(远端 tag 不一致则跳过 Release 创建)。

---

## 🤝 贡献

<a name="contributing"></a>

欢迎提交 PR 与 issue。几条约定:

- **只用 pnpm** —— 不得 `npm install` / `npm publish`;用 `pnpm add` / `pnpm publish`
- **功能模块模式** —— 一个功能一个目录(`src/features/<name>/`),导出 `registerXxx(pi)`,在 `src/index.ts` 注册;共享基础设施放 `src/lib/`
- **测试** —— 每个功能自带 vitest 用例;保持确定性(时钟/状态可注入),不写真实 agent dir
- **内建 patch**(favorites)必须保持**版本守卫 + 幂等** —— 打 patch 前先确认目标原型成员存在,防止重复应用,失败时用 `console.warn` 降级而不是把扩展搞挂
- **内建提示词同步**(compact) —— `src/features/compact/prompt.ts` 里的总结 prompt 逐字抄自 pi 内建压缩;升级 pi 依赖时 diff `dist/core/compaction/compaction.js`(及 `utils.js`),同步字符串与组装辅助函数,保持接管输出与内建字节级一致
- **键位** —— 定新快捷键前先查 pi 默认键位 + 保留键、终端控制字符、OS/终端模拟器占用;跨平台安全优先选 `ctrl+alt+<字母>`。**不得只验证「主屏下我这台机器能用」**:自 pi 1.0 起默认 `fullscreen`,alt-screen 层在对话框看到按键**之前**就消费 `tui.altScreen.*`,且 Windows/WSL 上多个绑定与 Linux 默认值不同。用 `pnpm check:keybindings [候选键...]` 核查(pi 升级后跑 `pnpm check:keybindings --all`),它用宿主自己的 `matchesKey` 探测已安装宿主的**已解析**键位表。**宿主表空闲 ≠ 机器层空闲**:Windows Terminal 默认占 `ctrl+v`(粘贴)与 `ctrl+shift+f`(查找),第三方 Windows 工具常绑 `ctrl+alt+<字母>`(截图工具占过 `ctrl+alt+f`)——定键后必须在真机试按,确认按键真的到得了应用。
- **质量门禁** —— 提交前必须通过 `pnpm typecheck && pnpm test`

---

## 📄 许可

<a name="license"></a>

MIT © 2026 Andares Cui. 见 [LICENSE](LICENSE)。
