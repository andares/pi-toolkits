# pi-toolkits Project Guidelines

## 记忆与索引

本仓按 agent-framework v1 放东西：给 agent 看的记忆在 `.agents/`，计划在 `specs/`（人审）。

| 想知道 | 读 |
| --- | --- |
| 记忆的写规则、预算、压缩办法 | `.agents/memory/README.md`（契约，写之前先读） |
| 分层、版本基线、仍生效的决策记录 | `.agents/memory/ARCHITECTURE.md` |
| 已收口的里程碑（摘要 + 证据指针） | `.agents/memory/FINISHED.md` |
| 延期项与各自的触发条件 | `.agents/memory/FUTURE.md` |
| 还要做什么、欠着什么债 | `specs/PLAN.md` |
| 改过什么、证据在哪 | `.agents/implementations/`（一次一记，不改写） |

本文件只放：不变量、命令、宿主兼容纪律、各 feature 的现行规格与已验证结论。AGENTS.md 当前超预算，
压缩计划（按章节列了去处）记在 `specs/PLAN.md`。

## Package Management

- **This project uses `pnpm` as the sole package manager.**
- Use pnpm equivalents for everything:
  - `pnpm install` / `pnpm add -D <pkg>` / `pnpm remove`
  - `pnpm publish` (never `npm publish`)
  - `pnpm dlx <pkg>` instead of `npx`
  - `pnpm typecheck` / `pnpm test` for scripts
- Do **not** run `npm install`, `npm publish`, `npx`, or `npm whoami` in this
  project — always use the pnpm form. **One exception, in CI only**: the release
  workflow publishes with `npm publish` because pnpm's own OIDC exchange is
  rejected by the registry (see Release); that token never touches this machine
  and no dependency is installed with npm there.

## 文案语言（不变量）

- **运行时能看到的文本一律英文**：`ctx.ui.notify`、选择器标题/选项、footer 状态、拒绝理由与
  审计报告、工具声明（`description` / `promptGuidelines` / 参数描述）、发给模型的提示词
  （如 `REVIEW_PROMPT`、`scratchpad` 声明）与系统提示横幅。测试断言写对应英文子串。
- **全仓禁止对模型的语言指令（每一字节）**：不得在任何提示词、工作单、落盘字段里要求模型
  用某种语言写文件或沟通——语言由模型自判（看项目文档自然跟随）。库内文案用英语是我们
  自己的输出选择，不是对模型的要求（2026-11-06 崔总定稿；init 曾在工作单里写
  `Prose language for anything you write: English.`、在 state.toml/plans 落盘 `lang`/
  `language` 字段，模型把它们连成「用英语」的证据链，全部清除并加了 `/ask-init scrub`）。
- 中文只保留在：源码注释、`README.zh-CN.md`、`AGENTS.md` 与本仓内部维护脚本；以及 init 按
  `--lang` 渲染的框架生成文件（见 Feature: init）。

## 设计稿（`design/`）

界面设计稿的唯一目录是仓库根的 `design/`（没有就建），格式一律 `.ptr`，文件名 `<feature>.ptr`
（一块 board 一个界面）。`design/` 与其中的设计系统文件一起进 git，但不进构建产物。

- **只走 paintress**（MCP `paintress_*` / CLI `paintress`）。`design/__preset.ptr` 与
  `design/__components.ptr` 是 paintress 维护的项目设计系统（token / 组件库），**不手写、不挪走、
  不改成 `.pen`**；画之前先 `preset list` + `component list`，能用 token 就不贴裸值。
- 开工先 `paintress web`（幂等）；改完 `validate`（errors 必须 0）并 `screenshot` 自己看一眼；
  收工 `paintress_clear_changes`。
- **设计稿不是运行时资产**：先给崔总看截图/查看器，他确认后才改 `ui/` 下的实际代码。
- board 内文案用英文（与运行时文案同语言），中文只放在看板的说明注释里。

## pi 宿主兼容

**核心纪律：兼容区间是实测结论，不是愿望——而且只能往回测。** 上游只会向前发版，
未来版本尚不存在、无从验证，所以对未来的任何“兼容到 X”都是无据的许愿，**不进声明**。
策略是两条方向相反的规则：

1. **强制窗口 = 最近 4 条已发布中版本线**：窗口内每个已发布版本必须绿。做不到就改
   我们自己的代码——硬编码老形状、继续用即将废弃但还能用的宿主接口，无论用什么办法。
   **窗口红不是抬下限的理由**（抬下限 = 对使用者毁约）。
2. **向后探针 = 窗口之下再最多 4 条线（合计 8 条）**：窗口绿了以后继续往更老的方向
   探。能兼容就继续往下，**一旦某条线兼容不上就停在那里，不为它改代码**。

**对外只展示一个数：实际兼容下限（public floor）** = 从最新已发布版本向下**连续全绿**的
最老版本。使用者不需要知道 4 版强制政策，只需要知道 `pi >= <floor>`。它写进
`peerDependencies`（`>=<floor>`，**不写上界**）和 README 的 Requirements / badge。

**对外文案的写法（与内部政策严格分开）**：宣传面只给「实测结论」——`pi >= <floor>`、
已验证区间 `<floor> – <最新实测版本>`、无上界；**窗口 / 探针 / 「窗口红改代码不抬下限」
这一整套内部规则只住在本文件**，不得写进 README（含 Requirements、命令速查、贡献者须知）、
CHANGELOG、npm description/keywords 等任何对外文案。理由：这些规则是我们的工作方式，
对使用者既无用又会被读成承诺（一旦某轮窗口因故未跑满，用户会当成毁约而不是维护节奏）。

（当前：强制窗口 1.3 / 1.4 / 1.5 / 1.6，1.5 线含 1.5.0、1.5.1 与 1.5.2，1.6 线含 1.6.0 与 1.6.1；向后探针
1.2 / 1.1 / 1.0 / 0.99 **四条线全绿**（矩阵每版 1064 项全过，无跳过），0.99 已是探针额度的最老一线；再往下的
0.87.x 在上一轮探到并**停在 0.87.x**——0.87 的 `ToolDefinition` 没有 `defaultActive`（`ask/scratch-tool` 与
`init/tool` 两处），且 `ToolCallEvent` 上没有 `parentToolCallId`（2026-10-24 审批日志、
2026-10-26 init 新增的依赖），typecheck 红属探测结论、不改代码（本轮探针额度已满，未重探）；
**public floor = 0.99.0**，peer 写 `>=0.99.0`，实测覆盖 0.99.0 → 1.6.1。）

- 窗口每随一条新版本线发布向前滑一格（窗口恒定 4 条），掉出窗口的老线不是“坏了”，
  只是不再被强制保持绿色；它还在不在对外下限里，由**探针**说话：探得到就继续算兼容，
  探不到就停。历史：0.86.x → 0.87.x（2026-10-10，1.1 发布）→ 0.99.x（2026-10-13，
  1.2 发布）→ 1.0.x（2026-10-17，1.3 发布）→ 1.1.x（2026-10-23，1.4 发布）→
  1.2.x（2026-11-04，1.5 发布）→ 1.3.x（2026-11-20，1.6 发布）。
  README 的 Requirements 段、badge、源码注释里的「已验证区间」都随实测结果同步修改。
- **peer 声明规则**（pi ≥ 0.99 启动时校验）：宿主提供的包（`@earendil-works/pi-*`）
  **只能**放进 `peerDependencies`，进 `dependencies` 会被 pi 告警
  「Host-provided extension packages must be declared in peerDependencies」。
  其中 `pi-tui` 用 `"*"`（运行时由宿主 virtual modules 重定向到宿主副本，值导入
  也不需要 `dependencies`）；`pi-coding-agent` 用实测支持区间——pi 托管安装禁用
  peer 解析（`--legacy-peer-deps` / `--omit=peer`），区间不参与安装求解，只作兼容声明。
  **`typebox` 同样是宿主提供包**（`resource-loader.js` 的 `HOST_PROVIDED_EXTENSION_PACKAGES`
  同时含 `typebox` 与 `@sinclair/typebox`）：`peerDependencies: "*"` + `devDependencies`
  放具体版本供 typecheck，进 `dependencies` 会触发同一条告警（2026-10-23 按 1.4.0 源码
  复核：`core/resource-loader.js` 自 1.3.0 起字节级未变）。
  peer 区间 = `>=<public floor>`，**没有上界**——上界只能是“兼容到未来某版”的许愿，
  而我们没有能力兼容未来版本。不要在区间里手推任何与 probe 无关的数字；
  下限由 `pnpm check:compat` 算出并校验（不一致直接判失败）。
  （规则按 pi 1.4.0 源码核实：`resource-loader.js` 只校验 `dependencies` 成员，
  peer 区间不被检查；pi 升级时重新确认。）

### 一条命令跑完纪律：`pnpm check:compat`

`scripts/check-compat.mjs` 从 npm 枚举已发布版本、自己推导目标集合，逐版本验证：

| 集合 | 范围 | 判定 |
| --- | --- | --- |
| window（强制） | 最近 4 条中版本线内**全部已发布版本** | 必须全绿；红 = **改我们的代码**（硬编码/沿用老接口），**不得抬下限** |
| probe（只探测） | 窗口之下最多 4 条线（合计 8 条），按线从新到老走 | 红 = **停**，不为它改代码；绿就继续往下 |
| public floor | 从最新版本向下连续全绿的最老版本 | 写进 peer（`>=floor`）与 README，是使用者唯一看到的数 |

每个版本跑：`pnpm install`（`@earendil-works/*` 家族用 `overrides` 钉在宿主同版本）
→ `tsc --noEmit` → `vitest run` → `check-keybindings`（`PI_HOST_PKG` 指向该沙箱）
→ 对 patch/mirror 目标的宿主 dist 文件做哈希比对（基线 = 最新窗口版本）。
脚本校验 `package.json` 的 peer 区间 == `>=<实测下限>`，不一致即失败——**声明必须跟着实测走**。

- `--skip-tests`（只装 + dist + 键位，快速回归）、`--versions a,b`（只测指定版本，跳过策略判定）、
  `--keep`（保留沙箱排查）、`--window/--probe`（显式改策略旋钮，默认 4/4）
- 沙箱落在 `os.tmpdir()`：**不要在 `/mnt/c` 等 Windows 挂载盘上跑 pnpm/vitest**，
  那里 1 秒的测试要跑 2 分钟（I/O 慢两个数量级）
- 家族钉版本的由来（2026-10-13 实测）：老宿主的 `^1.0.x` 依赖会把 `pi-codemode`
  等兄弟包浮动到最新版，而新版删掉了老宿主 dist 仍在 import 的
  `MCP_TYPESCRIPT_PREAMBLE`，vitest 在 import 阶段就炸——那是上游浮动解析的噪声，
  不是宿主兼容性问题。`overrides` 必须写在 `pnpm-workspace.yaml`（pnpm 12 不再读
  package.json 的 `pnpm` 字段，写了会静默失效），脚本按此生成沙箱配置。
- 脚本报「resolved X, expected Y」或「deps floated」= 该次验证无效，先修沙箱再谈结论。

### 版本迁移流程（上游发布新版本后逐条执行）

触发条件：`npm view @earendil-works/pi-coding-agent dist-tags` 的 `latest` 变了。

1. **先读上面的策略，不要现场推演区间**：窗口 = 最近 4 条已发布线（强制），探针 = 再往老
   最多 4 条（只探测），对外只有 public floor 一个数。任何「上界 / 兼容到未来某版」都不该
   出现在声明里。
2. **升依赖**：`pnpm add -D @earendil-works/pi-ai@^X.Y.0 \
   @earendil-works/pi-coding-agent@^X.Y.0 @earendil-works/pi-tui@^X.Y.0` → `pnpm install`
   （本项目只用 pnpm；`pnpm-workspace.yaml` 里 pnpm 自己写的字段不要手工改）。
3. **本地门禁**：`pnpm typecheck && pnpm test`。新宿主导致的红属于窗口义务，先修到绿。
4. **跑矩阵**：`pnpm check:compat`（默认 window 4 + probe 4）。它自己从 registry 推导集合、
   沙箱钉家族版本、逐版本 install/tsc/test/键位/dist 哈希，并在 peer 下限与实测不符时判失败。
5. **窗口红 → 改代码，不许改策略**。手段按优先级：① 运行时能力探测（有就用新 API，没有走旧
   路径）；② 类型层兼容（结构化类型 / `satisfies` / 新字段当可选处理）；③ 保留旧 API 调用点。
   **禁止**：删测试、放宽断言、把失败版本移出窗口、抬下限、加「仅旧版本静默跳过」的旁路。
6. **探针红 → 只记录，不改代码**。记下第一个失败版本、首个错误与原因分类（缺字段/类型/行为），
   写进提交信息与 AGENTS.md 的「当前」行；public floor 就停在它上面那条线的最老版本。
7. **dist 漂移人工判读**（脚本只报哈希不同，不判性质）：`npm pack <pkg>@<旧> <pkg>@<新>`
   解包后 diff —— ① 运行时 patch 目标：`modes/interactive/components/model-selector.js`、
   `core/agent-session.js`（`cycleModel`）；② 镜像源：`core/compaction/compaction.js`、
   `core/compaction/utils.js`、`core/usage-totals.js`；③ 我们 import 的扩展 API 类型
   `core/extensions/types.d.ts`。有变化 → 同步代码，或按「两类区间声明」规则改注释。
   pi-tui 也 diff 一次（`components/select-list.js` / `settings-list.js` / `tui-alt-screen.js`）。
8. **真机冒烟**：`pi -p --no-extensions -e ./src/index.ts --tools '' 'Reply with exactly: OK'`
   —— 无 Extension 警告、回 `OK`（1.2+ 起输出被截断会 exit 1，看到非 0 先查这一点）。
9. **键位**：`pnpm check:keybindings`。有 🔴 或真机按不出来 → **只上报崔总，不动键**（见下节）。
   真机把声明的每个键各按一次（当前：`ctrl+a` 选择器内、`ctrl+j` 仅收藏列表、`ctrl+alt+y` 全局）。
10. **同步对外展示（逐项核对，缺一不可）**：

    | 位置 | 要写的内容 |
    | --- | --- |
    | `package.json` → `peerDependencies["@earendil-works/pi-coding-agent"]` | `>=<public floor>`，**无上界** |
    | `README.md` / `README.zh-CN.md` 的 badge | 文案 `pi >= <floor>` + badge URL 里的版本号 |
    | README 的 `Requirements` / `版本要求` | floor + 已验证到的版本范围 + 无上界（**用户向**：不解释 4 版政策） |
    | README 功能段（如 compact 的镜像/预算描述） | 第 7 步的漂移若影响该功能，同步描述 |
    | README 命令速查里的 `pnpm check:compat` 一行 | 只写「校验声明的下限与实测一致 / 可复现该结论」，**不写窗口与探针的数量**（内部政策不进对外文案，见上文「对外文案的写法」） |
    | AGENTS.md 的「当前」行 | 窗口线 / 探针线 / 停在哪个版本及原因 / floor / peer |
    | AGENTS.md「内建行为同步义务」 | 新窗口 + 逐文件变化结论 |
    | AGENTS.md 各 feature 的「已验证」块 | 窗口 + 探针结果 + floor + 测试数 |
    | 源码注释 | 支持声明跟 floor；逐版本事实按实际 diff（两类分开写） |

    **收尾公示（完成判据，不是可选项）**：矩阵跑完后，把**这一轮实测出来的最终兼容范围**
    写到对外可见的地方——`peerDependencies` = `>=<floor>`；README badge 与
    `Requirements` / `版本要求` 首句 = `pi >= <floor>`；同段写明已验证区间
    `<floor> – <最新实测版本>`（每次升级后**重算并改写**，不是累加历史）与「无上界」。
    漏改或留着上一轮的版本号 = 这一轮没做完：对外宣称的区间必须与 `pnpm check:compat`
    的 verdict 逐字对得上（脚本会校验 peer，badge/正文靠人核对）。

11. **提交与发布**：提交信息必须包含：新窗口线、窗口为何绿（或改了哪些代码）、探针停在哪 + 原因、
    public floor 与 peer、对外公示的区间、dist 漂移结论、键位结论、冒烟结果。随后
    `pnpm release patch`（纯兼容性维护走 patch）。

**脚本测不到、必须人工补的三件事：**

1. **判断 dist 漂移的性质**——脚本只报「哪些文件与基线不同」，不判断是否影响我们，
   要人读 diff。重点：运行时 patch 目标 `ModelSelectorComponent`
   （`modes/interactive/components/model-selector.js`）与 `AgentSession.cycleModel`
   （`core/agent-session.js`）、镜像源 `core/compaction/{compaction,utils}.js`、
   以及我们 import 的扩展 API 类型（先例：1.2.0 把 `BeforeAgentStartEvent` 拆成
   user/custom 判别联合、`ToolInfo` 新增 `reachesTools`；1.3.0 只新增
   `supportsMidConvoEffort`/`sessionShareDestination` 与 `formatReadLineRange` 导出，
   全为增量；1.4.0 的 `types.d.ts` 一字未动，但 `compaction.js` 改了摘要输出预算与
   split-turn 的 `/compact <instructions>` 传递 —— 两处都属镜像义务，已同步）。
   取 tarball 用 `npm pack <pkg>@<ver>`（只下载不解包安装，不属
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
`agent-session.js` 逐文件 diff，有变化就同步代码或改正注释里的版本声明。
两类区间声明要分开写：**支持声明**（「supported window」等）必须与 peer 下限一致 /
或注明是强制窗口；**逐版本事实**（某函数在哪个区间字节级一致）按实际 diff 结果写，
不得为了对齐下限而外扩（例如 `compaction.js` 只在这里说 1.4.0 变过一次）。当前窗口 1.3.0 → 1.6.1（1.5.2、1.6.0 与 1.6.1 均未改这三个镜像文件）：
`usage-totals.js` 在窗口内只变过一次（1.5.0 给 `cost` 加了 `totalFromProvider` 合并规则，
已镜像；数值字段未动），`utils.js` 最后一次变化是 1.5.1（`truncateText` 换 `sliceHead`，
只影响我们从宿主导入的序列化器），`agent-session.js` 在 1.2.0（prompt 处理
重构成 `_prepareRun`/`_startRun`）、1.3.0（tool-restore 路径）、1.4.0（溢出恢复与
tool-restore）、1.5.0（摘要请求的 auth 解析改走 stream 函数自带的 runtime；`_applyToolLoadout`
按「保留顺序 + 追加新增」稳定下来，#11495）、1.5.1（五处，见下）各变一次，
但 `cycleModel` 在 1.2.0 → 1.6.1 字节级一致，`compaction.js`
只在 1.4.0 变了一次点——摘要不再按 `reserveTokens` 设 `maxTokens` 上限（#9512），
且 `/compact <instructions>` 也追加到 split-turn 前缀（#11058）；两处都按 1.4.0 语义
镜像到全窗口，注释里写明了为何不做按版本分支。`model-selector.js` 在 1.5.0 变过一次
（翻页键、`capturesViewportInput = true`、模型 id 后的去重品名），`updateList` 的布局已
镜像（品名规则 `getDistinctModelName` 不在包导出面，按源码复刻），翻页键与
`capturesViewportInput` 由宿主自行生效、我们的 prototype patch 不需处理。`types.d.ts`
在 1.5.0 全为增量（`KeybindingHints` 混入 `ToolRenderContext`/`MessageRenderOptions`/
`EntryRenderOptions`、`ui.custom` 的 `blocked`、消息渲染的 `messageId`/`timestamp`）。
pi-tui 1.5.0：`SelectList`/`SettingsList` 新增 `tui.select.pageUp/pageDown` 与
`capturesViewportInput`，`tui-alt-screen.js` 把 `shouldDeferViewportInputToOverlay()` 改名
`shouldDeferViewportInput()` 并让聚焦组件截获视口键——但搜索键分支仍在其**上面**，
所以 `ctrl+f` 对模型选择器依然是死键。注意 `compact` 的
`serializeConversation` 是**从宿主导入而非镜像**，自动跟随宿主实现：1.2.0 起它不再把
assistant thinking 写进摘要请求（thinking 可能不在模型活动上下文里，会让请求比被摘要
内容还大）。升级 diff 到这类变化时，确认「跟随宿主」仍是预期行为，并同步 README/
注释里对它的描述。

1.5.1（补丁线，窗口内新增一个版本）逐文件结论：

- `compaction.js`、`usage-totals.js` 未动；`compaction/utils.js` 只把 `truncateText` 换成
  `sliceHead`（截断不再劈开代理对）——`serializeConversation` 是**从宿主导入**的，自动跟随，
  没有要镜像的字符串。
- `agent-session.js` 动了五处：`sendUserMessage` 的其余部分抽进 `_preparePrompt`
  （`_promptPreflightCount` 预留上下文，#9154），扩展命令分支仍是包装层最前面的早退；
  `_cycleScopedModel`/`_cycleAvailableModel` 抽出 `getNextCycleIndex`，并让「当前模型不在
  列表里」走 forward 第一 / backward 最后（单条目列表也会选中它，#11806）——`cycleModel`
  本身在 1.2.0 → 1.5.1 仍字节级一致，我们的 favorites patch 自带索引逻辑（语义与新 helper
  相同），不受影响；队列中消息的图片改为投递时归一化（#11738）；`_recordSelection` 拆成
  `_recordModelSelection` + `_recordThinkingLevel`（#11451）；`reload()` 在流式/压缩中直接
  抛错，`prompt()` 在压缩中同时拒绝 branch summary 进行中的提交。
- `model-selector.js`：`updateList` 布局一字未动；`filterModels(query, preferredModel)` 多了
  第二个参数，后台刷新落地时保持高亮行（#9109），刷新前先取 `filteredModels[selectedIndex]`
  ——我们的 `filterModels` patch 现在原样转发该参数（1.5.1 之前宿主忽略多余实参），
  否则会把「跳回顶部」的老行为偷偷带回来。
- `types.d.ts` 全为增量/语义澄清：`registerMarkdownTransformer(transformer, options?)`、
  `MarkdownMessageType` 新增 `custom`/`summary`/`changelog`、扩展状态里的
  `markdownTransformer` 变成 `{ transformer, messageTypes }` 注册对象、`ui.custom` 的
  `blocked` 对 overlay 改为「显示到 `done()` 为止」（含 `setHidden()` 期间）。我们都不使用。
- `interactive-mode.js` / `agent-session-runtime.js`：收尾仍是无超时的
  `await runtimeHost.dispose()`；`dispose()` 新增 `await session.abort()` 与
  `await settleCredentialWrites()`，即同一条无界链上又多了两个 await（宿主至今没有收尾
  超时；我们自己的看门狗已于 2026-11-26 移除，见 FINISHED）。
- pi-tui 1.5.1：`SelectList`/`SettingsList`/键位相关文件**一字未动**；变化只有编辑器粘贴占位符
  修复、Markdown/Mermaid、终端图片、光标标记清理，以及 `tui-alt-screen.js` 的 Kitty 图片
  绘制顺序（搜索键分支仍在最上面，`ctrl+f` 依旧是选择器的死键）。键位表唯一变化是
  Windows/WSL 的 `app.clipboard.pasteImage` 变成 `["alt+v", "ctrl+v"]`（与我们三个键无关）。
- 破坏性变更两条均不涉及我们：`GrepOperations.readFile` 不再为上下文行回调（我们没实现
  GrepOperations）；OpenAI 兼容模型在「本轮禁用全部工具」时不再发 `"tools": []`（属宿主行为）。

1.6.0（新窗口线）逐文件结论：

- **三个镜像文件全部未动**：`compaction.js`、`compaction/utils.js`、`usage-totals.js` 与 1.5.2
  字节级相同，`keybindings.js` 也未变——compact 的镜像无需任何同步，键位表无新增冲突。
- `agent-session.js` 三处，均不影响我们：`_restoreToolsFromTranscript` / `setActiveToolsByName`
  新增 `_restoredToolNames`，把「放弃 pending 工具」的条件改成「被停用的工具属于恢复的 loadout」
  （扩展自己新注册、又被停用的工具不再清空 pending；MCP 工具恢复继续生效）；`reload()` 用
  `_extensionsBound` 取代四个字段的猜测来决定是否重发 `session_start(reload)`；
  `getLastAssistantText()` 改为跳过「非正常结束且无文本」的回复（#12119，影响 /copy，对我们无影响）。
  `cycleModel`、`sendUserMessage`、`_preparePrompt`、`_tryExecuteExtensionCommand` 逐函数哈希
  与 1.5.2 一致→ **favorites 的 cycle patch 与 autostart 的命令派发不变**。
- `model-selector.js` 与 pi-tui `settings-list.js` 同一处：搜索框收到光标键时只在 query 真变了才
  重新过滤（光标不再滑动选中行）。我们 patch 的是 `filterModels` 本身及其参数转发，调用点变化
  不改语义；权限面板的 Enter-anywhere 拦截与 SettingsList 的按键无关。
- `types.d.ts` 全为增量：runtime 绑定新增 `reportError(error)`（runner 用它向未失效的会话报错），
  `Component.render` 从 `string[]` 放宽为 `readonly string[]`（pi-tui `tui.d.ts`）。后者是**类型层
  变宽**，但我们的三个自写组件声明 `string[]`，`panel.ts` 里直接返回 `SettingsList.render()` 会在
  1.6.0 报 TS4104——已改为返回副本（`[...]`），两侧类型都成立，不做按版本分支。
- pi-tui `tui-alt-screen.js`：滚动/选中改用新 `requestViewRender()`（复用上一帧组件输出，滚轮不再
  重渲长转抄），`tui.requestRender()` 仍在；kitty 图片在全屏重绘时保留上传。搜索键分支仍在
  `shouldDeferViewportInput()` **之前**（`handleViewportInput` 第 541 行 vs 563 行），所以 `ctrl+f`
  对选择器仍是死键，我们的键位结论不变。
- `interactive-mode.js` / `agent-session-runtime.js`：收尾链仍是无超时的
  `await runtimeHost.dispose()`（交互式路径：drainInput → stop → dispose → flushStdout → exit；
  信号路径仍是先 dispose 后 stop）；新增的只是 `await flushStdout()`。Ctrl+Z 现在也走
  `ui.setSuspendSignalHandler()`（外部 SIGTSTP 同效）。
- 其他：`extensions/runner.js` 只加了上面那个 `reportError`（ask 的拒绝结果路径未动）；
  `resource-loader.js` 只加了包管理器进度回调，`HOST_PROVIDED_EXTENSION_PACKAGES` 仍含
  `typebox` / `@sinclair/typebox` / 四个 `@earendil-works/pi-*` —— peer 声明规则不变。

1.6.1（补丁线，窗口内新增一个版本）逐文件结论（2026-11-26 实测 diff）：

- **三个镜像文件、`keybindings.js`、`model-selector.js` 全部未动**，pi-tui 的 `select-list.js` /
  `settings-list.js` 也未动——compact 镜像与 favorites 的两个 patch 无需任何同步。
- `agent-session.js` 只多一行：bash 结果对象带 `fullOutputError`（宿主工具输出字段，与我们无关）。
- `types.d.ts` 全为增量：`ui.confirm/select/input` 的选项新增 `blockedKind`（OSC 7501 程序状态），
  以及 provider 响应事件的注释改写。我们都不用。
- pi-tui `tui-alt-screen.js`：新增 `RIGHT_CLICK_PASTING_TERMINALS`（vscode / tabby）判断，
  终端自己粘贴时不再合成粘贴。搜索键分支仍在 `shouldDeferViewportInput()` 之前
  （1.6.1 第 548 行 vs 570 行）——`ctrl+f` 对选择器依旧是死键，键位结论不变。

## Release

**发版 = 推 tag。**（2026-11 迁移）`pnpm release` 不再直接写 registry：它做门禁、bump、
commit、打 `vX.Y.Z` tag，然后推分支 + tag；`.github/workflows/publish.yml` 被 tag 触发后
用 **npm trusted publishing（OIDC）** 发布——不需要任何 npm token、不需要交互式 2FA，
并自动附 provenance。工作流里的 `environment: npm` + 文件名 `publish.yml` 是 npm 侧信任
配置的一部分，改名会让发布拿不到凭据。

- **一次性配置（人工，交互式 2FA）**：

  ```bash
  npm trust github @andares/pi-toolkits \
    --repo andares/pi-toolkits --file publish.yml --env npm --allow-publish
  ```

  要求 npm ≥ 11.15.0、账号级 2FA（安全密钥/通行密钥）；用 bypass-2FA 的 granular
  token 执行会 E401。信任关系只在 npm 网页/这条命令里改，本仓不存任何 token。

- **CI 门禁**（与本地一致）：`pnpm install --frozen-lockfile` → `pnpm typecheck` →
  `pnpm test` → `pnpm ui:typecheck` → `pnpm ui:check` → 校验 tag == `package.json`
  version → 该版本已在 npm 则跳过（重跑幂等）→ `npm publish --provenance
  --access public --ignore-scripts`（`--ignore-scripts`：门禁已作为显式步骤跑过）。
  **发布器必须是 npm CLI，不是 pnpm**：pnpm 12 自己实现 OIDC 交换，拿到 404 后只
  记一条 warning 就回落成**匿名**发布（v0.13.0 首次尝试即如此，最后 `Failed to publish
  ... 404`）。npm CLI 走同一条交换、同一组 claim。
- **`OIDC token exchange error - package not found` 是 registry 的遮蔽响应**：仓库 /
  workflow 文件名 / environment 任一比对失败都是这一句，看不出是哪项。所以先查 npm
  上的 trusted publisher 记录（字段对照见上），**不要**往客户端（pnpm 还是 npm）或
  GitHub 的 claim 格式上找——v0.13.0 卡了整整一轮，两次误判（先归因 GitHub 的
  immutable subject claims 上游 bug、再归因 pnpm），真因只是记录没配好/字段不匹配。
  可用对照实验辨伪：同一账号下已能 OIDC 发布的仓（`aliciai-dev/paintress`）与出事的
  仓 claim 形态相同（immutable `sub`），它能发就说明不是平台侧故障。
  只读探针：同一 workflow 文件路径 + `npm publish --dry-run --loglevel verbose`，
  能看到完整交换过程且不会真发；换文件名探针会让 `job_workflow_ref` 必然不匹配。
- **重跑同一个 tag 要用 `--ref master`**：`publish.yml` 按 `ref: inputs.tag` 检出，
  workflow 定义取自被 dispatch 的分支。代码修复若只在 tag 内，重跑才会带上；
  若修复在 tag 之后又要发同一版本，只能先 `git tag -f` 重指（0.13.0 如此）。

- **前置条件：工作区必须干净**——release 提交只含版本号（`git add package.json`），
  有未提交变更时脚本会在任何改动前直接中止。未提交内容会被打包进 npm 包却不进
  tag，造成「tag 内容 ≠ 实际发布内容」（v0.4.0 事故）。现在 CI 从 tag 的提交重新
  checkout，已发布内容 = tag 内容，但这道闸仍保留：本地门禁必须针对将要发布的
  同一份工作树。

- `pnpm release <patch|minor|major> [flags]`：
  干净检查 → **上一版尾部校验**（见下）→ typecheck + test + UI → **CHANGELOG.md 提升**
  （`## Unreleased` 改成 `## <next> — <date>`；缺段落或没有顶层 `- ` 条目直接中止，
  `--skip-changelog` 跳过；同时校验 `package.json` 的 `files` 含 `CHANGELOG.md`）→
  bump → commit（`package.json` + `CHANGELOG.md`）+ tag（`scripts/tag-current.mjs` 打
  `vX.Y.Z`，已存在则跳过）→ **自检：tag == HEAD 且工作区干净**（否则中止）→ `git push
  origin <branch>` + `git push origin refs/tags/vX.Y.Z`（**这一步就是发版**）→ 等 CI
  （只看 tag 触发的 workflow run：分阶段打印进度、排队卡死的 run 自动补发、失败立即
  中止并给 run URL；**run 绿了就算完成**）
  → 远端 tag 校验 + 幂等创建 GitHub Release → 收尾摘要（tag / run / Release，不查 npm）。
  - `--dry-run`：只打印计划。
  - `--prepare-only`：停在 push 之前并打印推送命令——「准备都做完、发不发由人按
    最后一次」用这一档。
  - `--no-wait`：推完 tag 就返回，不轮询、不建 Release。
  - `--local`：应急路径，本机 `pnpm publish`（旧行为，需要 token）。2027-01 起
    bypass-2FA granular token 失去直接发布能力，届时应改用 `npm stage publish` +
    网页端 2FA 审批。
  - `--skip-tail-check`：跳过「上一版尾部必须完成」的硬闸。

- **等 CI 的那一步（`scripts/lib/ci-publish.mjs`）**——三个实测结论换来的写法：
  - **判据只有「run 绿了」**（2026-11-26 崔总定）：不再回头轮询 npm 上的版本与
    provenance attestation。Action 之前也没有人问过 npmjs「处理好了没」；registry 的
    传播与扫描是 npm 的事，想看就点开包页面（脚本最后会打印链接）。workflow 自带
    「已发布则跳过」，所以绿 = 这一版发出去了。
  - **进度按阶段打印**：run 未出现 / `queued` / `in_progress`，每行带 `t=Ns`。旧版只有
    一行 30 s 节流的日志，「run 还没被创建」与「run 卡住了」看起来一模一样。
  - **僵尸 run 自动补发**：run 是 `queued`、`started_at` 为空、创建已超 60 s
    （`PI_RELEASE_RESCUE_QUEUE_MS` 可调，`0`/`off` 关闭；需要 `GITHUB_TOKEN`，没有就
    明确打印「不会自动补发」）→ 补发**一次** `workflow_dispatch`（同 tag、ref=当前分支），
    并接管新 run；新 run 按 **run id** 跟踪（dispatch run 的 `head_sha` 是分支头，
    不一定是 tag 的提交，按 sha 找会找丢）。只补发一次，新 run 也卡住就走 15 min 超时。
    先例：v0.13.0 的 tag run `43096640287` 至今 `queued`、`started_at` 为空，永远不开始
    也不失败，当时只能人工 `gh workflow run -f tag=v0.13.0 --ref master`。
    幂等靠工作流自带的「已发布则跳过」：两个 run 同时在场最多多一条 publish 步骤被
    跳过的绿 run，不会重发同一版本。真机验证（2026-11-12）：对已发布的 `v0.14.0`
    补发 → run `43282484846` 46 s 绿、`Publish with provenance` 跳过。

- **CI 失败后怎么办**：tag 已推、内容不会变，npm 不允许重发同一版本。修好原因后
  **重跑同一个 tag 的工作流**（幂等，已发布版本会跳过）：

  ```bash
  gh workflow run publish.yml -f tag=vX.Y.Z
  ```

  或 Actions → publish → Run workflow → tag 填 `vX.Y.Z`。不要删 tag 重打，也不要
  `pnpm release` 再 bump 一版来「绕过」——前者毁掉 tag 与发布内容的对应关系，
  后者把一次失败变成两个版本号。

- **上一版尾部校验（发版前的硬闸）**：`package.json` 的当前版本如果本地没有 tag、
  或 tag 没到远端 / 指向别的提交，**直接中止**并指向 `pnpm release:github v<当前>`。
  为什么必须有：一次中断的发版（打断在推 tag / 建 Release 之前）之后，再按一次
  `pnpm release` 就会发出一个与上一版**逐字节相同**的新版本——2026-11-10 的
  v0.12.3 → v0.12.4 实测，两个 tarball 的差异只有 `package.json` 的 version 一行
  （证据：`.agents/implementations/2026-11-10_release-tail-gate.md`）。只看 tag、
  不看 Release：Release 依赖 token，缺 token 的人不该因此发不了版。确实要跳过用
  `--skip-tail-check`（会打印它跳过了什么）。
- **`pnpm release:github [vX.Y.Z]`：补建 / 续跑入口**（默认取当前 package.json
  版本）——不动版本号、不碰 npm，只做「解析本地 tag → 推送/校验远端（带重试）
  → 幂等创建 Release」。**漏掉的 Release 只能用这条命令补**：`pnpm release`
  永远会再 bump 一版，所以以前的提示语「修好 tag 后重跑本脚本（幂等）」是错的
  （已删）。`--audit` 列出 npm 已发布版本 ↔ GitHub Release ↔ 远端 tag 的差集
  （`--allow-gaps` 把历史缺口降为警告）。**日常不需要再手动跑 `--audit`**：
  `pnpm release` 只核实这一版的 tag 与 Release；`--audit`
  是「怀疑历史漂移」时的全量体检（比如某次被打断的发版没人补、或换了机器丢了
  本地 tag）。只在 npm 上、没有 Release 的版本，其提交会被下一版的
  `generate_release_notes` 吞进下一版（对照的是上一个已发布 Release），GitHub
  的版本线就与 npm 对不上。
  唯一的先例是 0.1.0（早期发版时 tag 还不在流程里）：**2026-11-04 已补建完毕**——
  tag 指向 `8a0e2fb`，建 Release 时用 `make_latest: false` + 回填 `created_at`，
  所以 Latest 与 `git describe` 仍是 v0.11.3（证据：
  `.agents/implementations/2026-11-04_backfill-v0.1.0-release.md`）。
- **收尾只报已确定的事实**：tag、run URL、Release URL，外加一条 npm 包页面链接；
  不再探测 npm 版本与 provenance。原先那套四项尾部自检（npm 版本 / attestation /
  远端 tag / Release，缺一项就 exit 1）属于过度设计，2026-11-26 撤掉。
- **子进程一律有上限**（`scripts/lib/github-release.mjs`）：`git` / `curl` 的 spawnSync
  带 20 s 超时 + `SIGKILL`，ssh 补 `BatchMode` / `ConnectTimeout=10` /
  `ServerAliveInterval=5`（让它自己先放手，且保留操作者的 `-i` 等参数）。先例：
  v1.2.1（2026-11-26）尾部自检在标题后静默 47 分钟——`git ls-remote` 卡在一条已死掉的
  ssh 连接上，而 spawnSync 没有超时、事件循环被占住，连定时器都跑不了。**超时一律报
  `unknown`（无法确认），不得报成 `absent`（远端缺失）**：两者含义不同，混用会把网络
  卡顿误诊成「tag 没推上去」。
- GitHub Release 依赖 `GITHUB_TOKEN` 环境变量（classic token 的 `repo` scope 或
  fine-grained 的 Contents: write 都够用；本机用的是 **classic token**）；未设置时
  只提示，npm 发布与 provenance 不受影响，Release 事后用 `pnpm release:github` 补。
  创建失败（403/422/网络等）后脚本会自动 `GET /releases/tags/{tag}` 查询确认：
  200 = 已存在（并发/重试/手动补建过）→ 视为成功跳过；404 = 真失败 → 提示可
  稍后重跑补建。
- `pnpm tag-current` 可独立使用：给当前版本打本地 tag（已存在跳过，不推送）。
- **tag 命名**：本仓是单包，tag = `v<package.json version>`（如 `v0.12.5`）。
  `publish.yml` 会拒绝版本不一致的 tag（tag `v0.12.5` 但 package.json 还是
  `0.12.4` → 失败），也不要手打 tag 绕过 `pnpm release`。tag 一旦推送就不可改：
  npm 不允许重发同一版本，重打 tag 会毁掉「tag 指向发布内容」的对应关系。
- **远端 tag 校验的退避只属于续跑路径**：`pnpm release` 现在自己推 tag，Release
  步骤再校验时 tag 必然存在；「推之前只探一次」是为 `release:github`（tag 还没推
  的补建场景）保留的——那一步的「不存在」是必然事件、不是竞态，套 5 次退避会让
  每次补建白等 ~30 s（2+4+8+16）。重试只对「刚推完 ref 可见性滞后」有意义：
  v0.7.3 出现过「tag 实际已推成功、校验却报不存在」，一次 `ls-remote` 报「不
  存在」不等于失败。脚本区分「远端不存在」与「哈希不同」：前者重试仍失败才提示
  推 tag，后者提示人工确认后才可 `--force`。看到不一致**先手动
  `git ls-remote origin refs/tags/vX.Y.Z` 复核**：哈希一致就说明只是竞态，此时
  **不要** force-push，重跑 `pnpm release:github vX.Y.Z`（幂等）即可。
- 发布失败回滚（**仅限 tag 尚未推送时**）：`git tag -d vX.Y.Z && git reset --hard
  HEAD~1`。tag 已推送就走上面的「重跑同一个 tag 的工作流」，不要 reset。
- 需要覆盖远端 tag（如本地 tag 已重指）时：
  `git push origin refs/tags/vX.Y.Z --force`

## 分发与发现（npm 关键词即注册）

pi 没有「提交注册」这一步：官方编目 https://pi.dev/packages 是爬 npm 的产物，唯一门槛是包
`keywords` 里带 **`pi-package`**（宿主 `docs/packages.md` 原话）。没有表单、没有事前审核，
治理是事后的——每个卡片上有 report 链接（GitHub issue 模板）。

- **实测判定规则（2026-10-19）**：`pi` manifest 只让卡片页可达，**keyword 才进索引/搜索/列表**。
  对照实验：`@themoltnet/pi-extension`、`pi-extension-utils`（有 manifest、无 keyword）→
  卡片 200 但搜索 0 结果；`pi-acp`、`@zooid/pi-extension`，连 `@earendil-works/pi-coding-agent`
  自己（两者都无）→ 卡片 404。本包 0.9.5 正是前者：
  https://pi.dev/packages/@andares/pi-toolkits 打得开、但搜不到，0.9.6 补关键词修掉。
- **社区目录读的是同一批关键词**：awesome-pi.site（`shaftoe/awesome-pi-coding-agent`，每日爬）
  用 `keywords:pi-coding-agent | pi-agent | pi-theme | pi-package`（见其 `src/core/terms.ts`），
  所以两个都带：`pi-package`（官方索引）+ `pi-coding-agent`（社区爬取）。
- **改关键词必须发版**：npm 元数据发布即冻结，回改旧版本无效。发版后自检两件事——
  https://pi.dev/packages/@andares/pi-toolkits 是否出现 Downloads，以及
  https://pi.dev/packages?name=toolkits 能否搜到；爬虫是小时/天级，不是即时。
- qualisero/awesome-pi-agent（1.1k★）**已归档**（最后更新 2026-06），不要往那儿提 PR；
  BubblePtr/awesome-pi → https://piindex.dev/ 仍活跃，可提 PR。

## Feature: ask（`/ask` 咨询模式，2026-10-19 重构）

旧版 ask 把「写临时文件」也一并禁掉：`write`/`edit`/`powershell` 摘除 + bash 只读白名单。
本意是安全的规划环境，实际代价是 AI 连写个提纲、存个草稿都不行，只能把中间产物塞进回复
或绕路；崔总于是干脆改用「提示一句只讨论」，指令本身几乎不用。结论：**ask 该禁止的是
「改项目」，不是「写文件」**。

### 决策（崔总 2026-10-19 定稿）

- 形态取 **scratch 工具**：`scratchpad` 只写会话临时目录；`write`/`edit`/`powershell`
  仍然硬禁、bash 仍然只读（不新增写通道）
- **不保留**旧版「完全无写」行为（不留 `/ask hard` 之类的第二档）
- 模式仍然**粘性**到手动 `/ask` 退出（不做「一次一轮」）
- 评估过但没做的两条：**路径闸门**（保留 `write`/`edit` 只放行临时目录——接口不变、
  TUI 有 diff，但要做 realpath/symlink 判断，bash 想放行重定向还得复制 permission 的
  `units` 拆解（cd 折叠 + 重定向位置语义），代码翻倍、逃逸面最大）；**确认门**
  （不撤工具、写操作弹 a/s/d/f——最软，但对话被打断、工具在手模型更爱尝试，留作将来
  `/ask soft` 的选项）。

### 实现要点

- `src/features/ask/scratch.ts` —— 会话级目录 `<os.tmpdir()>/pi-ask/<sessionId>`
  （Windows 走 `%TEMP%`，所以「没有 /tmp 的系统」天然可用）。
  - 名字只接受相对名：至多两级、逐段 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，拒绝 `..`、
    绝对路径、盘符、反斜杠、前导点；拼好后**再做一次包含判断**（纵深防御）。
  - 已存在的路径分量若是符号链接 → 拒绝（防止临时目录里预先埋的链接把笔记写到别处）。
  - 单文件 256 KiB 上限（笔记不是仓库备份，也防止模型读回时淹掉上下文）。
  - 创建时写一个探针文件再删——`mkdir -p` 在只读 TMPDIR 上会假成功；探针失败就抛错，
    由 ask **整体降级**为纯只读（不做半开）。
  - 进入时清理 >7 天的旧目录；退出**不删**（`pi -c` 续会话还能找回笔记）。
- `src/features/ask/scratch-tool.ts` —— `scratchpad`，`op = write|append|read|list|delete`，
  `defaultActive: false`，只在 ask 期间激活。软约束的载体是工具自己的 `description` +
  `promptGuidelines`（这两个字段 1.0.0 起就有，实测全窗口可用），因此「笔记不是交付物、
  真改动要说出来让用户 `/ask` 退出」只在适用时进入系统提示。工具**不接收路径**，模型
  不需要知道绝对路径，也不需要任何路径解析。
- `src/features/ask/prompt.ts` —— 横幅压到 3 行（状态 + 草稿通道 + 退出），**删掉整段 bash
  白名单**：那是沙箱的职责，拒绝理由已按分类指路（`reasons.ts`），细节只在真用到的那轮付费。
  横幅不含路径与时间戳、会话内字节稳定，才能稳定命中 provider 的 prompt 缓存；旧横幅
  1248 字符 ≈ 310 tok/请求，新版 < 500 字符。
- `src/features/ask/reasons.ts` —— write/edit/redirect/write/download 类拒绝理由统一指
  `scratchpad`（草稿）与 `/ask`（真改动）；**降级模式（无 scratch）下不再指向
  `scratchpad`**（`ReasonOptions.scratch`，闸门按当前状态传入）。
- **进程内切换会话重绑定**：`/new`、`/resume`、fork 在 ask 开启时触发 `session_start`，
  会话 id 变化即重建 scratch store 绑到新会话目录并通知；同 id 重复 emission 不动
  （`scratchSessionId` 比对）。退出 /ask 时清除绑定。
- `src/lib/tools.ts` 增加**自封闭工具登记表**（`markJailedTool`/`clearJailedTool`/
  `isJailedTool`）：ask 启用 `scratchpad` 时标记、退出时清除；permission 的闸门看到标记
  直接跳过——该工具只能写自己的临时目录，没有「边界」可判（否则 `out-write=ask` 会为
  每份草稿弹框）。这是**按工具名**放行，只有「调用方无法让它指向任意路径」的工具才能登记；
  忘记清除会放宽边界，所以由拥有者在退出时清。

### 已知边界（有意为之）

- scratch 里的东西**永不执行**（bash 只读白名单不因 ask 放宽），所以往 scratch 里写脚本
  只是文本，不是执行通道。
- 不是沙箱：临时目录里若被别的进程放了符号链接，我们**拒绝**而不是跟随（拒绝不等于隔离）。
- 原生 Windows 路径拼写只做近似，实测目标仍是 POSIX 宿主。

### 已验证

- 测试：`pnpm test` 61 个文件 / 1064 测试全绿；`pnpm check:compat` 在强制窗口
  1.3.0–1.6.1 全绿（矩阵每版 1064 项全过），向后探针 1.2.x / 1.1.x / 1.0.x / 0.99.x 也全绿（0.87.x
  上一轮因 `defaultActive` 停探、不改代码）—— **public floor 0.99.0**，peer `>=0.99.0`。
- 真实 pi 1.6.0 冒烟（`pi -p --no-extensions -e ./src/index.ts --tools ''` 回 `OK`）；
  历史冒烟（1.5.2 同命令回 `OK`；1.4.0 项目 autostart 派发 `/ask` → 模型调用 `scratchpad`）；
  第一轮的工具集里就含 `scratchpad`，`plan.md` 写入 `/tmp/pi-ask/<session>/` 成功。
  **冒烟发现并修掉两处**：① 在 `session_start` 里 `setActiveTools` 会被该轮 loadout
  准备覆盖 → 改为在 `before_agent_start` 里重新断言工具集；② 异步建目录会让第一轮
  看不到 `scratchpad` → 建目录/清理改为同步 fs，`enter()` 内无 await。

## Feature: autostart（已实现并发布）

2026-10-07 立项。会话启动自动化：项目内配置文件声明启动时要执行的斜杠命令，
首批用例是 /add-dir 持久化（多仓库工作区的第一步）。决策均已崔总确认：

- **扩展名**：`autostart`（生态 auto- 前缀惯例：auto-compact、auto-naming-session）
- **配置位置**：两个源，**按序执行、不做合并**：
  1. `<agentDir>/autostart.toml`（默认 `~/.pi/agent/autostart.toml`）——操作者本机默认，
     每个项目都生效；**不需要 project trust**（文件属于操作者，不受项目控制）
  2. `<项目根>/.pi/autostart.toml`（随项目进 git）——项目声明，**需要 project trust**

  全局先跑、项目后跑，所以项目可以覆盖此前的设置（例如后面再来一条不同参数的 `/ask-perm`）。
  之所以不合并：TOML 数组合并语义容易产生「谁覆盖谁」的意外，两条列表各自独立、顺序可预测。
  **同一条命令文本在两次来源里都出现时，一次重放只执行一次**（`dispatched` 集合，按文本去重）：
  把全局那行复制进项目不会再跑一遍，也不会重复提示；不同命令仍各跑一次，项目覆盖照常生效。
- **执行时机**：判定不能只看 reason（见下）——`shouldReplay(reason, hasHistory)`：
  - `startup` 且会话无历史（含 `new`）：重放
  - `startup` 但会话已有历史：**不重放**（进程启动即带旧会话，见「已验证的技术事实」第 6 条）
  - `fork`（进程内）：重放（分支点可能早于配置出现）
  - `resume`（进程内 `/resume`）/ `reload`：不重放（分支已带状态；重放会重复副作用）

### 配置 schema

```toml
# <项目根>/.pi/autostart.toml（或 <agentDir>/autostart.toml）
version = 1

[command]
# 按序执行的扩展命令（仅扩展命令，见约束）
run = [
  "/add-dir ../shop-frontend",
  "/add-dir ../shop-api",
]
```

> 键名是 `[command]`，不是 `[session]`——早期设计稿写的是 `[session]`，实现时定稿为
> `[command]`（schema 以 `src/features/autostart/autostart.ts` 的解析器为准）。

解析器选 `smol-toml`（零依赖、~10KB、TOML 1.0、活跃维护），
加入 dependencies（先例：@dreki-gg/pi-command-sandbox）。

### 已验证的技术事实（pi 1.2.0 源码，agent-session.js）

1. `sendUserMessage("/cmd args")` 走 `prompt()` → `_tryExecuteExtensionCommand()`：
   **扩展命令被立即执行，不发给模型**，streaming 中也可执行。1.2.0 把 prompt 内的
   「准备消息 + 启动 run」重构成 `_prepareRun`/`_startRun`，但扩展命令分支仍是最前的
   同一条早退路径；1.5.1 又把其余部分抽进 `_preparePrompt`（#9154），扩展命令分支的位置
   不变。逐函数事实：`_tryExecuteExtensionCommand` 在 0.99.0–1.6.0 全区间逐字节一致
   （1.3.0 → 1.4.0、1.4.0 → 1.5.0、1.5.0 → 1.5.1、1.5.1 → 1.5.2、1.5.2 → 1.6.0 已逐函数 diff 复核）；`sendUserMessage`
   只在 1.5.1 变过一次（同一次抽取，1.5.1 → 1.6.0 未动），因此不能再声称它全区间一致。
2. **只能支持扩展命令**（/add-dir、/cd、/skill:xxx 等 registerCommand 注册的）；
   内置命令（/compact、/reload、/resume）走 TUI 层，扩展层触发不了；
   skill 命令是展开机制非执行机制——此约束必须写进 README
3. `SessionStartEvent.reason`: `"startup" | "reload" | "new" | "resume" | "fork"`
   （types.d.ts `SessionStartEvent`）——时机过滤的依据
4. `ctx.isProjectTrusted()` 可用——未信任目录不自动执行命令（安全默认，
   与 permission-system 的 project scope gating 同哲学）
5. pi-add-dir 自带 Already added 幂等检查，重复重放不会翻车
6. **`session_start.reason` 在「进程启动即打开旧会话」时是 `startup`，不是 `resume`**
   ——`-c`/`-r`/`--session`/`--fork` 都在创建第一个 runtime 之前就把旧会话装进
   sessionManager，而该 runtime 创建时不带 `sessionStartEvent`，于是落到默认值
   `startup`（`main.js` 的 `isInitialRuntime` 分支 + `agent-session.js:199`
   `{ type: "session_start", reason: "startup" }`）。`resume` 只在进程内切换会话
   （`/resume`、session replacement）时由 `agent-session-runtime.js` 显式发出。
   实测（pi 1.3.0 + 探针扩展，1.4.0 复核默认值仍在 `agent-session.js:199`）：新会话
   `entries=2 messages=0`，`pi -c` 之后 `entries=8 messages=3`，两者都报 `reason=startup`。
   **结论**：判「是不是新会话」必须看会话内容——用 `buildContextEntries()`
   是否含 `message`/`custom_message`/`compaction`/`branch_summary`（扩展侧拿不到
   `buildSessionContext()`，它不在 `ReadonlySessionManager` 的 Pick 里；
   宿主自己判「existing session」用的是 `buildSessionContext().messages.length > 0`，
   语义一致）。**这是 v0.9.0 的 bug**：只看 reason 会让 `pi -c` 也重放，
   用户在项目里配的 `/ask-perm` 于是会在续会话时把权限打开，与其「只在新会话生效」
   的文档承诺不符（2026-10-18 崔总实测发现，v0.9.1 修）。

### 执行流程

```text
session_start(reason 过滤)
  → 每个源依次：读 <agentDir>/autostart.toml → 读 <cwd>/.pi/autostart.toml（无文件静默跳过）
  → 项目源额外要 ctx.isProjectTrusted() 校验（全局源不需要）
  → 逐条命令：预校验命令名存在于注册表 → pi.sendUserMessage(cmd)
  → 结果 notify / 错误日志
```

### 风险与结论（M1 已验证）

- **命令不存在时文本会作为普通消息发给模型**（跑偏风险）——已用 `pi.getCommands()`
  预校验解决（只接受 `source: "extension"`），未注册的命令名跳过并警告，绝不发给模型
- `sendUserMessage` 的 "/cmd" 触发语义在 0.99–1.4 全区间成立（`_tryExecuteExtensionCommand`
  与 `sendUserMessage` 包装逐字节一致，矩阵 typecheck/test + 真实冒烟已过；
  2026-10-23 随窗口迁移复核）
- 与 pi-add-dir 的 session_start 顺序：命令执行时 pi-add-dir 必已完成注册
  （扩展加载先于全部 session_start）——冒烟确认无问题

### 实施落位（已实现）

- `src/features/autostart/index.ts`，与 ask/compact/favorites/review/stash 同构；
  `registerAutostart(pi, { agentDir })` 的 `agentDir` 可注入，测试用临时目录（不碰真实 `~/.pi/agent`）
- `src/index.ts` 注册；package.json keywords 加 autostart
- 未来新 section（环境变量、模型等）按需扩展，不预设

## Feature: init（`/ask-init` agent 记忆框架，2026-10-26 立项）

目标：一条命令把「纯给 agent 看」的记忆按固定形状装进项目，并把已有文档接管过来；
之后能反复审计腐烂。参考样板是 `~/repos/c-thun/raybend`（只读研究，该仓未被改动）。

### 决策（崔总 2026-10-26 定稿）

- **纯 agent 面进 `.agents/`**，人看的东西留在根：`specs/`（计划与实施方案）、`design/`、
  `docs/`、`legal/` 不变；`memory/`→`.agents/memory/`、`implementations/`→
  `.agents/implementations/`、口述原文 `prompts/`→`.agents/prompts/`（可选、通常 local-only）。
- **`specs/` 是计划的家**：路线级 `specs/PLAN.md` + 单元 `specs/<unit>.md`。原
  `memory/PLAN.md` 用 `move-file` **原样**搬到 `specs/PLAN.md`（零内容改动），模型只做整形。
- **`todos/` 退役**：需求即 spec；复杂需求直接写 `specs/<unit>.md` 的「需求原文（照录）」节。
- **框架自带文本英文**（契约、模板、审计码、工作单）；框架生成的文件（骨架、种子、索引表头）
  按 AGENTS/README 的 CJK 比例现算渲染语言，`--lang` 可覆盖。渲染语言**每次现算、永不落盘**
  （所以 `--lang` 是单次生效，下次 run 重新现算）：state.toml 不存 `lang`，plan 工件不存
  `language`；工作单与任务里没有任何语言指令（见上方不变量）。
  旧版落盘过这些字段，已 init 项目用 `/ask-init scrub [--dry-run]`（隐藏维护子命令，不进
  USAGE/README）一次性清除：state 的顶层 `lang` 行、plans/*.json 的 `language` 键与内嵌的
  旧指令行；新的 mutating run 也会自动顺带擦 plans 目录。
  scrub **不写快照、不进表内表**（顶层之外的同名键属于那张表）；`snapshots/` 是 sha256
  背书的不可变备份，含旧指令的历史快照不自动改写——要字节级彻底清干净就整体删掉
  `.agents/framework/snapshots/`（对应源文件都在 git 历史里）。
- **确认后直接派发模型**（`sendUserMessage` 工作单）；`plan` / `check` / `roots` 是分步入口。
- **默认保守 pass**：只装框架 + 修机械漂移（墓碑、重复章节、附录顺序）+ 覆盖表；
  AGENTS.md 超预算只登记债务，`--deep` 才允许结构性改写。
- **迁移必须用户确认**（会动文件）：TUI 面板列出移动/改写/创建/快照计数，
  `d` = 只报告不写盘，Esc = 取消；无 UI（print/json）一律只出报告。

### 机械半边与模型半边

| 类别 | 谁执行 | 内容 |
| --- | --- | --- |
| `actions[]`（确定性） | 扩展代码 | `snapshot` / `create-dirs` / `move-file` / `move-dir` / `create-file` / `rewrite-refs` / `write-state` |
| `tasks[]`（判断） | 模型 | `survey` / `edit-agents` / `edit-plan` / `merge-plan` / `triage-todos` / `root-cards` / `budget-debt` / `coverage` / `dedupe-claude` |

安全不变量（顺序即执行顺序）：① 先快照——**含引用改写会碰到的每个文件**，manifest 带 sha256
与当时的 `git status`；② 代码只写仓内，added root 由模型写、因此走 permission 闸门；
③ 已存在的文件不覆盖、移动目标非空转人工任务；④ 改写与检测用**同一个**裸路径判定，
前后计数对账并出逐文件报告；⑤ 覆盖表还有 OPEN 就不算完成。

### 目录与文件

```text
AGENTS.md                     # 入口：不变量 / 命令 / 路由 / 索引（人也能看）
specs/PLAN.md + <unit>.md     # 计划与单元方案（人审）
design/ docs/ legal/          # 人看的东西（可选模块）
.agents/README.md             # 门牌：这一层放什么
.agents/memory/               # README(契约) + FINISHED/FUTURE/ARCHITECTURE + 可选 DESIGN/TERMS/REVIEW/DEBUGGING/FUNCTION-*
.agents/implementations/      # YYYY-MM-DD_<slug>.md，首行精确到秒
.agents/prompts/              # 口述原文（可选）
.agents/framework/            # state.toml + .gitignore + snapshots/ plans/ reports/（后三者 local-only）
```

### 审计码（稳定，可跨次对比）

`E-PATH-01` 裸旧路径 · `E-STATE-01` 记忆被 gitignore · `W-STATE-01` 记忆尚未提交（新装后正常，属警告） · `E-STATE-02` 状态版本不符 ·
`E-INDEX-01` 索引 ↔ 实际文件不一致 · `E-LINK-01` 内部链接失效 · `E-CONTRACT-01` 缺契约 ·
`W-BUDGET-01/02` AGENTS.md / 记忆文件超预算 · `W-DUP-01` 同章节出现在两个文件 ·
`W-ORDER-01` 附录后又追加 · `W-COV-01` 覆盖表有 OPEN · `W-META-01` FUTURE 缺触发条件 ·
`W-EVID-01` FINISHED 条目无证据指针 · `W-PLAN-01` spec 全勾却仍在 PLAN ·
`W-ROOT-01/02` 根下 agent-only 目录 / 零字节文件 · `W-ROOT-03/04` 登记的 root 缺失 / scope card 过大 · `W-TODO-01` todos 仍在 ·
`W-OVERRIDE-01` `AGENTS.override.md` 顶替入口 · `W-SCAFFOLD-01` 未填的 ask-init 模板标记（`TODO` 占位） ·
`I-AGENTS-01` `.agents/skills` 存在（pi 会要求项目信任） · `I-INSTALL-01` 尚未安装框架。

框架文件对等：`W-PATH-01` 旧目录已不存在时的裸旧路径 · `W-FW-02` 受管文件缺失/落后 · `W-FW-03` 工作流块缺失/落后/malformed/手写无 marker · `W-FW-04` 必需框架文件缺失 · `I-FW-01` 无模板锚。

### 多仓库

记忆只住主仓。**源码事实**：pi 只加载 cwd 及其祖先的 AGENTS.md；`pi-add-dir` 会把每个
added root 的 `AGENTS.md`（含 `.pi/AGENTS.md`）**全文**注入每次请求（`buildContextInjection`）——
所以 root 里的入口只能是 ≤30 行 scope card（这里放什么、它的命令、去主仓哪个记忆文件读），
绝不能是规则的第二份副本。`/ask-init roots` 合并本次会话 `add-dir:state` 与 state 里已登记的
roots；自带完整框架的 root 标记 `independent`，不接管。

### 刷新机制（`/ask-init refresh`，2026-11-12）

`/ask-init` 的既有规则是「已存在就不覆盖」，所以脚本/种子只在缺失时创建；而每加一个功能
都要往项目里补合同、补 `AGENTS.md` 的工作流段。`refresh` 就是唯一被允许重写**框架拥有字节**
的入口，**`/ask-init` 每次运行都会调用它**：audit-only 先 refresh 再 audit；全量 run 在 apply
之后、派发工作单之前 refresh。

- **受管文件**（`.agents/memory/README.md`、`.agents/README.md`、`.agents/uat/README.md`、
  `.agents/framework/.gitignore`）只有当磁盘仍等于「我们上次写出的字节」时才重写。
  锚是 `state.toml` 的 `managed[].template_sha256`（渲染结果的哈希），不是磁盘哈希——
  后者会在每次 run 末尾被回填，证明不了「没被人改过」。旧 state 没有锚时，只有磁盘与当前模板
  逐字节相同才补锚；其余一律跳过（旧磁盘哈希不构成覆盖许可）。`refresh --adopt`
  是显式例外：核对过旧文件后，把它当前的字节认作框架拥有并接管，下一次 refresh 才
  会正常更新；`/ask-init` 的 `I-FW-01` 文案会指到这条命令。
- **`AGENTS.md` 只动 workflow 标记块**：marker 必须**独占一行**、不在 fenced 代码块里，且
  `begin`/`end` 恰好成对；`<!-- ask-init:begin workflow … -->` … `<!-- ask-init:end workflow -->`，
  块外一个字节不动；标记缺失时确定性插入（有 `## 附录` 就插在它前面，否则追加到末尾）；
  不配对/重复时标 `malformed`，**不写** AGENTS.md。文档里内联引用 marker 不会再被误认成块。
- **缺失的可选件会补建**（`.agents/uat/README.md`），所以早期采纳的项目能原地补齐验收台账。
- 幂等：第二次运行报 `current`；`--dry-run` 只报告不写盘。
- **对等检查**：`inspectFramework` 区分 `current` / `stale`（磁盘 == 锚但锚 != 当前模板）/
  `hand-edited` / `missing` / `unverifiable`（旧 state 无锚）；workflow 块分
  `current/stale/missing/malformed/hand-written/missing-agents`。`check` 报告这些码，
  `plan` 预览它们；`/ask-init` 安全时自动补，手工改过的跳过并报告。
- **机械修复**：`layoutOk` 现在也要求 `AGENTS.md`、核心 seed（FINISHED/FUTURE/ARCHITECTURE）、
  `specs/PLAN.md`；只缺文件/目录的 `reconcile` 只产生 create/move 动作，不派模型
  （`applyAndDispatch` 在 `tasks.length === 0` 时只应用并提示 mechanical repair）。
- **ask 循环的「已安装」判定**：`frameworkReadiness` 只查 `state.toml`、`AGENTS.md`、
  `.agents/memory/README.md`、`.agents/implementations/` 是否存在；文件内容小改不挡
  `/ask-uat` / `record_change`，缺失时拒绝并列出缺失项。
- **相位互斥**：`ask` 拒绝叠在 spec/uat 上；`ask-spec` 退出 ask、拒绝 uat、加 `isIdle`；
  `ask-review` 退出 ask、拒绝 spec；`ask-init` 的 mutating 子命令在任一相位下拒绝。
  spec 激活时再执行裸 `/ask-spec` 与 `/ask-spec off` 同样退出（在 `isIdle` 检查之前，误入时可直接退出）。
- **不升 `FRAMEWORK_VERSION`**：UAT 目录是可选增量，`I-UAT-01` 表示「尚未安装」；
  升版本号会要求迁移配方，反而挡住用户。

新审计码：`E-UAT-01` 账本行不可解析、`W-UAT-01` 项指向不存在的记录、`W-UAT-02` 候选超 14 天
未聚类、`W-UAT-03` 项超 30 天未勾、`W-REC-01` 近期记录首行/文件名不合规、`W-FW-01` 框架文件
被人手改（refresh 不会覆盖）、`I-UAT-01` 验收台账未安装。

### 已验证

- `pnpm typecheck` 绿；`pnpm test` **61 文件 / 1064 测试**全绿（init 11 个测试文件 / 122 用例）；
  `pnpm check:keybindings` 全部 ✅（未新增任何键位）。
- `pnpm check:compat`：窗口 1.3.0–1.6.1 全绿（矩阵每版 1064 项全过），探针 1.2.x / 1.1.x / 1.0.x / 0.99.x 全绿、
  0.87.x 上一轮因 `defaultActive` 停探（本轮探针额度已满，未重探），floor 0.99.0。
- 测试稳定性（2026-11-04）：矩阵并发四沙箱时，vitest 默认 worker 数（22 核 → 21）会因内存
  压力让**不同的**测试偶发超时（1.0.2 的 git fixture、1.0.1 的动态 import），把 floor 拖到噪声上。
  已收敛测试环境（`vitest.config.ts`：`maxWorkers: 4`、30s 超时；`detect.test.ts` 的
  `await import("./apply.js")` 改为静态 import），断言未动。
- 第三方评审后修正：相对路径引用（`./`/`../`）、根级与遗留 PLAN 的移动/合并/快照、非计划 legacy 文档任务、
  state 预算键往返、未知参数拒绝、无 upgrade recipe 时不写盘、未提交记忆降为 `W-STATE-01`、
  非 UTF-8 文件跳过、`/ask-init roots` 也先快照。
- 真实样本**只读** dry-run（不写盘，`git status --porcelain` 前后一致）：
  - raybend → `adopt`：1717 处引用 / 395 文件；移动 `memory`(10)/`implementations`(313)/`prompts`(7)；
    `memory/PLAN.md`→`specs/PLAN.md`；6 项任务；AGENTS.md 57KB 判 `budget-debt`；检测 145ms。
  - model-registry（32 行 AGENTS.md + `implementations/`）→ `adopt`；promptdown → `adopt` + `budget-debt`；
    deepseek-harness（AGENTS.md 与 CLAUDE.md 内容重叠）额外得到 `dedupe-claude`；近 1.6 万文本文件时检测 695ms。
  - ⚠️ raybend 当时有 7 项未提交改动（docs/scripts 的其它工作），**未做任何写入**，按要求不碰该仓。

### 边界（有意为之）

- v1 无 upgrade recipe：state 版本旧 → 提示人工迁移；版本新 → 直接拒绝，绝不猜着迁。
- `AGENTS.override.md` 只报不改（它会让 pi 完全忽略 AGENTS.md）。
- 不建兼容软链（Windows `core.symlinks=false` 会把软链 checkout 成文本文件）：真移动 + 重写引用。
- 命令里不自动 `/reload`（会让刚建立的运行状态失效），跑完提示用户 reload。
- 覆盖表能证明「每个源章节都有交代」，**不能**证明改写后事实没出错；后者靠保守 pass + diff 审阅。
- 引用扫描/改写只覆盖 `SCAN.refExtensions` 白名单内的文本类型；白名单外（如 `.lua`）不改写。

## Feature: permission（`/ask-perm` 会话级边界权限，已实现）

2026-10-18 立项。替换/补位第三方 `@gotgenes/pi-permission-system` 的思路：
那个插件把「命令 × 规则 pattern」当主键，规则矩阵是无限的、会话中不可控，
yolo 开关还落全局盘（开一次忘了关，此后所有新会话形同裸奔）。

本功能把主键换成**「边界（项目内/外）× 操作性质（读/写）」+ 会话级例外表**——
边界有限、可解释、可默认，四格加两次切换覆盖日常决策，例外靠会话授权消化。

### 需求（崔总定稿）

- **状态完全不落盘、默认不开**：不操作则对此功能毫无感知；
  持久化的替身是 autostart（想默认开就在配置里写一条 `/ask-perm ...`）
- `/ask-perm` 无参数：关闭态弹模式面板（顶行回车即按默认开启），开启态则关闭；
  开关都输出 notify（对齐 `/ask`）
- 带参数即不弹窗、直接按参数开启（autostart 依赖这条路径）：
  `/ask-perm [in-read] [in-write] [out-read] [out-write]`，
  缺省参数回落**默认值**（不是当前值），如 `/ask-perm allow` ≈ 默认开启
- 默认值：项目内读/写 allow、项目外读 allow、项目外写 ask
- 项目内 2 项可切 `ask|allow`，项目外 2 项可切 `ask|allow|deny`
- 会话不需要精确到命令，**接受精度/成本的平衡**：抓大放小，重点误操作要能识别
- bash 要拆复合命令（管道、`&&`、`;`、`xargs` 等），按拆出的单位分别判定
- 执行位置与目标目录**双重判定**，任何一项撞 ask/deny 都要处理
- 判定**不靠 AI**（纯代码）
- 会话授权四选项 `a/s/d/f`（本次/本会话的 允许/拒绝）
- 与 `/ask` **并行不冲突**——不是互斥切换（互斥会让 `.ssh` 硬拒失效）
- **全部界面与提示文字用英文**

### 架构落位

```text
src/lib/gates.ts               # 闸门总线：多特性 tool_call 策略的组合 + 对话框串行队列
src/features/permission/
├── index.ts        # registerPermission(pi, gates)：/ask-perm、状态机、gate、footer、系统提示
├── constants.ts    # 默认四格 + 凭据表 + 破坏性命令表
├── modes.ts        # 参数解析（缺省回落默认）、格式化
├── panel.ts        # SettingsList + 回车即应用（薄包装 ~40 行）
├── prompt.ts       # SelectList + a/s/d/f 热键；非 TUI 回落 ctx.ui.select
├── paths.ts        # ~ 展开、realpath 规范化、包含判断、add-dir 目录读取
├── session-rules.ts# 内存会话授权（effect × 目录根；opaque 命令按文本）
├── units.ts        # bash 拆解：分段/包装剥离/替换/heredoc/cd 折叠/读写判定
└── policy.ts       # 逐单位判定 → 最严格聚合 → 拒绝理由
```

### 关键实现决策（含为什么）

1. **闸门总线而非互斥**：`ask` 回答「会不会产生变更」，`permission` 回答「有没有越过边界」，
   两者注册到同一条总线，`block` 短路、`allow` 不覆盖别人的 `ask/deny`。
   互斥切换会让 ask 模式下的凭据硬拒失效（那是 perm 的职责），所以并行是唯一正确解。
   总线同时持有对话框串行队列：pi 一条 assistant 消息里的 tool calls 并行执行，
   而 `ctx.ui.custom` 只有一个槽（原插件为此专门写过 `AskDialogQueue`）。
2. **不引入 tree-sitter**（原插件为精确解析引了 4.5MB 的 web-tree-sitter + bash wasm，
   换来 8000 行解析代码）。这里用已有依赖 `shell-quote`（tokenizer，非 AST）：
   分段 → 剥 `VAR=val` 前缀 → 剥 wrapper（sudo/env/xargs/timeout/nice/nohup/setsid/
   stdbuf/watch/flock/parallel/command/builtin/time/exec）→ 递归 `bash -c`/`eval`/`$(…)`/反引号
   → `find/fd -exec` 取内层 → heredoc 正文先剥掉。
3. **解析不了 → 无条件 ask（fail closed）**，不看模式：非字面量 `cd`、未闭合引号/heredoc/替换、
   `$VAR` 出现在路径位置（env 代理把未知变量展开成哨兵而不是空串——否则 `$DIR/secret`
   会静默变成 `/secret` 而被当成项目内），以及 PowerShell（不拆解）。
4. **`git -C <dir>` 按局部 cd 折叠**：`-C` 之后的相对路径按 `<dir>` 解析而不是 cwd；
   否则 `git -C ~/.ssh log`、`git -C ../outside push` 会被当成项目内。
5. **两张固定表在四格模式之外**：
   - 凭据表 deny（任何模式）：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.pi/agent/auth*.json`、
     `.env`（模板除外）。没有它，默认 `out-read=allow` 就等于把 `~/.ssh/id_rsa` 交出去。
   - 破坏性表 ask（任何模式）：对 `/`/家目录/工作目录的 `rm`、`git reset --hard`、
     `git clean -f`、`git push --force`、包 `publish`、`dd` 写裸设备、`mkfs*`、关机、
     `chmod -R 777`、任何 `sudo`。**作用域表达不了「破坏性」**——项目内写默认 allow。
   - 优先级：凭据表 > 会话授权 > 破坏性表 > 四格模式。会话授权故意高于破坏性表：
     用户点了 `s`（本会话允许）之后，重复同一危险操作不该再弹——否则就是原插件
     「瘸腿」的老毛病。
6. **加重定向目标必须按 op 的位置解析**：`shell-quote` 对 `>` 给出的是**输出位置**
   （`["ls", {op:">"}, "out.txt"]`），而对 `<` 是**中缀位置**（`["cat", {op:"<"}, "in.txt"]`）。
   早期实现假设「目标在 op 后一位」并按中缀处理，导致 `echo a > /tmp/x` 被判成读；
   已在 `segmentTokens` 里保留 op 交给 `splitRedirects` 修正（评审阶段发现的回归）。
7. **`/dev/null`、`/dev/stdout`、`/dev/stderr` 不算目标**（`cmd 2>/dev/null` 是噪声不是写）。
8. **opaque 命令的会话授权按完整命令文本**（key = 各 unit 的 `raw` 拼接），
   普通命令按 `(effect, 目录根)` 且用包含匹配、不引入 glob——用户批准的是「这个目录」。
9. **UI 组件复用宿主件**：面板用 `SettingsList`（空格循环、↑↓、Esc 由它原生提供），
   我们只加「任意行回车 = 应用」；对话框用 `SelectList` + a/s/d/f 热键。
   非 TUI（rpc/print）无法挂自定义组件，回落 `ctx.ui.select`；`hasUI === false` 直接拒绝（fail closed）。
10. **提示字串一律英文**（崔总要求）：panel/prompt/notify/banner/拒绝理由。
11. **带参数开启是幂等的**：模式与当前一致时直接返回——不重复记录，也不清空会话授权。
    `ask-perm` 既可能被两个 autostart 来源各跑一次，也可能在配置里写了两行；
    旧实现每条都会 `rules.clear()` 并记一次，用户会看到授权被静默清掉。
    现在只有模式**真的变化**才记录并清空授权（旧授权是按旧策略给的）。
12. **只有 `/ask-perm` 的提示采用混合方案**（其他命令如 `/ask` 保持原样，继续用
    `ctx.ui.notify("info")`）：
    - **启动（autostart 派发）** → 自定义会话条目 `ask-perm:notice` +
      `registerEntryRenderer`，自带文本、不受 invalidate 影响，不进模型上下文
      （与 pi-chrome 同款用法）；标记由 `src/lib/startup.ts` 传递，autostart 派发前
      `markStartupCommand("ask-perm")`、`finally` 里清除，permission 消费一次。
    - **手动执行** → 仍用 `ctx.ui.notify("info")`：连续 info 会覆盖上一行，ON/OFF/ON
      原地更新、屏幕不滚动。
    原因是宿主把每条 info 提示渲染成一个 `ThemedText`，其 builder 读的是**共享的**
    `lastStatusMessage` 字段（`interactive-mode.js#showStatus`）；`ui.invalidate()`
    （切换主题、主题文件变更、启动期语法加载完成）会重建**所有**旧状态行，于是
    `/add-dir` 那行也会显示我们的文案，一条命令看起来像执行了两次。这不是重复执行，
    也不是 API 用错（add-dir 的 info 提示同样会被改写）。
    残余限制：手动切换过之后若再遇到 invalidate，旧状态行仍会被改写成最新的手动提示；
    启动阶段因为只追加条目、不新增状态行，不会重复。**两套语义只限 `/ask-perm`**——
    它最常出现在 autostart 里与别的命令混排；不要把该方案扩散到 `/ask` 等命令。
13. **临时目录写直通（2026-10-26 依据真实日志，崔总确认 A+B）**：
    - `/dev/null`、`/dev/stdout`、`/dev/stderr` 作为**普通操作数**也不计目标
      （`curl -o /dev/null`、`sort -o /dev/null`、`dd of=/dev/null`）；重定向早已排除。
      `WRITE_PATH_COMMANDS` 分支仍保留设备节点目标（`rm /dev/null` 照样判），不放过节点操作。
    - `echo` / `printf` 的参数是数据不是路径；跳过它们的通用操作数收集。输出重定向仍单独收集，
      所以 `echo x > /tmp/y` 不受影响。
    - `os.tmpdir()` / `/var/tmp` / `/dev/shm` 下的**项目外写**在 mode 为 `ask` 时直接放行，
      audit layer 记 `temp`；显式 `outWrite=deny` 仍然拒绝；`rm -rf /tmp` 因临时根被纳入
      破坏性表仍会询问。只影响 `scope=out`，项目本身在 `/tmp` 时仍按 `inWrite` 判定。
    - README 的默认值/检查方式/破坏性表已同步；日志报告的 playwright 正则改成只认真实调用
      （`npx/pnpm/node … playwright` 或 MCP 工具），不再把 URL 里的 `playwright-token` 算进去。

### 已实现并验证

- 会话生命周期：新会话的 `session_start` 重置（`enabled=false`、默认模式、清空授权）；
  同一 session id 的重复 emission（启动重绑定）保持状态。`src/index.ts` 里 permission 的
  `session_start` 注册顺序排在 autostart **之前**，保证 autostart 派发的 `/ask-perm ...`
  面对的是干净状态。
- 项目内定义 = `ctx.cwd` + pi-add-dir 会话条目 `add-dir:state` 里的目录
  （pi 无目录列表 API，读它的私有条目是软依赖，读不到就只用 cwd；
  `getBranch()` 按长度缓存，只在分支增长时重扫）。
- 带路径的工具：`read/grep/find/ls` → read，`write/edit` → write（按各自 `input.path`）；
  其余工具（MCP/subagent/…）无路径可判 → 按 write + 工作目录作用域。
- footer 状态 `perm i:A/A o:A/ask`（A=allow、a=ask、D=deny，按等级着色）；
  `before_agent_start` 追加系统提示横幅说明策略与「拒绝是策略决定、不要换等价命令重试」。
- 测试：`pnpm test` 61 个文件 / 1064 测试全绿；`pnpm check:compat` 强制窗口
  1.3.0–1.6.1 + 向后探针 1.2.x / 1.1.x / 1.0.x / 0.99.x 全绿（floor 0.99.0）；
  真实 pi 1.6.0 冒烟（`pi -ne -e ./src/index.ts ... 'Reply with exactly: OK'`）回 OK 无警告。

### 补充：同一会话的 `session_start` 可能发多次

宿主的 runtime 重绑定（启动期出现 `session_shutdown` → `session_start(reason=startup)`
的序列）会让同一会话再次收到 `session_start`。若按「每次 emission 都重置/重放」处理，
autostart 会重放第二遍（提示出两次），permission 会把刚开启的状态清掉。
两个功能现在都**按 session id 去重**：同一 id 的再次 emission 不重放、不复位
（`autostart` 的 `replayedSessions` / `permission` 的 `currentSessionId`）；
`/new`、`fork`、`/resume` 等真正换会话的路径 id 会变，行为不变。

### 审批日志（approval log，2026-10-24）

目标：把「审批请求 → 拆解结果 → 用户选择」完整留下，积累后反哺自动化判定（更准的
目标识别、`/tmp` 一类安全目录直接放行、playwright 常用模式的正则/规则）。

**决策（崔总 2026-10-24 定稿）**

- 默认只记**有价值事件**：ask+答复、自动 deny/block、会话授权放行、模式切换；
  普通 mode 自动放行不进日志（只计入会话 calls 计数），否则 1 万条窗口会被 read/grep 噪声吃掉。
  `PI_APPROVAL_LOG=all` 可全量记录，`off` 关闭。
- 默认脱敏：bearer / `token=` / `password=` / URL 内嵌凭据 / 已知密钥前缀 → `[redacted]`，
  记录标 `redacted:true`；其余原文保留（命令原文是挖掘对象）。
- 单文件上限 = 1000 条**或** 8 MiB；最多 10 文件；创建第 11 个删序号最小的。
  典型 15–30 MB，硬上限 80 MB。
- 分析脚本本期一起做（`scripts/approval-report.mjs`）。

**落位**

- `src/lib/approval-log.ts`：滚动 JSONL 写入器 + 信封（`v/ts/session/pid/pi/ext/os/model/cwd`）
  + 截断/脱敏 + fail-open。**懒初始化**：第一次要写记录才建目录/读计数；没有事件时零 IO。
- `src/lib/gates.ts`：总线是唯一同时看得到「请求 + 答复 + 最终结果」的地方。计数**按 session id
  分槽**（同一进程里父/子会话交替时不会互相冲刷，槽位上限 8，超了按插入序淘汰并先落盘），
  `session_shutdown` 只落盘被销毁的那个会话（子会话结束不会把父会话摘要劈成两半）。
  `answer.ms` 是工具调用被阻塞的总时长，`answer.queueMs` 是其中排在另一条弹窗后面的时长，
  两者相减才是操作者的决策时间（同一 assistant 消息里的并行调用会排队）。
  `AskRequest` 新增 `audit`（功能自带的结构化上下文）与 `settle`（答复后返回补丁，如授权）；
  `block` 支持 `audit`。总线写 `ask`/`block`/`session` 记录；`present` 抛错也走 settle。
  被更早 gate 拦掉、从未弹出的 pending ask 记 `outcome:"not-presented"`，不静默丢失。
- `src/features/permission/audit.ts`：把 units（含 opaque/note/targets 的 canonical、effect、
  in/out）、verdict（action/layer/unit/target/grantScope/grantRoot|grantDigest）和
  `modes`/`roots`/`prompt` 组装成 payload；`PolicyDecision.layer` 是新加的机器可读层
  （`mode/secret/session-allow/session-deny/session-command/danger/privileged/temp/opaque/unresolved/empty`），
  分析时不再解析英文 reason。
- `src/features/permission/index.ts`：ask/deny 附带 payload；会话授权放行写 `event:"allow"`；
  `/ask-perm` 真实状态变化写 `event:"mode"`（source=args|panel|toggle，via=autostart|manual）。
- `src/index.ts`：创建一个 `createApprovalLog()`，同时传给 gate hub 和 permission。

**磁盘与失败**

- 追加用 `appendFileSync`（`O_APPEND`）+ 不 fsync；事件跟工具调用走（秒级），
  顺序追加由页缓存/延迟分配合并，物理写≈逻辑写，SSD 磨损可忽略。
- 每次写入前 `readdir`（≤10 个名字）+ `stat`，用来发现多进程轮转/文件被删；
  轮转 = 新建 + `unlink` 最老文件，不重写、不 compaction。
- 首次写入/启动时读最新文件数一次行（≤8 MiB）；崩溃留下的半行先补 `\n`，读侧跳过坏行。
- 多进程：写入前用 `stat` 比对并只对「新增字节区间」数换行（`countNewlines`），把别的进程写入的行
  并进自己的计数——否则「每文件 1000 条」会静默变成「每进程 1000 条」。两人同时越过边界最多
  各超 1 条（检查在写入前，无法在不加锁的前提下更严）；极端竞态最多丢 1 条。
- 单条记录序列化失败（例如混进一个 `JSON.stringify` 不接受的值）只跳过该条并警告一次，
  **不关闭日志**；只有 IO 失败才 fail-open 停写。
- **fail-open**：日志不可写只警告一次并禁用本进程日志，绝不改变判定；与 gate 的 fail-closed 分开。
- 目录 `0700`、文件 `0600`；`write`/`edit` 正文不落盘（只 path+字节数）。

**分析**

- `pnpm approval-report [--dir …] [--since …] [--top N] [--min N] [--json]`：答复分布/中位耗时、
  层分布、目标根目录 × 答复、候选放行/拒绝规则、opaque 缺口、重复 ask 模式、playwright 专项、
  模式切换、会话计数（ask rate）。
- 记录字段足以离线算命令签名；签名不写进日志，换挖掘口径不用改 schema。

**已验证**

- `pnpm test` 61 个文件 / 1064 测试全绿（新增 `approval-log.test.ts`、`gates.audit.test.ts`、
  `permission/audit.test.ts` 与 permission 的 mode/payload/session-grant 集成用例）；`pnpm typecheck` 绿。
- 轮转（1000 条/8 MiB、10 文件、第 11 个删第 1 个）、崩溃尾部、双写者计数并入、脱敏、记录上限、
  单条不可序列化只跳过不关日志、不可写目录 fail-open、并行调用的 `queueMs`、
  多会话计数隔离、a/s/d/f/cancel/not-presented、临时目录直通、设备 sink 操作数、
  `echo`/`printf` 非路径参数均有用例。
- 真实 pi 1.4.0 冒烟（tmux 交互）：autostart 派发 `/ask-perm` → 模型执行
  `echo … > /tmp/.../out.txt` → 弹窗按 `s` → 文件写出；日志依次出现 `mode`、`ask`
  （`answer.choice=allow-session`、`grant.root`、`ms` 与 `queueMs`）与 `/quit` 时的 `session` 摘要
  （`calls=2 / asks=1`，第二次写由会话授权放行，另记一条 `event:"allow"`、`layer=session-allow`）。
  直通优化后的复测：`/tmp` 写 + `curl -o /dev/null` 无弹窗（`asks=0`）；`/var` 写仍弹窗，
  按 `d` 后文件未创建、日志记 `outcome=blocked / choice=deny`。

### 首轮真实日志（2026-10-26）

本机 `~/.pi/agent/approval-log/audit-000001.jsonl`：7 次弹窗 + 1 次 `.env` 拦截，7 次全部 `s`。

| 次数 | 原因 | 结论 |
| --- | --- | --- |
| 2 | `curl -o /dev/null` 把设备 sink 当写目标 | A 修复；顺带避免误授权整个 `/dev` |
| 2 | `/tmp` 下写（curl 下载、`git show > /tmp`） | B 修复；不再需要 `/tmp` 宽授权 |
| 1 | `echo` 消息里有 `/` + 未解析变量 → opaque | A 修复（echo/printf 参数非路径） |
| 1 | 字面量 `for f in …` 的 `$f` 在路径位置 | **待解析器**：字面量 for 展开；当前仍 opaque |
| 1 | `wc -l < "$f"` 的未解析**输入**重定向 | **待解析器**：只读元数据命令的未解析输入；当前仍 opaque |
| 1 | `grep ... .env` | **正确拦截**，不动 |

A+B 落地后这批 7 次里 5 次免弹；剩余 2 次是解析器能力问题。真实冒烟：`/tmp` 写 +
`curl -o /dev/null` 无弹窗（`session` 摘要 `asks=0`）；`/var/pi-perm-smoke-out.txt`
仍弹窗，按 `d` 后文件未创建。

### 日志驱动优化（2026-11-12）

本机审批日志（`~/.pi/agent/approval-log/audit-000001.jsonl`，491 条记录 / 61 次 ask）回放：
把每条 ask 的 command 重新喂给 `parseCommandUnits` + `decideProgram`（记录里的四格模式与
roots，空授权表），**52 条仍会 ask**。逐类修掉并经第三方复查撤回不安全放宽后剩 **21 条**，
且都属有意 fail-closed：

| 类别 | 修法（`units.ts`） |
| --- | --- |
| 引号内结尾 `$`（`grep "</div>\s*$"`）被 env 代理展开成变量 | 代理对空 key 返回字面 `$` |
| 单引号内的反引号被当成命令替换 | `extractSubstitutions` 改成引号感知 |
| 换行被 shell-quote 当空白 → 跨行命令**合并** | `stripComments` 把未引用换行变 `;`，`\\⏎` 当续行删除。`ls⏎rm -rf x` 曾被解析成一条 `ls`（**漏判写**），这是安全修复 |
| 纯赋值段 `f=…jsonl` 被当写 | 赋值段不产生 unit；普通赋值不跨命令展开（缺控制流分析会误判） |
| `for f in a b; do …"$f"…; done`、`for d in /a /b; do git -C "$d" …; done` | 字面量 for 展开（非字面量/含空白值/组合 >64/变量被重赋值或修改时保持 opaque；嵌套同名变量按内层） |
| `env` / `env FOO=1` 被当 "wrapper runs no visible command" | 读单元 |
| grep 家族的首个位置参数（模式）被当路径/glob | `GREP_VALUE_OPTS` + pattern index；模式不产生目标 |
| `%{http_code}\n`、`\s*` 里的反斜杠被 `looksLikePath` 当路径 | 反斜杠只在盘符/UNC 上认（POSIX 目标是既有一致口径） |
| `curl -w/-H/-d/…` 的值被当路径操作数 | `DATA_VALUE_OPTS` 按命令声明 |
| 未解析的输入/输出重定向 | 均保持 opaque；评审确认跳过输入会绕过 `outRead=ask/deny`，已撤回该放宽 |
| `docker compose ps` 被当写（项目外 → ask） | 容器只读子命令表；`exec`/`run`/`rm`/`build` 仍是写 |

剩余 21 条的组成：`docker exec` + 未解析变量、未解析输入/输出重定向、`node -e` / `python3 -` /
ssh 嵌套引号、`$(basename)` 产生的未知输出目标、`sed -i $FILES`（值来自命令替换）、进程替换、
`cd -`、`sudo`、mysql heredoc（真写 SQL）—— 都是有意询问，不再优化。

回归用例在 `units.test.ts` 的 `approval-log regressions`（23 例）与 `policy.test.ts` 的严格读模式
重定向用例；另有变量遮蔽、条件赋值和 `read` 改值的反向安全用例。

### 已知边界（有意为之，README 已声明）

- 读命令的**裸文件名参数**不判定（`cat notes.txt`）：默认模式下无影响，
  但把 `out-read` 调成 ask/deny 时绝对路径以外的读目标不会被问。这是「读盲区」，不是写盲区。
- 启发式，不是沙箱：进程替换走 opaque、相对 Windows 路径拼写（`dir\\file`）落进读盲区
  （绝对盘符/UNC 仍识别；实测目标是 POSIX）、PowerShell 不拆解、子代理会话不继承父会话状态。
- 项目内的破坏性操作靠固定表兜，不靠沙箱。

## Feature: keep（会话暂存：`/keep-quit` · `/keep-load` · `/keep-drop`，2026-11-25 立项并实现）

问题：一个项目里多条任务并行时，会话一多就记不住哪个做完、哪个没做完；`/resume` 把所有会话按时间混排，既不分「做完/没做完」，
也不管同一条被两个进程同时打开。方案是**入账 / 已载入两个正交维度**：`keep` 表示没做完（只有 `/keep-quit` 写、`/keep-drop` 清），
`load` 表示某个 pi 进程正开着它（载入时写、干净退出时清）。载入**不**出列——这是崔总 2026-11-25 定的，理由是自动出列
会让「已载入」无处安放，也没法重开一个判断错的会话。

### 落位

| 文件 | 职责 |
| --- | --- |
| `src/features/keep/ledger.ts` | 四种事件（`keep`/`drop`/`load`/`unload`）、校验、`deriveKeepState` 纯函数折叠、owner 探活与就地补 `unload`、`currentHost()` 用 `os.hostname()` |
| `src/features/keep/store.ts` | 当前会话事实（`getSessionFile` 为空的 in-memory 会话直接拒绝）、笔记缺省三级回退、`rebuild` 的尾部扫描 |
| `src/features/keep/format.ts` | 行文本（`○`/`●` + 年龄 + 笔记）、notice、`[keep] Resumed …` 文案，全部纯字符串 |
| `src/features/keep/picker.ts` | 专用列表组件（分组、置灰、`ctrl+r`、滚动窗口）+ 切换前三选对话框（这个复用 `SelectList`） |
| `src/features/keep/index.ts` | 三个命令、启动 notice、`session_shutdown` 的 `unload`、`keep:resume` 消息渲染 |
| `src/lib/event-ledger.ts` | 追加 / 解析 / 去重 / 自愈换行的通用机制，UAT 账本与本账本共用（UAT 的公开 API 不变） |

### 不变量（易破的几条）

- **载入不出列**：出列只有 `/keep-drop` 与列表里的 `ctrl+r`。
- **「已载入」是记账不是锁**：硬杀会留脏标记，所以列表里已载入的行仍然可以选中、可以强行重载；同 host 上 owner pid
  不存在时，读列表就地补一条 `unload`（幂等，重复读只是多一行空操作）。跨 host 的 owner 不做探活，按「还活着」算。
- **不调用 `SessionManager.list` / `listAll`**：本机实测本项目 109 会话 576 ms、全量 648 会话 9.8 s。日常只读账本。
- **当前会话不出现在列表里**（它的命令是 `/keep-quit` 与 `/keep-drop`），notice 也只统计当前项目、且不计当前会话。
- **`own` 记录必须在 `withSession` 里认领**：`switchSession` 期间旧会话的 `session_shutdown(resume)` 先于 `withSession` 触发，
  在 switch 之前写 `loadedHere` 会让旧会话的收尾把**新载入**的标记解掉（2026-11-25 冒烟实测踩到，账本里出现相邻的 load+unload）。
- **`session_shutdown` 只有 `reload` 不解锁**：其余 reason 都表示会话真的离开了。
- **`/keep-load` 不注册 `getArgumentCompletions`**：pi 会在 Enter 时应用高亮补全，从而吞掉裸命令（实测 `/keep-load 1` 变成
  `/keep-load --all`）。子命令写在 description 与「没有待办」的提示里。
- **`ctrl+r` 只在我们的选择器里消费**：宿主的 `app.session.rename` 属于**会话选择器作用域**，不在 `tui.altScreen.*`
  也不在全局表。升级宿主时必须重跑 `pnpm check:keybindings ctrl+r`；真机按不出来先上报再换键。
- 运行时文案一律英文（notify、列表、notice、拒绝理由）。

### 已实测的宿主事实（pi 1.6.0 / tmux，0.99.0 的 `types.d.ts` 同样具备这些原语）

- `ctx.switchSession(path, {withSession})` 真的切换，事件序 `session_before_switch(resume)` → `session_shutdown(resume)`（旧）→
  `session_start(resume)`（新）→ `withSession`；**切换后旧 ctx 立即 stale**，后续动作只能写在 `withSession` 里。
- `ctx.shutdown()` 走 `/quit` 的同一交互式关停路径（`session_shutdown(quit)` 后退出）；宿主收尾链无超时，别的处理器挂住时这里就只能等。
- 空会话从不落盘：`getSessionFile()` 有值但文件不存在，所以 `/keep-quit` 必须先查「有对话」。
- `pi.appendEntry`（`custom` 条目）不进模型上下文，`sendMessage`（`custom_message`）才进——备注走后者、面包屑走前者。

### 已实现并验证（2026-11-25）

- `pnpm typecheck` 绿；`pnpm test` **61 文件 / 1064 测试**全绿（keep 41 例：折叠/探活/补写/笔记回退/rebuild/四条拒绝理由/取消回滚/`--all` 过滤/picker 键位）。
- 真实 pi 1.6.0 + tmux 冒烟（`-ne -e ./src/index.ts`，独立 `--session-dir`）：`/keep-quit` 后账本落 `keep`、进程退出；重开新会话
  notice `2 not loaded`；`/keep-load` 列表 `○`/`●` 两段（用 `capture-pane -e` 确认置灰色值不同）；enter 载入后注入 `[keep] Resumed …`
  且账本**只有 load 没有 unload**；已载入的行可以强行重载；`kill -9` 持有进程后下一次读取补一条 `unload`（两个 owner 全灭 → 回到 `○`）；
  `ctrl+r` 不载入直接移出；`/keep-drop` 移出当前会话；`/keep-load 1` 与裸 `/keep-load` 都正常；删掉账本后 `/keep-load rebuild`
  从面包屑恢复 2 条（原时间戳保留）；`--all` 跨项目列出并带项目列；切换前三选对话框在真实终端里渲染正常，
  选 `Keep it & load` 先给当前会话入账（账本出现两条 keep + 一条 load）。

### 已知边界（有意为之）

- 不是锁：两个进程仍可同时打开同一会话文件（会静默分支），这里只记录、不阻止；`pi -ne` 与 headless 进程不写 `load`，在这里不可见。
- 账本会长期保留 `missing` 条目（会话文件被删），只能靠 `ctrl+r` 清；不自动清理（自动清理要猜，猜错就是丢任务）。
- 不压缩账本（一次操作一行）；跨机器共享 agent dir 时 `load` 无法探活，按已载入显示。

## Feature: spec（`/ask-spec` 浏览器批注式规格评审，2026-11-11 实现；2026-11-16 由 `/ask-plan` 改名）

`/ask` 讨论 → `/ask-spec` 调研 → 写 `specs/<slug>.md` → 浏览器逐段批注 → 多轮 → 批准 → 实施。
`/ask-plan` 保留为别名；工具是 `spec_submit`；不带主题时默认 `specs/spec.md`（不再生成 `specs/plan.md`）。

### 不变量

- **绝不切模型**：`src/features/spec/` 下不出现 `pi.setModel`；评审期用什么模型就是会话当前模型。
  （plannotator 会在计划流里自动换模型，2026-09 因此烧掉崔总 100+ 元现金额度。）
- **`spec_submit` 立即返回**，回合当场结束；决定稍后以 `pi.sendUserMessage` 作为新消息回来。
- **批注与决策解耦**：approve/deny 都携带批注，只决定「实施 / 改 spec」；批准额外把
  **被批准版本的原文**贴回去（文件可能在提交后被改过），并要求模型把实施任务记进 `todo`。
- **块 = 空行分隔的段落**（围栏代码块不切分），diff 用 同 id → LIS 锚点 → moved，其余按字符二元组
  Jaccard ≥ 0.5 配对为 modified，最后才是 added/removed。改三行不该看起来像整篇重写。
- **WSL 打开器**：绑 `0.0.0.0`、URL 用 eth0 IP、优先 `wslview`/`cmd.exe start`/`powershell`，
  WSL 下不先试 `xdg-open`（本机 `/usr/bin/google-chrome` 存在，xdg-open 会开出看不见的浏览器）。
- **评审期只写 markdown**：gate 拦 write/edit 的非 `.md` 目标；bash 用 permission 的
  `parseCommandUnits` 再拦一道「工作区内、非 `.md` 的确认写入目标」（`echo x > src/a.ts`、`cp a.ts b.ts`）。
  opaque 单位不重复拦（permission 已 fail-closed），项目外临时文件照放。
- **访谈协议**：`INTERVIEW_GUIDE` 要求「一轮 1–4 问、先问再写、能读的不问」；
  提问工具按 `pi.getAllTools()` 探测，装了就点名 `ask_user_question`，没装就说「用纯文本问」——
  那个工具是第三方扩展（`@juicesharp/rpiv-ask-user-question`），不是宿主内建。
- **闸门复用 permission**：进入评审期用 `src/lib/permission-control.ts`（registry，与 startup.ts 同款）
  调用 `enableDefaults`，退出/批准 `restore`；用户中途手动改过以他的手改为准。
- **评审页只保留有用的东西（2026-11-16 重做）**：暖纸底 + 玫瑰/珊瑚色的双栏页面（左阅读列、
  右「本版统计 + 可点击批注索引」）；全局批注卡片即使编辑框关着也常显；底部决策栏左侧是
  `Only changed` / `Global notes`，中间只放笔记总数，右侧 `Send feedback` / `Approve spec`。
  「How review works」「Approve means go」「Two ways out」这类解释性卡片不再实现，顶部红字提示已删。
- **命名**：命令 `/ask-spec`（别名 `/ask-plan`）、工具 `spec_submit`、默认文件 `specs/spec.md`；
  相位标记 `SPEC_PHASE_TOOL`，同时识别旧的 `plan_submit`（升级前已打开的会话）；评审历史
  `<agent-dir>/ask-plan/` 在首次使用时迁移到 `<agent-dir>/ask-spec/`，迁移失败就继续用旧目录。

### 落位

| 文件 | 职责 |
| --- | --- |
| `src/features/review-page/blocks.ts` | 段落切分（围栏感知）、归一化哈希、重复段落出现序号 |
| `src/features/spec/diff.ts` | 块级 diff 三态 + moved |
| `src/features/review-page/render.ts` | markdown 子集 → HTML（先转义，无原始 HTML 透传） |
| `src/features/spec/feedback.ts` | 批注 → 固定模板的模型消息（英文） |
| `src/features/spec/prompt.ts` | 评审横幅 + spec 骨架（12 段）+ 段落书写纪律 |
| `src/features/spec/store.ts` | `<agent-dir>/ask-spec/<slug>/vNNN.md` + `state.json`（原子写、50 版上限、旧目录迁移） |
| `src/features/spec/server.ts` | 评审路由（`/api/state`、`/api/annotate`、`/api/decide`）；`active()` 报告句柄死活；HTTP 壳在 `src/lib/web-review.ts` |
| `src/lib/opener.ts` | WSL 探测、绑定地址、打开器选择（spec 与 uat 共用） |
| `src/features/spec/index.ts` | `/ask-spec` + `/ask-plan` 别名、`spec_submit`、gate、系统提示注入、决策回投 |
| `src/lib/phases.ts` | `SPEC_PHASE_TOOL` + 旧 `plan_submit` 识别；phase 名 `spec` |
| `ui/` | Solid 1.9 + Vite 8 单页，产物落 `src/features/review-page/assets/`（`pnpm ui:check` 防过期） |
| `design/ask-spec.ptr` | 已确认的评审页设计稿（暖纸/玫瑰、双栏、批注索引、底部决策栏） |

### 已验证

- `pnpm typecheck` 绿；`pnpm test` **61 文件 / 1064 测试**全绿（spec 113 例）；`pnpm ui:typecheck` 绿；`pnpm ui:build` 已更新 assets（`ui:check` 的 git-clean 断言需在提交 assets 后成立）。
- 命令：`/ask-spec` 与 `/ask-plan` 指向同一个 handler；不带主题默认 `specs/spec.md`；
  `spec_submit` 默认不在工具集里，进入评审期才激活；旧 `plan_submit` 仍被相位判定识别。
- 评审期写入边界：`echo x > src/a.ts` / `cp a.ts b.ts` 被 gate 拒；写入 `specs/` 下的
  `.md`、项目外临时文件与纯读命令放行（`spec/index.test.ts` 的 write-boundary 用例）。
- 访谈协议：未装提问扩展时用 "ask in plain text"，装了才点名 `ask_user_question`；
  `INTERVIEW_GUIDE` 断言「一轮 1–4 问 / 能读的不问」。
- 真实宿主探针：`ask-spec[extension]` 已注册，`spec_submit` 默认不在工具集里（进入评审期才激活）。
- 页面：Playwright + mock state 复核双栏、全局批注卡片、批注索引跳转、编辑器、底部
  `Only changed` / `Global notes` / 笔记计数 / 决策按钮；真实 pi 1.6.0 冒烟（`pi -p --no-extensions -e ./src/index.ts --tools ...`）回 `OK`（1.5.2 已复验过评审页）。
- WSL 实测（2026-11-11）：`cmd.exe /c start "" "http://<wsl-ip>:port/"` 能从 Windows 打开到 WSL 内的服务器；
  绑 `127.0.0.1` 或访问 `localhost` 均连不上。
- 历史评审记录：`.agents/implementations/2026-11-11_ask-plan-review.md`（改名前的实现轮）。
- 本轮实施记录：`.agents/implementations/2026-11-17_0144_ask-spec-review-page.md`。

### 已知边界

- 服务器与 pi 同进程：`/reload` 或会话结束即关端口；不支持「关掉 pi 后网页还活着」。
- **决定后服务自杀，下一次提交必须重开**：`/api/decide` 成功后 1.5 s 关端口（`closeDelayMs`），
  句柄的 `active()` 从接受决定那一刻起就是 false。`spec_submit` 只在句柄仍活着时 `broadcast`，
  否则重起一个服务并 `open()` 新窗口——旧句柄广播出去没有任何页面收得到，打印的也只是死端口
  （2026-11-25 的真实故障：v2 提交复用了死句柄，浏览器不再弹窗）。`/ask-spec open` 同理：
  服务已关就重起再开页，而不是对着死 URL 再 `open` 一次。
- **重启不重置评审状态**：版本、批注、决定都在内存的 `SpecSession` 里，并且随每次提交写进
  `<agent-dir>/ask-spec/<slug>/state.json` + `vNNN.md`；重启的只是 HTTP 服务，历史抽屉与
  `?version=N` 回看都还在。重开窗口是「新窗口」，不是「新评审」。
- 批注按版本存放：新版本会清空上一版批注（不做跨版本重新锚定，这是块模型换来的简化）。
- 端口固定从 **7600** 起、**只在本百位段内走**（7600–7699，`portAttempts` 可注入、仅测试用），不做配置项（崔总 2026-11-11 定；段位 2026-11-26 从 34xx 上移到 76xx——34xx 常被 WSL / Windows 端口转发先占掉，页面静默丢端口与没启动长得一模一样）；spec / uat / talk 共用这一池，多个会话/多次重启各自走这条递增链，互不抢端口；整段用尽就报错不启动（`portWalk` 与 `startWebServer` 的用例在 `src/lib/web-review.test.ts`）。
- `/ask-plan` 别名只保证命令入口；提示语、日志与文档一律以 `/ask-spec` 为准。

## Feature: talk（`/ask-talk` 回复批注，2026-11-25 实现）

对话里最贵的一步是复述：「第三段那个判断不对」要么抄原文，要么绕三句指位置。`/ask-talk` 把 agent **最近一条正式回复**当成文档摊在浏览器里，逐块批注 + 底部一句话，`Continue` 之后作为一条消息回到对话。

### 不变量

- **不是相位**：不注册工具、不改工具集、不动权限、不进系统提示 → 不用时零常驻 token，`/ask`、`/ask-spec`、`/ask-uat` 期间都能用。
- **只回批注与那句话**：`## Notes on your last reply`（每条 = 章节路径 + 引用块 + note）+ `## Operator's message`；**不回原文**——它本来就在模型上下文里。唯一例外见下。
- **每个非标题块一条 note、无 verdict**、无版本/diff/批准；再跑一次 = 刷新（同一回复保 note，换了回复清空，因为块 id 是内容哈希）。
- **每次执行都打开窗口**：新快照、同回复重跑、换回复刷新三条路径都会再调一次 opener——命令本身就是「给我看」，而页面是 OS 打开的标签页，广播到一个已关掉的 tab 等于什么都没发生（`/ask-spec` 每次 submit 也都会开窗）。
- **页面标题 = 当前会话标题**：并行会话里每个窗口都在批注「最近一条回复」，不写会话名就分不清谁是谁。取 `sessionManager.getSessionName()`，没有名字时回落首条 user 消息；两者都没有才显示 "Untitled session"。
- **`!ctx.isIdle()` 一律拒绝**：assistant 消息在 `message_end` 才落盘，跑到一半打开只会静默显示上一轮。
- **`Continue` 只提交一次**：会收集仍在编辑器里、尚未点 Save 的批注；`sent` 之后写路由全 409、端口 1.2 s 后关闭；页面是 OS 打开的标签页，`window.close()` 多半被拦，sent 态才是真正的兜底。
- 运行时文案英文。

### 取「最后一次正式回复」

`extractLastReply(ctx.sessionManager.getBranch())` 从末尾往前扫：跳过非 `message`；`role === "assistant"` 只取最后一个 thinking/toolCall 边界之后的连续 `text` 段（同一 assistant 消息内的前置过程话也排除）；撞到 `user` / `custom_message` / `compaction` / `branch_summary` 就停（回合边界）。纯工具调用的 assistant 继续往前找，不吃掉上一轮的答案。

引用块裁到 600 字符、按行切、切在围栏里就补闭合（省略号放在围栏内，避免它变成代码块之后的散文）。**Continue 到达时**重查 `entryId` 是否仍在 `buildContextEntries()` 里；被 compact 挤掉才整篇附一次全文——那时引用指向模型看不见的文字，回贴是必要的。off / 换会话后，旧快照的在途 Continue 直接丢弃。

标题块**去掉 `##` 再引用**：`### Alpha` 下面紧跟 `> ## Alpha` 读起来是 blockquote 里的嵌套标题，是纯噪声。

### 页面：一份 bundle，两种模式

`ui/src/App.tsx` 先取一次 `/api/state`，按 `mode` 渲染 `SpecView` 或 `TalkPage`；块渲染、批注卡、索引条、回顶按钮是共享组件（`ui/src/shared.tsx`），分支只在顶栏/右栏/底栏/块头/note 编辑器这几处。服务端两套路由、一套 HTTP 壳（`lib/web-review.ts`），**talk 与 spec/uat 共用 7600 起的端口池**（见 spec 的端口段），页面靠标题区分而不是靠端口段。

**两种模式都有手动关闭**：顶栏语言切换右侧的 `ClosePageButton`（shared）先走原生 `window.confirm` 二次确认；确认后 `POST /api/close` 只关闭该页的 HTTP 服务，**不调用 `onDecision` / `onContinue`、不 `sendUserMessage`，也不改 spec 的决定或 talk 的 `sent` 状态**。响应先返回、下一 tick 关端口；页面取消 SSE，talk 同时取消未执行的 notes 保存防抖。`/reload` 导致服务不可达时仍进入关闭终态（3 秒超时兜底），并区分「服务已关闭 / 无法连接」文案。外部打开的标签页可能拒绝 `window.close()`，此时 `ManualCloseNotice` 是最终兜底。关闭不退出 spec 相位；下一次 `/ask-spec open` 或 `/ask-talk` 可重开同一状态。

### 索引条与回到顶部（两种模式通用）

- 折叠态：16px 宽、2px 高、6px 间距的一列横杠，贴**内容区右缘**（页面右侧留白），宽度按层级递减，颜色 `#D3B3AC`（中性灰在暖纸底上发脏），当前节用品牌色。**不做首尾淡出**：14px 的 `mask-image` 会把第一根和最后一根（以及停在首/尾的红色当前节）直接抹成透明。
- 超过 24 个标题等距抽样（保留首条与当前节）——精度不重要。
- 竖条自身受限：`max-height: min(52vh, 300px)` + `overflow-y: auto`（隐藏滚动条、`flex: none` 防止横杠被压扁），窗口很矮时竖条内部滚动而不是把两端顶出屏幕；当前节的横杠由 `createEffect` 滚进可视区（只改 `scrollTop`，不触发页面滚动）。
- 悬停整组展开 292px 浮窗（180ms 由右向左），复刻底栏面板语言（surface / 1px 边框 / soft shadow / blur）；离开 200ms 后收起，鼠标从横杠移进浮窗不会闪断；滚轮在浮窗内只滚列表。
- 点击：`scrollIntoView` 到块 → 块描边闪 1.2s（`.is-target`）；spec 模式下目标块被「只看改动」隐藏时先展开。
- 回到顶部：`IntersectionObserver` 盯 `.rail`，`!isIntersecting && rect.bottom <= 0`（**右栏整体滚出视口**）才出现；`bottom: calc(var(--footer-h) + 16px)`，`--footer-h` 由 `ResizeObserver` 写回 `:root`（talk 的输入框会长高）。**右缘对齐底栏**（`right: max(24px, (100vw - 1232px) / 2)`，即 footer 的右边）而不是对齐上面的索引条——索引条贴的是阅读列右缘，两者差 4–8px，看起来就是没对齐。≤1040px 单栏时索引条 `display:none`，回顶改判 `scrollY > 0.8 × 视口高`。

### 落位

| 文件 | 职责 |
| --- | --- |
| `src/features/review-page/{blocks,render,headings}.ts` + `assets/` | 两种模式共用的块模型、markdown 子集渲染、标题索引、构建产物（目录名不能用 `review/`——那是 `/ask-review`） |
| `src/features/talk/reply.ts` | 取最后一条正式回复（回合边界、thinking/tool 排除、fingerprint） |
| `src/features/talk/sections.ts` | 块 → 章节路径（外层在前，` > ` 连接） |
| `src/features/talk/message.ts` | 两段式消息（裁剪、补围栏、标题去 `#`、两种省略、compact 兜底） |
| `src/features/talk/server.ts` | talk 路由（`/api/state`、`/api/notes`、`/api/continue`、`/api/close`）与载荷 |
| `src/features/talk/index.ts` | `/ask-talk`（`off` 关闭）、刷新语义、会话生命周期、continue → `sendUserMessage` |
| `ui/src/{App,SpecView,TalkPage,shared}.tsx` | 模式分发、两个视图、索引条/回顶/可伸缩输入框/带二次确认的手动关闭 |
| `src/features/spec/server.ts` | `buildSpecState` 增加 `mode` 与 `headings`（跟随当前查看的版本） |

### 已验证（2026-11-25）

- `pnpm typecheck` 绿；`pnpm test` **61 文件 / 1064 测试**全绿（新增 talk 命令生命周期、快照刷新、Continue 时 compact 等回归）；`pnpm ui:typecheck` 绿；`pnpm ui:build` 产物在 `src/features/review-page/assets/`。
- `pnpm check:compat`：窗口 1.3.0–1.6.1 全绿（矩阵每版 1064 项全过），探针 1.2 / 1.1 / 1.0 / 0.99 全绿，**floor 仍是 0.99.0**、peer 声明一致（新代码只碰 `getBranch` / `buildContextEntries` / `sendUserMessage` / `isIdle`）。
- 真实 pi 冒烟：`pi -p --no-extensions -e ./src/index.ts --tools ''` 回 `OK`。
- 真实会话端到端（tmux + 独立 `PI_CODING_AGENT_DIR`）：模型回答后 `/ask-talk` → 页面在 3501 打开、`/api/state` 报 `items=4 headings=[(2,Alpha),(2,Beta)]` → `POST /api/continue` 带一条 note + 一句话 → 会话里出现**逐字节符合模板**的两段式消息（`### Alpha` / `> Alpha` / `- …` / `## Operator's message`），模型据此改了标题，端口随即关闭（curl exit 7）。
- Playwright 目检（真实 `buildTalkState` 产的 state + 构建产物）：talk 页 12 块、右栏统计与批注索引、底栏 pill + 输入框 + Continue；索引条 5 根横杠（2px/8px 间距）、悬停展开浮窗（缩进 + 当前节竖条）、点击跳到目标块（`scrollY 970`、`activeRow=2.1 The dialectic`）；回顶在 `rail.bottom=-405` 出现、`rail.bottom=165` 不出现；1024px 下索引条 `display:none`；输入框失焦 24px、聚焦四行 96px。

- 第三方复核后补测：新回复在原页面返回新块且 Continue 不回旧文；Continue 时 compact 会附全文；未保存编辑器内容进入提交；连续跳转只保留一个高亮并在 1.2 s 后清除；30 标题时折叠条不超过 24 根。
- 2026-11-26（实测修复同一轮）：`pnpm typecheck`、`pnpm ui:typecheck` 绿；`pnpm test` **61 文件 / 1064 测试**全绿（新增 `src/lib/web-review.test.ts`：端口池只在本百位段内走、整段用尽抛错；talk 命令新增「标题取会话名 / 回落首条 prompt」与「重跑也开窗」断言）。本轮未重跑 `pnpm check:compat`（无宿主 API 变化：`getSessionName` 已被 keep 在 0.99–1.6 用过）。Playwright 复验构建产物（mock state）：标题 = 会话标题（`document.title` 与 h1 同值，无名字回落 "Untitled session"）；索引条首尾横杠完整可见（去掉了 14px mask），矮窗口（330px）下竖条内部滚动、强制 60px 高时当前节自动滚进可视区（`scrollTop=111` 仍 `inView`）；回顶右缘与 footer 右缘在 1280 / 1920 均 0 偏差；输入框失焦 34.9px（clientHeight 33 ≥ line-height 20.9 + padding 12，单行不再被裁），三行内容聚焦 77px、失焦收成一行。
- 2026-11-26 手动关闭：spec/talk 顶栏语言按钮右侧新增共享 `ClosePageButton`，原生 confirm 二次确认；`POST /api/close` 只关 HTTP 服务，不触发 decision/Continue、不发消息；失联时进入 `ManualCloseNotice`。新增 4 项回归（两个 server 路由 + 两个命令集成），`pnpm test` **61 文件 / 1068 测试**全绿，typecheck / UI typecheck / UI build 绿，真实 pi 1.6.0 冒烟回 `OK`。Playwright 对构建产物实测：取消确认时零关闭请求；确认后两页都进入关闭终态并调用 `window.close`，mock 日志只有 close、没有 decide/Continue；预先停止服务后确认，显示「无法连接评审服务」而非谎称已关闭。

### 已知边界（有意为之）

- 索引只认 ATX 标题；setext（下划线式）与围栏内的 `#` 不算——与 `parseBlocks` 的块判定一致，锚点只到块不到行。
- 标题行即使没有前后空行也独立成块、进入索引，但不开放批注；其后的正文是单独可批注块。
- 同一回复再次 `/ask-talk` 不重载页面（避免覆盖保存防抖中的输入），但**每次都会重新打开窗口**（tab 可能已被关掉）；换成新回复才在原页面 `broadcast("refresh")`，服务端原位替换快照对象并清空 notes。
- 引用不等于原文：600 字符之外的文字要靠模型从上下文回忆；compact 之后那条会明显变贵。
- `window.close()` 关不掉外部打开的标签页——sent 态 + 关端口是唯一保证。

## Feature: uat（`/ask-uat` 验收台账，2026-11-12 实现）

### 定位

`/ask-uat` 只回答一个问题：**这一批交付里，哪些还没验过？** 验收单位是「用户可见行为」，
不是提交。实施侧写记录 + 一句话行为；UAT 侧把 N 条记录聚成 M 个验收项（N ≫ M），
页面只做三件事：看摘要、展开测试方案、勾掉。

### 数据模型

```text
.agents/uat/ledger.jsonl   # 只追加事件流（进 git；只住主仓）
.agents/uat/README.md      # 合同（框架拥有，refresh 可重写）
```

事件（每行一条，带 `v/id/ts/type`，读侧按 id 去重）：

| type | 写入方 | 语义 |
| --- | --- | --- |
| `candidate` | `record_change` | 一条实施记录的行为句 + 测试提示 |
| `batch` | `/ask-uat` | 一次聚类回合 |
| `item` | `uat_item` | 验收项（2–3 句摘要 + 步骤 + 证据记录） |
| `link` | `uat_item` | 新证据挂到已有项（N:M 的桥） |
| `check` / `uncheck` | 页面 | 验收决定，即时落盘 |
| `amend` / `merge` / `drop` | `uat_item` | 修订 / 合并 / 作废 |

派生（`deriveState`，纯函数）：
- `pending` = 磁盘上未被任何存活项引用的记录。**目录是兜底索引**，手写的记录也算待验收；
  `record_change` 只是补上行为句与测试提示，不是闸门。
- `reopened` = 项内最新证据时间 > 最后一次 `check`。「已验收」= 按当前证据集验过。
- `merge` 把源项的记录并入目标并隐藏源；`drop` 只标记，事件不删。

### 决策（崔总 2026-11-12 定）

1. **review 与 uat 分离**：`/ask-review` 只是多模型交叉核验，自由发挥、不落状态；页面不显示「审过」。
2. **实施报告保持散文**，桥另立账本；一条验收项可对应多条实施报告，一条报告也可落进多个项。
3. **聚类只在 UAT 侧发生**：实施会话并行且互相看不见，项的身份必须单点创建，否则必然重复。
4. **没有提交、不勾也行**：勾选即 `check` 事件；关页面不丢；已勾项可反选。
5. **页面只读 + 勾选**：不编辑、不排序、不评论、不指派；聚类不满意就在对话里让 agent 调 `uat_item`。
6. **账本只住主仓**：worktree 里的会话把记录与事件写主仓（`resolveProjectRoot` 走 `git worktree list`）。
7. **分钟精度**：`record_change` 写 `YYYY-MM-DD_HHMM_slug.md` + `# YYYY-MM-DDTHH:MM±HH:MM — 标题`；
   读取端宽容（旧文件名 / 秒级首行照读），审计对 14 天内不合规记录报 `W-REC-01`。
8. **每轮上限**：默认 40 条候选 / 12 个新项（`MAX_*_PER_RUN`），超出的留在 pending；
   页面顶部常显「还有 N 条未归类」。

### 落位

| 文件 | 职责 |
| --- | --- |
| `src/features/uat/records.ts` | 记录读写、规范首行/文件名、宽容解析、`readRecordText` |
| `src/features/uat/ledger.ts` | 事件类型、追加（自愈缺尾换行）、解析去重、`deriveState` |
| `src/features/uat/state.ts` | 主仓解析（worktree）、框架检测、快照加载 |
| `src/features/uat/record-tool.ts` | `record_change`（框架存在时激活） |
| `src/features/uat/item-tool.ts` | `uat_item`（仅 `/ask-uat` 期间） |
| `src/features/uat/prompt.ts` | 聚类工作单、阶段横幅、计数行 |
| `src/features/uat/server.ts` | `/api/state`、`/api/toggle`、`/api/report`、ledger mtime 监听 |
| `src/features/uat/index.ts` | 命令、相位、工具激活、空闲关服 |
| `ui/uat/` + `ui/vite.config.uat.ts` | 第二套 Solid 单页（产物 `src/features/uat/assets/`） |
| `src/lib/web-review.ts` | spec/uat 共用的 HTTP 壳（token、Host/Origin、端口池、静态文件、SSE） |

### 已验证

- `pnpm test` 61 文件 / 1064 测试全绿；`pnpm typecheck`、`pnpm ui:typecheck` 绿。
- 真实 pi 1.6.0 冒烟：`pi -p --no-extensions -e ./src/index.ts --tools ''` 回 `OK`、无 Extension 警告。
- 覆盖：记录解析/命名/同分钟防覆盖、账本坏行与重复 id、自愈换行、N:M、link 重开、
  merge/drop/amend、命令开页与聚类派发、页面勾选往返、未知项 404。

### 已知边界

- 一个进程只有一个 UAT 页面；多进程靠端口池（7600–7699，与 spec/talk 共用）并存，页面靠 ledger mtime 轮询收敛。
- 关页面不关服（`/ask-uat off` 或 2h 空闲才关）；`/reload` 后需重开。
- `record_change` 只在框架完备的项目激活（`state.toml` + `AGENTS.md` + 记忆合同 + `.agents/implementations/`）；缺失时 `/ask-uat` 直接拒绝并列出缺失项。
- 聚类质量由实施侧行为句决定；`hint` 允许写 `none: <理由>`，让「这次不用测」也是明确记录。

## Feature: whats-new（升级后首次启动的版本变更提示，2026-11-12 实现）

### 定位与硬约束

升级后第一次进入交互式 pi 时展示「上次运行的版本 → 当前版本」之间的变更，每个版本只展示一次。
**不注册 `/whats-new` 或任何其它斜杠命令**——本包只是插件，不为一个被动提示占用宿主的全局命令
命名空间（崔总 2026-11-13 定）。没有 on/off 命令、没有重播入口；完整内容直接看包内
`CHANGELOG.md`。

触发条件只有 `session_start(reason="startup")` 且 `ctx.mode === "tui"`：

| reason / mode | 行为 |
| --- | --- |
| `startup`（TUI） | 版本严格升高时展示，并记录当前版本 |
| `reload` / `new` / `resume` / `fork` | 不展示；进程内切换不是「重新进入」 |
| `print` / `json` / `rpc` | 不展示，也**不记**版本；留给下一次交互式启动 |

全新安装静默记录当前版本（没有上一版可对比）；同版本、降级、重装都不展示，也不倒退已记版本。
状态只有 `<agent-dir>/pi-toolkits-whats-new.json` 的 `lastSeenVersion`，原子写、损坏回落默认、
写失败不阻断会话。

### 发版前怎么添加更新信息（给实施 agent）

**发版前必须编辑 `CHANGELOG.md`，把这一版的用户可见变更写进已有的 `## Unreleased` 段落。**
一行一条顶层 `- ` bullet，英文，写操作者能看到的行为，不写提交哈希/内部重构/测试流水账。
不要自己改成版本号，也不要新建段落——`pnpm release` 会自动把 `## Unreleased` 改名为
`## <新版本> — <日期>` 并在上方补一个空的新 Unreleased 段。

```md
## Unreleased

- **feature-name** — what the operator can now do, in one sentence.
- **permission** — which prompt or behavior changed, in one sentence.
```

只认**顶格**的 `- ` / `* `；缩进的子 bullet 是给人看的细节，不进启动提示。空段落、缺段落、或
`package.json.files` 不含 `CHANGELOG.md` 都会让 `pnpm release` 在 bump/commit 前中止；
`--skip-changelog` 可显式跳过（该版没有公告条目）。发布门禁先把测试跑完再改 changelog，
避免失败留下半写状态。

### 实现

- 内容源是随包发布的 `CHANGELOG.md`，不在运行时拼 git 提交标题；`src/features/whats-new/changelog.ts`
  与 `scripts/lib/changelog.mjs` 共用同一套「顶层 bullet」口径。
- 启动提示最多 4 个版本 × 每版 6 条，超出指向 `CHANGELOG.md`。呈现用自定义会话条目
  （`whats-new:notice`）：invalidate 冲不掉、不进模型上下文；老宿主没有 `registerEntryRenderer`
  时回落 `notify`。
- 文件：`version.ts`（数值比较）、`changelog.ts`（解析/区间）、`paths.ts`（按
  `import.meta.url` 定位包内文件）、`store.ts`（已见版本）、`notice.ts`（文本）、
  `index.ts`（startup 门控与条目渲染）。发布侧提升在 `scripts/lib/changelog.mjs`。
- 测试在 `whats-new.test.ts` 与 `scripts/lib/changelog.test.mjs`；包含「不注册任何命令」的回归断言。

### 已验证与边界

- `pnpm typecheck` 绿；`pnpm test` **61 文件 / 1064 测试**全绿。真实 pi 1.6.0 冒烟（加载回 `OK`）；
  交互式展示行为在真实 pi 1.5.2 上复验过：预置旧版本后首启展示，第二次启动不再展示；
  单元测试断言不注册任何命令。
- print 模式不消费提示。最新修复与复验证据见本轮后续实施记录。
- 只在交互式 TUI 展示；多进程同时首启可能各展示一次（无锁）。提示文本与 changelog 用英文。

<!-- ask-init:begin workflow v1 -->
## Ask workflow

This project uses the `@andares/pi-toolkits` ask workflow. The steps run in this order:

| step | entry | what it does |
| --- | --- | --- |
| discuss | `/ask` | read-only consult; `scratchpad` is the only write channel |
| spec | `/ask-spec <topic>` | research, ask questions, write `specs/<slug>.md`, review it block by block in the browser, implement only after approval |
| record | `record_change` | after the work: write the change record and one user-visible behaviour sentence |
| review | `/ask-review` | optional third-party model cross-check (check + fix); it leaves no state behind |
| accept | `/ask-uat` | cluster pending change records into acceptance items, verify them on the page, tick them off |

Rules that are easy to break:

- Change records live in `.agents/implementations/`; new ones carry the minute in the name (`YYYY-MM-DD_HHMM_slug.md`) and repeat it in the first line (`# YYYY-MM-DDTHH:MM±HH:MM — title`).
- The acceptance ledger is `.agents/uat/ledger.jsonl`, append-only, committed to git, and belongs to the main checkout. Never edit it by hand: the tools and the page write it.
- Acceptance items are created by clustering on the UAT side, never by an implementation session.
- Specs go in `specs`, memory in `.agents/memory/`, evidence in `.agents/implementations/`.

<!-- ask-init:end workflow -->
