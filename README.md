<!-- markdownlint-disable MD033 -->
<!-- Inline <a name> anchors are the only reliable TOC targets for CJK headers on GitHub. -->
# ⚙️ @andares/pi-toolkits

> pi 编码代理的集成扩展工具包 — 一个包,持续生长新能力。
> Integrated toolkit extension for [pi](https://github.com/earendil-works/pi-coding-agent) — one package, growing new capabilities over time.

[![npm version](https://img.shields.io/npm/v/@andares/pi-toolkits?label=npm&logo=npm)](https://www.npmjs.com/package/@andares/pi-toolkits)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Package Manager](https://img.shields.io/badge/package%20manager-pnpm-orange?logo=pnpm)](https://pnpm.io)
[![pi >= 0.84](https://img.shields.io/badge/pi-%3E%3D0.84.0-blueviolet)](https://github.com/earendil-works/pi)
[![GitHub](https://img.shields.io/badge/github-andares%2Fpi--toolkits-181717?logo=github)](https://github.com/andares/pi-toolkits)

一句话介绍:目前包含四个开箱即用的功能——**只读咨询模式** `ask`、**模型收藏** `favorites`、**提示词暂存** `stash`、**第三方代码评审** `third-review`,后续持续追加。
Currently ships four ready-to-use capabilities — **ask mode**, **model favorites**, **prompt stash** and **third-party code review** — with more to come.

---

## 📦 安装 Installation

<a name="install"></a>

```bash
# 从 npm 安装(推荐)· from npm
pi install npm:@andares/pi-toolkits

# 本地开发安装 · local development
pi install .

# 单次会话加载,不安装 · one-off session, no install
pi -e ./src/index.ts
```

安装后在任意 pi 会话中验证:

- `/ask` → footer 出现灰色 `ask` 状态,`write`/`edit` 被硬禁用
- `/model`(或 `ctrl+l`)→ 选择器顶部出现收藏提示行
- 输入框内按 `ctrl+alt+y` → 当前提示词被暂存并清空输入框
- 完成一个开发任务后输入 `/third-review` → 切换到评审模型执行查+修

---

## 📚 目录 Contents

- [安装 Installation](#install)
- [功能总览 Features at a glance](#features)
  - [🛡️ ask — 只读咨询模式](#ask)
  - [⭐ favorites — 模型收藏](#favorites)
  - [📥 stash — 提示词暂存](#stash)
  - [🔎 review — 第三方代码评审](#review)
- [开发 Development](#development)
- [贡献 Contributing](#contributing)
- [许可 License](#license)

---

## ✨ 功能总览 Features at a glance

<a name="features"></a>

| 功能 | 入口 | 一句话说明 |
| --- | --- | --- |
| 🛡️ **ask** 只读咨询模式 | `/ask` | 进入只读问答模式,`write`/`edit` 硬禁用,`bash` 只读沙箱 |
| ⭐ **favorites** 模型收藏 | `/model` 内 `ctrl+F` / `ctrl+J` | 收藏常用模型(加粗亮黄标记),`ctrl+p` 仅在收藏间循环 |
| 📥 **stash** 提示词暂存 | `ctrl+alt+y` | 一段提示词的暂存槽,按键交换 / 连按两次暂存并清空输入框 |
| 🔎 **review** 第三方代码评审 | `/third-review` | 召唤配置的评审模型,对刚完成的任务做查+修,重点检查「本轮需求实现 / 是否有遗漏 / 是否有错误」 |

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
- `ctrl+F` —— 对当前选中模型开/关收藏;收藏的模型文字显示为**加粗亮黄**
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

> **实现说明**:pi 的 `app.model.cycleForward`(`ctrl+p`)与 `cycleBackward` 是**保留键位**,扩展快捷键无法覆盖;且扩展快捷键只在编辑器聚焦时生效。因此本功能不重绑任何按键,而是在运行时 patch 两个内置原型(带版本守卫、`/reload` 幂等):`ModelSelectorComponent`(提示行、`ctrl+F`/`ctrl+J`、亮黄渲染、仅收藏过滤——按键仅在选择器内消费,编辑器里 `ctrl+f` 光标右移、`ctrl+j` 换行不受影响)与 `AgentSession.cycleModel`(收藏循环)。若 pi 升级导致 patch 无法应用,会 warn 并优雅降级,不影响其它功能。

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

**评审模型配置**(`<agent-dir>/pi-toolkits-review.json`,默认 `~/.pi/agent/`):

```json
{ "model": "anthropic/claude-sonnet-4" }
```

- `/review-model` —— 查看/更换评审模型:弹出模型列表(标题显示当前配置),选中即写入;取消则不修改配置
- **未配置 / 配置的模型已不可用**(如在 pi 的 models.json 里删掉了该模型)→ 提示「评审模型不存在」,弹出**可用模型选择列表**(与 `/model` 同源);选中后**写回配置并立即执行**
- 任务仍在进行中(agent 未空闲)时触发 → 提示等待,不执行;同一时间只允许一个评审
- footer 出现灰色 `review` 状态 = 已配置评审模型

---

## 🛠️ 开发 Development

<a name="development"></a>

**pnpm is the only supported toolchain** — never use `npm install` / `npm publish` in this repo.

```bash
pnpm install      # install deps
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (all feature unit tests)
```

### 项目结构 Project structure

```text
src/
├── index.ts              # entry point: aggregates feature modules
├── lib/                  # shared infrastructure (tool-set snapshot/restore)
└── features/             # feature modules — one directory per feature
    ├── ask/              # ask mode: command + state machine, bash sandbox,
    │                     #           system prompt banner, tests
    ├── favorites/        # model favorites: selector + cycle patches,
    │                     #           persisted store, tests
    ├── review/           # third-party review: input/command triggers,
    │                     #           review-model config store, prompt, tests
    └── stash/            # prompt stash: hotkey state machine + tests
```

**新增功能 · adding a feature**:create `src/features/<name>/` exporting `registerXxx(pi)` and call it from `src/index.ts`. Existing modules stay untouched. Each feature ships its own `*.test.ts` (vitest) — keep them deterministic (inject clocks/state, no real agent-dir writes).

**发布 · publishing**(pnpm-only,one command):

```bash
pnpm release patch   # 0.1.2 → 0.1.3
pnpm release minor   # 0.1.2 → 0.2.0   (patch zeroed)
pnpm release major   # 0.1.2 → 1.0.0   (minor + patch zeroed)
pnpm release patch --dry-run   # preview without changing anything
```

`release` 要求且仅要求 `major | minor | patch` 之一;上级递增清零下级。执行链:校验 → `typecheck + test` 门禁 → 改版本 → git commit + `vX.Y.Z` tag → `pnpm publish`(`prepublishOnly` 二次门禁)。

---

## 🤝 贡献 Contributing

<a name="contributing"></a>

PRs and issues welcome. A few conventions:

- **pnpm only** — never `npm install` / `npm publish`; use `pnpm add` / `pnpm publish`
- **Feature-module pattern** — one directory per feature (`src/features/<name>/`), export `registerXxx(pi)`, register in `src/index.ts`; shared infra goes in `src/lib/`
- **Tests** — every feature ships vitest cases; keep them deterministic (injectable clocks/state), no writes to the real agent dir
- **Built-in patches** (favorites) must stay **version-guarded and idempotent** — verify the target prototype members exist before patching, guard against double-apply, degrade with a `console.warn` instead of breaking the extension
- **Keybindings** — before picking a new shortcut, check pi defaults + reserved keys, terminal control chars, and OS/terminal-emulator grabs; prefer `ctrl+alt+<letter>` for cross-platform safety
- **Quality gate** — `pnpm typecheck && pnpm test` must pass before submitting

---

## 📄 License

<a name="license"></a>

MIT © 2026 Andares Cui. See [LICENSE](LICENSE).
