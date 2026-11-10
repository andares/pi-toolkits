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
  project — always use the pnpm form.

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

（当前：强制窗口 1.2 / 1.3 / 1.4 / 1.5，1.5 线含 1.5.0 与 1.5.1；向后探针 1.1 / 1.0 / 0.99 / 0.87，
**停在 0.87.x**——0.87 的 `ToolDefinition` 没有 `defaultActive`（`ask/scratch-tool` 与
`init/tool` 两处），且 `ToolCallEvent` 上没有 `parentToolCallId`（2026-10-24 审批日志、
2026-10-26 init 新增的依赖），typecheck 红属探测结论、不改代码；**public floor = 0.99.0**，peer 写 `>=0.99.0`。）

- 窗口每随一条新版本线发布向前滑一格（窗口恒定 4 条），掉出窗口的老线不是“坏了”，
  只是不再被强制保持绿色；它还在不在对外下限里，由**探针**说话：探得到就继续算兼容，
  探不到就停。历史：0.86.x → 0.87.x（2026-10-10，1.1 发布）→ 0.99.x（2026-10-13，
  1.2 发布）→ 1.0.x（2026-10-17，1.3 发布）→ 1.1.x（2026-10-23，1.4 发布）→
  1.2.x（2026-11-04，1.5 发布）。
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
    | README 命令速查里的 `pnpm check:compat` 一行 | 描述与当前策略一致（窗口 + 向后探针） |
    | AGENTS.md 的「当前」行 | 窗口线 / 探针线 / 停在哪个版本及原因 / floor / peer |
    | AGENTS.md「内建行为同步义务」 | 新窗口 + 逐文件变化结论 |
    | AGENTS.md 各 feature 的「已验证」块 | 窗口 + 探针结果 + floor + 测试数 |
    | 源码注释 | 支持声明跟 floor；逐版本事实按实际 diff（两类分开写） |

11. **提交与发布**：提交信息必须包含：新窗口线、窗口为何绿（或改了哪些代码）、探针停在哪 + 原因、
    public floor 与 peer、dist 漂移结论、键位结论、冒烟结果。随后 `pnpm release patch`
    （纯兼容性维护走 patch）。

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
不得为了对齐下限而外扩（例如 `compaction.js` 只在这里说 1.4.0 变过一次）。当前 1.2.0 → 1.5.1：
`usage-totals.js` 在窗口内只变过一次（1.5.0 给 `cost` 加了 `totalFromProvider` 合并规则，
已镜像；数值字段未动），`utils.js` 最后一次变化是 1.5.1（`truncateText` 换 `sliceHead`，
只影响我们从宿主导入的序列化器），`agent-session.js` 在 1.2.0（prompt 处理
重构成 `_prepareRun`/`_startRun`）、1.3.0（tool-restore 路径）、1.4.0（溢出恢复与
tool-restore）、1.5.0（摘要请求的 auth 解析改走 stream 函数自带的 runtime；`_applyToolLoadout`
按「保留顺序 + 追加新增」稳定下来，#11495）、1.5.1（五处，见下）各变一次，
但 `cycleModel` 在 1.2.0 → 1.5.1 字节级一致，`compaction.js`
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
  `await settleCredentialWrites()`，即同一条无界链上又多了两个 await——quit-guard 仍然必要。
- pi-tui 1.5.1：`SelectList`/`SettingsList`/键位相关文件**一字未动**；变化只有编辑器粘贴占位符
  修复、Markdown/Mermaid、终端图片、光标标记清理，以及 `tui-alt-screen.js` 的 Kitty 图片
  绘制顺序（搜索键分支仍在最上面，`ctrl+f` 依旧是选择器的死键）。键位表唯一变化是
  Windows/WSL 的 `app.clipboard.pasteImage` 变成 `["alt+v", "ctrl+v"]`（与我们三个键无关）。
- 破坏性变更两条均不涉及我们：`GrepOperations.readFile` 不再为上下文行回调（我们没实现
  GrepOperations）；OpenAI 兼容模型在「本轮禁用全部工具」时不再发 `"tools": []`（属宿主行为）。

## Release

- **前置条件：工作区必须干净**——release 提交只含版本号（`git add package.json`），
  有未提交变更时脚本会在任何改动前直接中止。否则未提交内容会被打包进 npm
  包（pnpm 从工作区打包）却不进 tag，造成「tag 内容 ≠ 实际发布内容」
  （v0.4.0 事故）
- `pnpm release <patch|minor|major> [--dry-run] [--skip-tail-check]` 一键发布：
  干净检查 → **上一版尾部校验**（见下）→ typecheck+test → bump → commit + tag
  （`scripts/tag-current.mjs` 打 `vX.Y.Z`，已存在则跳过）→ **自检：tag == HEAD 且
  工作区干净**（否则中止）→ `pnpm publish`（失败即中止，版本已锚定）
  → **npm 成功后**：只推当前分支；tag 的推送 / 远端校验 / Release 创建交给
  `scripts/lib/github-release.mjs`（与 `pnpm release:github` 共用同一条路径）——
  远端没有 tag 就推，哈希与本地一致才建 Release，指向别的提交就拒绝创建
  并给出人工修复命令（绝不 force、绝不给错版本建 Release）
  → **尾部自检（自动）**：这一版是否真的三处都有（`npm view` 有该版本、远端 tag
  同哈希、有公开的 Release），逐项打印 ✅/❌；不全只提示补建命令，不中止。
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
  `pnpm release` 的尾部自检已经逐版核实 npm / 远端 tag / Release 三处；`--audit`
  是「怀疑历史漂移」时的全量体检（比如某次被打断的发版没人补、或换了机器丢了
  本地 tag）。只在 npm 上、没有 Release 的版本，其提交会被下一版的
  `generate_release_notes` 吞进下一版（对照的是上一个已发布 Release），GitHub
  的版本线就与 npm 对不上。
  唯一的先例是 0.1.0（早期发版时 tag 还不在流程里）：**2026-11-04 已补建完毕**——
  tag 指向 `8a0e2fb`，建 Release 时用 `make_latest: false` + 回填 `created_at`，
  所以 Latest 与 `git describe` 仍是 v0.11.3（证据：
  `.agents/implementations/2026-11-04_backfill-v0.1.0-release.md`）。
- GitHub Release 依赖 `GITHUB_TOKEN` 环境变量（classic token 的 `repo` scope 或
  fine-grained 的 Contents: write 都够用；本机用的是 **classic token**）；未设置时
  只提示——且 `pnpm release` 会在 `pnpm publish`
  **之前**先警告一次：npm 会照常发布，Release 事后用 `pnpm release:github` 补。
  创建失败（403/422/网络等）后脚本会自动 `GET /releases/tags/{tag}` 查询确认：
  200 = 已存在（并发/重试/手动补建过）→ 视为成功跳过；404 = 真失败 → 提示可
  稍后重跑补建，均不影响 npm 已发布的结果
- `pnpm tag-current` 可独立使用：给当前版本打本地 tag（已存在跳过，不推送）
- **远端 tag 校验：推之前只探一次，推之后才退避重试**（默认 5 次、2s 起翻倍）。
  顺序是强制的，不是风格：`pnpm release` 只推分支、**不推 tag**，所以「push 之前
  探测到 tag 不存在」是**必然事件、不是竞态**——曾经对这一步也套了 5 次退避，
  结果每次发版白等 ~30 s（2+4+8+16）才去推，推完第一次就绿。重试只对「刚推完
  ref 可见性滞后」有意义：v0.7.3 发布时就出现过「tag 实际已推成功、校验却报
  不存在」，一次 `ls-remote` 报「不存在」不等于失败。脚本区分「远端不存在」
  与「哈希不同」：前者重试仍失败才提示推 tag，后者提示人工确认后才可 `--force`。
  看到不一致**先手动 `git ls-remote origin refs/tags/vX.Y.Z` 复核**：哈希一致
  就说明只是竞态，此时**不要** force-push（会把同一个 tag 重推一次），重跑
  `pnpm release:github vX.Y.Z`（幂等）即可。
- 发布失败回滚：`git tag -d vX.Y.Z && git reset --hard HEAD~1`
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

- 测试：`pnpm test` 32 个文件 / 660 测试全绿；`pnpm check:compat` 在强制窗口
  1.2.0–1.5.1 全绿，向后探针 1.1.x / 1.0.x / 0.99.x 也全绿、0.87.x 因 `defaultActive`
  停探（不改代码）—— **public floor 0.99.0**，peer `>=0.99.0`。
- 真实 pi 1.5.1 冒烟（`pi -p --no-extensions -e ./src/index.ts --tools ''` 回 `OK`）；
  历史冒烟（1.4.0，项目 autostart 派发 `/ask` → 模型调用 `scratchpad`）：
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
   不变。逐函数事实：`_tryExecuteExtensionCommand` 在 0.99.0–1.5.1 全区间逐字节一致
   （1.3.0 → 1.4.0、1.4.0 → 1.5.0、1.5.0 → 1.5.1 已逐函数 diff 复核）；`sendUserMessage`
   只在 1.5.1 变过一次（同一次抽取），因此不能再声称它全区间一致。
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
`W-ROOT-01/02` 根下 agent-only 目录 / 零字节文件 · `W-TODO-01` todos 仍在 ·
`W-OVERRIDE-01` `AGENTS.override.md` 顶替入口 · `W-SCAFFOLD-01` 未填的 ask-init 模板标记（`TODO` 占位） ·
`I-AGENTS-01` `.agents/skills` 存在（pi 会要求项目信任） · `I-INSTALL-01` 尚未安装框架。

### 多仓库

记忆只住主仓。**源码事实**：pi 只加载 cwd 及其祖先的 AGENTS.md；`pi-add-dir` 会把每个
added root 的 `AGENTS.md`（含 `.pi/AGENTS.md`）**全文**注入每次请求（`buildContextInjection`）——
所以 root 里的入口只能是 ≤30 行 scope card（这里放什么、它的命令、去主仓哪个记忆文件读），
绝不能是规则的第二份副本。`/ask-init roots` 合并本次会话 `add-dir:state` 与 state 里已登记的
roots；自带完整框架的 root 标记 `independent`，不接管。

### 已验证

- `pnpm typecheck` 绿；`pnpm test` **32 文件 / 660 测试**全绿（init 新增 7 个测试文件 / 79 用例）；
  `pnpm check:keybindings` 全部 ✅（未新增任何键位）。
- `pnpm check:compat`：窗口 1.2.0–1.5.1 全绿（每版 660 passed），探针 1.1.x / 1.0.x / 0.99.x 全绿、
  0.87.x 因 `defaultActive` 停探，floor 0.99.0。
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
- 测试：`pnpm test` 32 个文件 / 660 测试全绿；`pnpm check:compat` 强制窗口
  1.2.0–1.5.1 + 向后探针 1.1.x / 1.0.x / 0.99.x 全绿（floor 0.99.0）；
  真实 pi 1.5.1 冒烟（`pi -ne -e ./src/index.ts ... 'Reply with exactly: OK'`）回 OK 无警告。

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

- `pnpm test` 32 个文件 / 660 测试全绿（新增 `approval-log.test.ts`、`gates.audit.test.ts`、
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

### 已知边界（有意为之，README 已声明）

- 读命令的**裸文件名参数**不判定（`cat notes.txt`）：默认模式下无影响，
  但把 `out-read` 调成 ask/deny 时绝对路径以外的读目标不会被问。这是「读盲区」，不是写盲区。
- 启发式，不是沙箱：进程替换走 opaque、Windows Git-Bash 路径拼写只近似（实测目标是 POSIX）、
  PowerShell 不拆解、子代理会话不继承父会话状态。
- 项目内的破坏性操作靠固定表兜，不靠沙箱。

## Feature: quit-guard（退出看门狗，2026-11-05 立项并实现）

### 起因（实测，2026-11-05）

pi 1.0 起默认 fullscreen（备用屏）。`/quit` 的顺序是：停 TUI（还原终端、重绘最后一帧）
→ `await runtimeHost.dispose()`（**串行 await 每个扩展的 `session_shutdown`，无超时**）
→ `process.exit(0)`。任一扩展的收尾 Promise 永不 settle，进程就在「终端已还给你、画面
却停在最后一帧」的状态下永远挂着；宿主 `isShuttingDown` 置位后 Ctrl+C / SIGTERM / SIGHUP
都会被吞掉，只有 `kill -9` 有效。上游 issue
[#9997](https://github.com/earendil-works/pi/issues/9997)（0.86/0.87 就有，机器人自动关闭），
1.5.1 与 `main` 的 `interactive-mode.ts` 仍是同一个无界 await（1.5.1 只是在它前后又
各加了一个 await：`session.abort()` 与凭据写盘等待 `settleCredentialWrites()`）。

本机实测（20 个扩展包，tmux，`PI_TUI_WRITE_LOG` 计时）：健康退出 2.1 s / 5.0 s；
`pi -ne` 121 ms；同一环境三次 `/quit` 有一次**永不退出**。卡死时进程 0% CPU，
`pgrep -a pi` 可见（PPID=1、无 tty 的孤儿就是关窗后残留的实体）。

### 决策

- **触发源用终端收尾序列，不用 `session_shutdown`**：pi 串行 await，卡死处理器若比本包先
  加载，我们自己的 `session_shutdown` 根本不会运行——按事件挂看门狗会正好漏掉要抓的场景。
  `\x1b[?2004l`（`ProcessTerminal.stop()`，regular/fullscreen 都写）与
  `\x1b[?1049l`（fullscreen 退备用屏）都早于收尾阶段。
- **解除条件**：`\x1b[?2004h` / `\x1b[?1049h`（TUI 重新进入）与 `SIGCONT`。覆盖两种合法
  的「停 TUI 但会话还活着」：`/settings` 切 TUI 模式（`switchTuiMode` 先 stop 旧渲染器再
  start 新的）与 Ctrl+Z 挂起/resume（`handleCtrlZ` 先 `ui.stop()`，SIGCONT 里 `ui.start()`）。
  到期回调延迟一拍（setImmediate），保证 resume 赢过已过期的定时器。
- **触发前再验一次 `process.stdin.isRaw`**：收尾序列也可能出现在被渲染的内容里（工具输出、文件正文
  恰好含该转义序列），而 raw mode 不会撒谎——TUI 收尾时把 raw mode 关掉，所以 `isRaw===true`
  说明 TUI 还活着，直接解除而不杀。**事件触发的武装不受这条约束**（见下）。
- **第二触发源：`session_shutdown`（reason 仅 `"quit"`）**。信号触发的退出
  （`shutdown({ fromSignal: true })`，如关窗 SIGHUP、`kill -TERM`）**先跑完所有扩展处理器再
  `ui.stop()`**，所以处理器一旦挂住，收尾序列永远不会写出、只靠终端的看守永远不武装——进程
  带着 raw mode 和冻结画面活到被 SIGKILL（2026-11-10 在真实 pty + 本机全套扩展上复现）。
  `session_shutdown` 是那一刻唯一的进程内信号，因此它也武装看守；`"reload"`/`"new"`/
  `"resume"`/`"fork"` 绝不武装。事件武装不查 raw mode（TUI 正活着就是它要抓的状态），
  到期时先写 `TERMINAL_RESTORE`（关括号粘贴、退备用屏、显示光标）再退出，否则提示符会回到
  备用屏上。**边界**：处理器按加载顺序串行执行，挂在**本包之前**加载的处理器仍能让我们的
  处理器根本不运行（实测成立），那条路只能靠交互式 `/quit` 的收尾序列。
- **默认开启、8 s、写报告**（2026-11-10 崔总定：默认值由 10 s 改为 8 s）。8 s 从「收尾序列
  写出」（或 `session_shutdown` 事件）起算，不把你按 Enter 到 TUI 停下的时间算进去；实测健康
  退出端到端最慢 5 s、收尾后最多 2 s，余量约 3 s。可 `/quit-guard <ms>` 调（钳制
  2000–60000），`/quit-guard off` 关闭，配置落 `<agent-dir>/pi-toolkits-quit-guard.json`。
- **触发时写报告再退出**：`<agent-dir>/quit-guard/quit-hang-<ts>-<pid>.json`，含
  `activeHandles` / `activeRequests` / 宿主 `process.report` 的 libuv 表。空表 + 活进程
  = 卡在永不 settle 的 Promise 上（区别于阻塞 socket / 残留子进程）。报告是 0700 目录下的
  0600 文件，`argv` 走上游 `redactText` + 位置式旗标脱敏（`--api-key <opaque>`、`--token=…`），
  避免把密钥写进盘。**报告链路整体 try/catch**：`process.cwd()` 在目录被删后会抛 ENOENT
  （pi 1.5.1 自己也为此加了启动保护），诊断失败绝不能挡住强制退出。
- **退出用 `process.exit(0)`，外加 SIGKILL 兜底**（先排 500 ms 定时器，再 exit，正常路径
  定时器不会触发）。测试中实际撞到过一次 exit 之后进程仍停在事件循环里；会话 JSONL 是
  增量落盘的，报告也已同步写完，硬杀不丢可恢复内容。

### 落位

| 文件 | 职责 |
| --- | --- |
| `src/features/quit-guard/constants.ts` | 收尾/重启标记、默认值与钳制区间、理由注释 |
| `src/features/quit-guard/guard.ts` | 纯状态机（注入 clock/scheduler/defer），arm/disarm/fire |
| `src/features/quit-guard/store.ts` | 配置读写（原子写、损坏回落默认、时长时间钳制） |
| `src/features/quit-guard/report.ts` | 报告采集与同步落盘（失败只警告，绝不阻塞退出） |
| `src/features/quit-guard/index.ts` | 进程接线：stdout 单例包装、SIGCONT、TUI 限定的 `session_shutdown` 触发、`/quit-guard` 命令 |
| `src/features/quit-guard/quit-guard.test.ts` | 51 个用例（状态机、钳制、存储、报告与脱敏/权限位、命令面板、stdout 单例、raw-mode 兜底、事件原因与模式过滤、探针异常） |

不变量：stdout 包装**每进程只装一次**（`Symbol.for` 存在 `globalThis`，`/reload` 只刷新
配置与状态，不重复包装）；计时用 `performance.now()`（单调时钟——测试里撞到过 WSL 墙上时钟
回跳，`Date.now()` 会把 10 s 记成 7.2 s）；报告写盘失败不影响退出。

### 已验证

- `pnpm typecheck`、`pnpm test`：**32 文件 / 666 测试**全绿（quit-guard 51 例）。
- 真实 pi 1.5.1 冒烟（tmux，`-ne -e ./src/index.ts`，卡死探针为「`session_shutdown` 返回
  永不 resolve 的 Promise」，且探针**先于**本包加载以证明不依赖处理器顺序；每轮独立
  `PI_CODING_AGENT_DIR` + `timeoutMs: 2000`）：
  - fullscreen：收尾后 **2.11–2.15 s** 退出（8 轮中 7 轮；报告写出，`marker=?2004l`）；
  - `tuiMode: "regular"`：**2.10–2.13 s** 退出（走 `?2004l`）；
  - 无卡死探针：**0.12 s** 退出（2 轮，看守不拖慢正常退出）；
  - 默认值（**无配置文件**、`enabled=true`、`timeoutMs=8000`）实测：卡死探针下 **8.12 s**
    退出，报告 `timeoutMs=8000 / elapsedMs=8005 / marker=?2004l`；健康退出 **0.12 s**（5 轮，
    含先执行 `/quit-guard` 查看状态的两轮）；`/quit-guard` 状态行显示
    `on · timeout 8000ms · report on`；
  - 真实 pty + 本机全套扩展（`/tmp` 下探针，2026-11-10）：`/quit` + 卡死 → 收尾序列武装、
    **10.12 s** 退出（当时默认 10 s）并写报告；`SIGTERM` + 卡死 → **1.5.1 的 `fromSignal`
    先 dispose 后 stop，序列永不写出，看守不武装、进程活到被 SIGKILL**（这是第二触发源要补的洞）；
    补上之后：`-e 本包 -e 探针`（本包先加载）SIGTERM → 事件武装、**8.03 s** 退出、输出含
    `TERMINAL_RESTORE`；`-e 探针 -e 本包`（探针先加载）SIGTERM → 仍然不武装（处理器串行，
    边界如实保留）；交互式 `/quit` 两种加载顺序都由收尾序列武装并按时触发；
  - 1.5.1 新增的 `await session.abort()` / `settleCredentialWrites()` 都在同一条无界链上，
    没有改变结论；
  - 一轮测得 0.28 s 的墙上时钟退出、而报告 `elapsedMs=2032`（单调时钟）——WSL 墙上时钟回跳
    的已知现象（`Date.now()` 曾把 10 s 记成 7.2 s），不是看守提前放手；
  - 历史（1.5.0）：fullscreen/regular 2.15 s、无探针 0.11 s、`/quit-guard 4500` → 4.66 s、
    默认 10 s → `elapsedMs≈10000`。
- 宿主事实：`?2004l` 由 `ProcessTerminal.stop()` 直接 `process.stdout.write`，**不经过**
  `PI_TUI_WRITE_LOG`（该日志只记 `terminal.write`）；所以调试看门狗用
  `PI_QUIT_GUARD_DEBUG=<file>`（记录 register/arm/disarm/fire），不要拿 TUI 写日志对时间。

### 已知边界（有意为之）

- **只覆盖交互式 TUI**：print/JSON/RPC 不写收尾序列；它们的 `session_shutdown(reason=quit)`
  也被显式过滤，避免把终端恢复转义序列写进机器可读的 stdout 协议。
- 交互式 `/quit` 只覆盖**收尾序列之后**的卡死（`ui.stop()` 在 dispose 之前，正常情况序列
  一定会写出）。信号触发路径靠 `session_shutdown` 补位，但**处理器按加载顺序串行**：挂在
  本包之前加载的处理器会让我们的处理器不运行，那条路仍然无解。
- TUI 停下之前就卡住、且不来自 `session_shutdown` 的情况（例如 `/quit` 被延后到 idle）不管：
  没有可观测信号，看守不会被武装。
- 触发即跳过剩余扩展清理（挂住的就是它）；不判断「哪个扩展」——报告只给进程状态。
- `/reload` + `-e` TypeScript 扩展在 tmux 夹具里表现不稳定（换掉本包、甚至完全不加包装也
  一样），属宿主/夹具噪声，不是本功能的回归；真实会话里 `/reload` 后看守仍按单例接线工作。
- 这是对宿主缺口的权宜之计：pi 若给 `session_shutdown` 加上限，本功能可整体删除。
