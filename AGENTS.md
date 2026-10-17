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

**核心纪律：兼容区间是实测结论，不是愿望。** 下限 = 「最近 4 个已发布中版本线」
中最旧的一条（尽量支持）；上界 = 最新线 + 8 条中版本（向后探针的硬上限，再晚不宣称）；
区间内每个已发布版本都要真的跑绿，README 与源码注释标注「实测支持到 X」。
（当前 `>=1.0.0 <1.12.0`：窗口 1.0 / 1.1 / 1.2 / 1.3，探针 1.4 … 1.11，
**实测支持到 1.3.0**；0.88–0.98 从未发布，0.87.x 与 0.99.x 均因窗口滑出而下调。）

- **窗口纪律**：下限只能随窗口滑动抬升，且每次抬升必须在提交信息里写明
  「老版本为何不再支持」的实测结论——是政策下调就明说政策下调，别编不兼容。
  历史：0.86.x → 0.87.x（2026-10-10，1.1 发布）→ 0.99.x（2026-10-13，1.2 发布）
  → 1.0.x（2026-10-17，1.3 发布）。README 的 Requirements 段、badge、
  源码注释里的「已验证区间」都随区间同步修改。
- **peer 声明规则**（pi ≥ 0.99 启动时校验）：宿主提供的包（`@earendil-works/pi-*`）
  **只能**放进 `peerDependencies`，进 `dependencies` 会被 pi 告警
  「Host-provided extension packages must be declared in peerDependencies」。
  其中 `pi-tui` 用 `"*"`（运行时由宿主 virtual modules 重定向到宿主副本，值导入
  也不需要 `dependencies`）；`pi-coding-agent` 用实测支持区间——pi 托管安装禁用
  peer 解析（`--legacy-peer-deps` / `--omit=peer`），区间不参与安装求解，只作兼容声明。
  该区间的值不要手工推演：下限 = 窗口最旧版本、上界 = 最新线下一条 + 8 条线的下一条，
  由 `pnpm check:compat` 校验（不一致直接判失败）。
  （规则按 pi 1.3.0 源码核实：`resource-loader.js` 只校验 `dependencies` 成员，
  peer 区间不被检查；pi 升级时重新确认。）

### 一条命令跑完纪律：`pnpm check:compat`

`scripts/check-compat.mjs` 从 npm 枚举已发布版本、自己推导目标集合，逐版本验证：

| 集合 | 范围 | 判定 |
| --- | --- | --- |
| window | 最近 4 条中版本线内**全部已发布版本** | 任一红 = 破坏承诺：修，或带实测理由抬下限 |
| forward | 最新线之后最多 8 条线（默认 1.4 … 1.11）里**已发布**的版本 | 红 = 早期预警，**不得据此改区间**，先上报决策 |

每个版本跑：`pnpm install`（`@earendil-works/*` 家族用 `overrides` 钉在宿主同版本）
→ `tsc --noEmit` → `vitest run` → `check-keybindings`（`PI_HOST_PKG` 指向该沙箱）
→ 对 patch/mirror 目标的宿主 dist 文件做哈希比对（基线 = 最新窗口版本）。
脚本同时校验 `package.json` 的 peer 区间 == 策略推导值（下限 = 窗口最旧版本，
上界 = 最新线下一条 + 8 条线的下一条），不一致即失败——**区间必须跟着窗口走**。

- `--skip-tests`（只装 + dist + 键位，快速回归）、`--versions a,b`（只测指定版本）、
  `--keep`（保留沙箱排查）、`--window/--forward`（显式改策略旋钮）
- 沙箱落在 `os.tmpdir()`：**不要在 `/mnt/c` 等 Windows 挂载盘上跑 pnpm/vitest**，
  那里 1 秒的测试要跑 2 分钟（I/O 慢两个数量级）
- 家族钉版本的由来（2026-10-13 实测）：老宿主的 `^1.0.x` 依赖会把 `pi-codemode`
  等兄弟包浮动到最新版，而新版删掉了老宿主 dist 仍在 import 的
  `MCP_TYPESCRIPT_PREAMBLE`，vitest 在 import 阶段就炸——那是上游浮动解析的噪声，
  不是宿主兼容性问题。`overrides` 必须写在 `pnpm-workspace.yaml`（pnpm 12 不再读
  package.json 的 `pnpm` 字段，写了会静默失效），脚本按此生成沙箱配置。
- 脚本报「resolved X, expected Y」或「deps floated」= 该次验证无效，先修沙箱再谈结论。

**脚本测不到、必须人工补的三件事：**

1. **判断 dist 漂移的性质**——脚本只报「哪些文件与基线不同」，不判断是否影响我们，
   要人读 diff。重点：运行时 patch 目标 `ModelSelectorComponent`
   （`modes/interactive/components/model-selector.js`）与 `AgentSession.cycleModel`
   （`core/agent-session.js`）、镜像源 `core/compaction/{compaction,utils}.js`、
   以及我们 import 的扩展 API 类型（先例：1.2.0 把 `BeforeAgentStartEvent` 拆成
   user/custom 判别联合、`ToolInfo` 新增 `reachesTools`；1.3.0 只新增
   `supportsMidConvoEffort`/`sessionShareDestination` 与 `formatReadLineRange` 导出，
   全为增量）。取 tarball 用 `npm pack <pkg>@<ver>`（只下载不解包安装，不属
   Package Management 禁止的 install/publish；不要用 `npx`）。
2. **真实 pi 冒烟加载**：
   `pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'`
   ——无 Extension 警告、正常回包。沙箱跑的是 mock，冒烟才是真宿主加载路径。
3. **真机按一次键**——宿主表空闲 ≠ 机器层空闲（见下节）。

**键位冲突检查义务（每次宿主升级必跑，结论必须上报）：**

pi 升级本身就能把「我们没动过的键」变成死键——先例一：`favorites` 的 `ctrl+f`。
pi 1.0 起 `tuiMode` 默认 `fullscreen`（0.87–0.99 默认 `regular`），fullscreen 下
`TuiAltScreen.handleViewportInput()` 先于对话框消费 `tui.altScreen.search`，而该绑定在
Windows/WSL 上解析为 `ctrl+f` —— 于是选择器永远收不到按键。**升级前能用 ≠ 升级后能用，
「我机器上按一下」不算验证。**

先例二：`ctrl+alt+f` 在 pi 层全绿（脚本审计通过、字节可区分），却被 Windows 侧
截图工具作为全局热键截走——**宿主表空闲 ≠ 机器层空闲**。候选键除了跑脚本，
还必须在真机按一次，确认按键真的到得了应用。

**冲突/疑似冲突发现后的顺序：先上报崔总，再动键。** 升级时若矩阵的 keys 列出现
红项，或真机按不出来，升级这一轮只做「发现 + 候选键审计 + 影响面」——换键是产品决策
（键位族、记忆点、机器层习惯都参与），等崔总定。上报内容至少包含：哪个键、被谁在哪层
消费（tier + 具体 binding id）、`pnpm check:keybindings <候选...>` 的候选审计结果。

- **跑 `pnpm check:keybindings [候选键...]`**：它用宿主自己的 `matchesKey` + 已解析键位表
  （含平台/WSL 差异与用户 `keybindings.json`）核对插件声明的每个键；新增键位时把候选键
  一并传入审。审的是 `devDependencies` 里那版宿主；要审别的版本就传
  `PI_HOST_PKG=/abs/path/to/@earendil-works/pi-coding-agent`——**必须指向装好的副本
  （有 `node_modules`）**，解包 tarball 里 dist 会因缺 pi-tui 而 import 失败；
  该失败是硬错误（旧行为是静默改用仓库那版宿主却照报目标路径，会毁掉审计证据）。
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
  - **全局快捷键（`registerShortcut`）**：优先 `ctrl+alt+<字母>`——pi 层整个 1.0→1.3
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
`favorites` 的两个 patch 复刻内建语义——pi 升级时看矩阵里的 dist 漂移列，
对 `core/compaction/compaction.js`、`core/compaction/utils.js`、`model-selector.js`、
`agent-session.js` 逐文件 diff，有变化就同步代码或改正注释里的版本声明（注释中的
「已验证区间」必须与 peer 下限一致；当前 1.0.0 → 1.3.0：`compaction.js` 与
`usage-totals.js` 全窗口字节级不变，`utils.js` 最后一次变化是 1.2.0，
`agent-session.js` 1.3.0 只改了 tool-restore 路径）。注意 `compact` 的
`serializeConversation` 是**从宿主导入而非镜像**，自动跟随宿主实现：1.2.0 起它不再把
assistant thinking 写进摘要请求（thinking 可能不在模型活动上下文里，会让请求比被摘要
内容还大）。升级 diff 到这类变化时，确认「跟随宿主」仍是预期行为，并同步 README/
注释里对它的描述。

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
- 远端 tag 校验用的是**紧随推送之后的一次 `ls-remote`**，而 GitHub 的 ref 可见性
  可能滞后——v0.7.3 发布时就出现过「tag 实际已推成功、校验却报不存在」。看到
  「远端 tag 不一致」**先手动 `git ls-remote origin refs/tags/vX.Y.Z` 复核**：
  哈希一致就说明只是竞态，此时**不要**按提示 force-push（会把同一个 tag 重推一次），
  直接手动补建 Release 即可（payload 与脚本一致：
  `{"tag_name":"vX.Y.Z","name":"vX.Y.Z","generate_release_notes":true}`）。
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

### 已验证的技术事实（pi 1.2.0 源码，agent-session.js）

1. `sendUserMessage("/cmd args")` 走 `prompt()` → `_tryExecuteExtensionCommand()`：
   **扩展命令被立即执行，不发给模型**，streaming 中也可执行。1.2.0 把 prompt 内的
   「准备消息 + 启动 run」重构成 `_prepareRun`/`_startRun`，但扩展命令分支仍是最前的
   同一条早退路径；`sendUserMessage` 与 `_tryExecuteExtensionCommand` 两函数在
   0.99.0–1.2.0 全区间逐字节一致。
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
- `sendUserMessage` 的 "/cmd" 触发语义在 0.99–1.2 全区间成立（`_tryExecuteExtensionCommand`
  与 `sendUserMessage` 包装逐字节一致，矩阵 typecheck/test + 真实冒烟已过；
  2026-10-13 随窗口迁移复核）
- 与 pi-add-dir 的 session_start 顺序：命令执行时 pi-add-dir 必已完成注册
  （扩展加载先于全部 session_start）预期无问题，冒烟确认

### 实施落位

- `src/features/autostart/index.ts`，与 ask/compact/favorites/review/stash 同构
- `src/index.ts` 注册；package.json keywords 加 autostart
- 未来新 section（[session].env、[model] 等）按需扩展，不预设
