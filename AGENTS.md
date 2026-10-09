# pi-toolkits Project Guidelines

## Package Management

- **This project uses `pnpm` as the sole package manager.**
- Use pnpm equivalents for everything:
  - `pnpm install` / `pnpm add -D <pkg>` / `pnpm remove`
  - `pnpm publish` (never `npm publish`)
  - `pnpm dlx <pkg>` instead of `npx`
  - `pnpm typecheck` / `pnpm test` for scripts
- Do **not** run `npm install`, `npm publish`, `npx`, or `npm whoami` in this
  project — always use the pnpm form.

## pi 宿主兼容

**核心纪律：兼容区间必须覆盖「最近 4 个已发布中版本线」，且每次改动宿主依赖或
宿主内部 API 都要重跑验证。**（当前区间 `>=0.87.0 <2.0.0`，覆盖 0.87 / 0.99 /
1.0 / 1.1 —— 0.88–0.98 从未发布。）

- **窗口纪律**：兼容下限必须 **≤「最近 4 个已发布中版本线」中最旧的一条**（不能只支持最新几版）。
  随着 pi 发布新的中版本，窗口滑动时方可抬升下限：1.1 发布后，最近 4 条变为
  1.1 / 1.0 / 0.99 / 0.87，下限已从 0.86.x 抬到 0.87.x（2026-10-10）；下次 1.2
  发布后最近 4 条将变为 1.2 / 1.1 / 1.0 / 0.99，下限方可再抬到 0.99.x，
  但仍不得提前抬到 1.0。
  下限的每次抬升必须在提交信息里写明「老版本为何不再支持」的实测结论。
  README 的 Requirements 段与该区间必须同步修改。
- **peer 声明规则**（pi ≥ 0.99 启动时校验）：宿主提供的包（`@earendil-works/pi-*`）
  **只能**放进 `peerDependencies`，进 `dependencies` 会被 pi 告警
  「Host-provided extension packages must be declared in peerDependencies」。
  其中 `pi-tui` 用 `"*"`（运行时由宿主 virtual modules 重定向到宿主副本，值导入
  也不需要 `dependencies`）；`pi-coding-agent` 用实测支持区间——pi 托管安装禁用
  peer 解析（`--legacy-peer-deps` / `--omit=peer`），区间不参与安装求解，只作兼容声明。
  （规则按 pi 1.1.0 源码核实：只校验 `dependencies` 成员，不校验 peer 区间；pi 升级时重新确认。）

**改 pi 依赖或动用宿主内部 API 时的验证义务（三步全做）：**

1. **区间内全部已发布版本比对宿主 dist**：解包 tarball 后 diff 受影响的内建文件，
   重点盯运行时 patch 目标 `ModelSelectorComponent`
   （`modes/interactive/components/model-selector.js`）与 `AgentSession.cycleModel`
   （`core/agent-session.js`）。取 tarball 可用 `pnpm view <pkg> dist.tarball` + `curl`，
   或 `npm pack <pkg>@<ver>`（只下载不解包安装，不属 Package Management 禁止的
   install/publish；不要用 `npx`）。
2. **多版本矩阵 typecheck + 测试**：至少在区间端点与最新版上跑 `pnpm typecheck`
   与 `pnpm test`。矩阵做法：复制仓库到 **Linux 本地盘**（`/tmp`），逐版本改
   `devDependencies` 后安装验证；**不要在 `/mnt/c` 等 Windows 挂载盘上跑
   pnpm/vitest**——那里 1 秒的测试要跑 2 分钟（I/O 慢两个数量级）。
3. **真实 pi 冒烟加载**：
   `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'`，
   要求无 Extension 警告、正常回包。

**键位冲突检查义务（每次宿主升级必跑，独立于上面三步）：**

pi 升级本身就能把「我们没动过的键」变成死键——先例一：`favorites` 的 `ctrl+f`。
pi 1.0 起 `tuiMode` 默认 `fullscreen`（0.87–0.99 默认 `regular`），fullscreen 下
`TuiAltScreen.handleViewportInput()` 先于对话框消费 `tui.altScreen.search`，而该绑定在
Windows/WSL 上解析为 `ctrl+f` —— 于是选择器永远收不到按键。**升级前能用 ≠ 升级后能用，
「我机器上按一下」不算验证。**

先例二：`ctrl+alt+f` 在 pi 层全绿（脚本审计通过、字节可区分），却被 Windows 侧
截图工具作为全局热键截走——**宿主表空闲 ≠ 机器层空闲**。候选键除了跑脚本，
还必须在真机按一次，确认按键真的到得了应用。

- **跑 `pnpm check:keybindings [候选键...]`**：它用宿主自己的 `matchesKey` + 已解析键位表
  （含平台/WSL 差异与用户 `keybindings.json`）核对插件声明的每个键；新增键位时把候选键
  一并传入审。审的是 `devDependencies` 里那版宿主；要审正在运行的那份就传
  `PI_HOST_PKG=/abs/path/to/@earendil-works/pi-coding-agent`（矩阵仓库同法）。
- **判定口径**（脚本按 pi-tui 真实分发顺序建模，注释里有依据）：
  - 🔴 不可接受：被 `tui.altScreen.search` 无条件消费；或非 kitty 终端下 legacy 字节等于
    可打印字符（`shift+f` = `"F"`，会偷走搜索框的输入）。有 🔴 就是死键，必须换键。
  - 🟠 可接受但不依赖：仅会话记录搜索框聚焦时才生效（`searchNext/Previous/Close`），
    对话框打开期间不生效。
  - 🟡 仅在选择器作用域内可接受：`tui.editor/input/select.*` 的绑定会被我们的
    `patch-selector` 遮蔽（先于搜索框消费）。**全局快捷键（`registerShortcut`）不得与
    宿主任何绑定重叠**，只能选完全空闲的键。
  - 🔵 需人工判断屏属（`app.*`、其余 `tui.altScreen.*`，多为树/会话/滚动屏幕专用）。
- **键位族选择**（按作用域分两类）：
  - **全局快捷键（`registerShortcut`）**：优先 `ctrl+alt+<字母>`——pi 层整个 0.87→1.1
    区间只被 `ctrl+alt+]` 占用，且 `ESC + ctrl-<字母>` 编码不依赖 kitty 协议。但
    Windows 侧截图/效率工具常绑 `ctrl+alt+<字母>`（先例二），Windows Terminal 默认占
    `ctrl+v`（粘贴）与 `ctrl+shift+f`（查找）——定键后必须真机试按。
  - **选择器作用域键**：可选「仅 🟡 遮蔽 `tui.editor/input/select.*`」的 `ctrl+<字母>`
    ——patch 在选择器内先于搜索框消费，编辑器等其它场景不受影响（先例：favorites
    的 `ctrl+a`，遮蔽的只是搜索框内的行首跳转）。注意 legacy 字节恒等：`ctrl+i` ≡ Tab
    （选择器内置的 scope 切换）、`ctrl+m` ≡ Enter（确认）——这类键不可选；
    `ctrl+j` ≡ LF 属可接受遮蔽（搜索框里换行无意义）。
- 键位变动的依据（为何不选其它候选：如 `ctrl+f` 被上游消费、`ctrl+alt+f` 被截图工具
  占、`ctrl+v` 是 Windows Terminal 粘贴、`ctrl+i` ≡ Tab）必须写在键位常量旁的注释里，
  并在 README「Implementation notes / 键位」段落同步。

**内建行为同步义务**：`compact` 的摘要 prompt 与预算公式逐字复刻 pi 内建实现，
`favorites` 的两个 patch 复刻内建语义——pi 升级时 diff
`core/compaction/compaction.js`、`core/compaction/utils.js`、`model-selector.js`、
`agent-session.js`，有变化就同步代码或改正注释里的版本声明（注释中的「已验证区间」
必须与 peer 下限一致）。

## Release

- **前置条件：工作区必须干净**——release 提交只含版本号（`git add package.json`），
  有未提交变更时脚本会在任何改动前直接中止。否则未提交内容会被打包进 npm
  包（pnpm 从工作区打包）却不进 tag，造成「tag 内容 ≠ 实际发布内容」
  （v0.4.0 事故）
- `pnpm release <patch|minor|major> [--dry-run]` 一键发布：干净检查 →
  typecheck+test → bump → commit + tag（`scripts/tag-current.mjs` 打
  `vX.Y.Z`，已存在则跳过）→ **自检：tag == HEAD 且工作区干净**（否则中止）
  → `pnpm publish`（失败即中止，版本已锚定）
  → **npm 成功后**：只推当前分支 + 当前 tag（`git push origin <分支>` +
  `git push origin refs/tags/vX.Y.Z`，不再 `--tags`）→ **校验远端分支/tag
  哈希与本地一致**；远端 tag 不一致 → 跳过 Release 创建并给出修复命令
  → 创建 GitHub Release `vX.Y.Z`（仅在远端 tag 校验通过后；best-effort，不中止）
- GitHub Release 依赖 `GITHUB_TOKEN` 环境变量（fine-grained token，
  Contents: write）；未设置时只提示。创建失败（403/422/网络等）后脚本会
  自动 `GET /releases/tags/{tag}` 查询确认：200 = 已存在（并发/重试/手动
  补建过）→ 视为成功跳过；404 = 真失败 → 提示可稍后手动补建，均不影响
  npm 已发布的结果
- `pnpm tag-current` 可独立使用：给当前版本打本地 tag（已存在跳过，不推送）
- 发布失败回滚：`git tag -d vX.Y.Z && git reset --hard HEAD~1`
- 需要覆盖远端 tag（如本地 tag 已重指）时：
  `git push origin refs/tags/vX.Y.Z --force`

## Feature: autostart（已实现，待随下个版本发布）

2026-10-07 立项。会话启动自动化：项目内配置文件声明启动时要执行的斜杠命令，
首批用例是 /add-dir 持久化（多仓库工作区的第一步）。决策均已崔总确认：

- **扩展名**：`autostart`（生态 auto- 前缀惯例：auto-compact、auto-naming-session）
- **配置位置**：`<项目根>/.pi/autostart.toml`（随项目进 git；.pi/ 目录是官方项目级配置惯例，先例 .pi/mcp.json）
- **执行时机**：仅 `session_start.reason ∈ {startup, new, fork}`；resume 不重放（会话分支已恢复 add-dir 状态）

### 配置 schema

```toml
# .pi/autostart.toml
version = 1

[session]
# 按序执行的扩展命令（仅扩展命令，见约束）
run = [
  "/add-dir ../shop-frontend",
  "/add-dir ../shop-api",
]
```

解析器选 `smol-toml`（零依赖、~10KB、TOML 1.0、活跃维护），
加入 dependencies（先例：@dreki-gg/pi-command-sandbox）。

### 已验证的技术事实（pi 1.1.0 源码，agent-session.js）

1. `sendUserMessage("/cmd args")` 走 `prompt()` → `_tryExecuteExtensionCommand()`
   （~L1522）：**扩展命令被立即执行，不发给模型**，streaming 中也可执行
2. **只能支持扩展命令**（/add-dir、/cd、/skill:xxx 等 registerCommand 注册的）；
   内置命令（/compact、/reload、/resume）走 TUI 层，扩展层触发不了；
   skill 命令是展开机制非执行机制——此约束必须写进 README
3. `SessionStartEvent.reason`: `"startup" | "reload" | "new" | "resume" | "fork"`
   （types.d.ts `SessionStartEvent`）——时机过滤的依据
4. `ctx.isProjectTrusted()` 可用——未信任目录不自动执行命令（安全默认，
   与 permission-system 的 project scope gating 同哲学）
5. pi-add-dir 自带 Already added 幂等检查，重复重放不会翻车

### 执行流程

```text
session_start(reason 过滤)
  → 读 <cwd>/.pi/autostart.toml（无文件静默跳过）
  → ctx.isProjectTrusted() 校验
  → 逐条命令：预校验命令名存在于注册表 → pi.sendUserMessage(cmd)
  → 结果 notify / 错误日志
```

### 关键风险（M1 必验）

- **命令不存在时文本会作为普通消息发给模型**（跑偏风险）——必须预校验命令名；
  预校验 API 待查（注册表枚举接口，M1 第一件事）
- `sendUserMessage` 的 "/cmd" 触发语义在 0.87–1.1 全区间成立（`_tryExecuteExtensionCommand`
  与 `sendUserMessage` 包装逐字节一致，矩阵 typecheck/test + 真实冒烟已过；
  2026-10-10 随窗口迁移复核）
- 与 pi-add-dir 的 session_start 顺序：命令执行时 pi-add-dir 必已完成注册
  （扩展加载先于全部 session_start）预期无问题，冒烟确认

### 实施落位

- `src/features/autostart/index.ts`，与 ask/compact/favorites/review/stash 同构
- `src/index.ts` 注册；package.json keywords 加 autostart
- 未来新 section（[session].env、[model] 等）按需扩展，不预设
