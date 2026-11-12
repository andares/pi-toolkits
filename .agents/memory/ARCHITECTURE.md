# 架构与决策

> 分层、版本基线、决策记录（背景 / 决定 / 后果 / 日期）与调研存档。一个事实一个家。

## 分层

证据：`package.json`、`src/index.ts`、`git ls-files src`（2026-11-12 复核）。

- **一个 npm 包** `@andares/pi-toolkits`，`pi.extensions` 指向 `./src/index.ts`；`files: ["src", "CHANGELOG.md"]`，
  没有 build 步骤（宿主直接加载 TypeScript 源）。`LICENSE` 为 MIT（2026 Andares Cui）。
- **入口** `src/index.ts` 默认导出 `piToolkits(pi: ExtensionAPI)`：先建一个 gate 总线
  （`createGateHub`）与一个审批日志（`createApprovalLog`），再顺序注册 12 个 feature，
  最后 `gates.install(pi)`。注册顺序有语义：`permission` 在 `autostart` 之前，好让项目声明的
  `/ask-perm ...` 面对干净状态；`uat` 在 `plan` 之后，让 `record_change` 追加到 plan 装好的
  工具集上（`src/index.ts` 的注释即此依据）。
- **feature 层** `src/features/<name>/`，每个导出 `registerXxx(pi, …)`；当前 12 个：
  `ask`、`autostart`、`compact`、`favorites`、`init`、`permission`、`plan`、`quit-guard`、
  `review`、`stash`、`uat`、`whats-new`。
  新增 feature = 新建目录 + 入口加一行，不改既有模块。
- **共享层** `src/lib/`：`gates.ts`（闸门总线 + 弹窗串行队列 + 审计计数）、`approval-log.ts`
  （滚动 JSONL）、`tools.ts`（活跃工具快照/恢复 + jailed 工具登记）、`model-config.ts`、
  `model-picker.ts`、`startup.ts`。
- **测试与门禁**：单元测试与源码同目录（`*.test.ts`，colocated）；`scripts/*.mjs` 放仓库级门禁
  ——`check-compat.mjs`（宿主版本矩阵）、`check-keybindings.mjs`（键位审计）、
  `approval-report.mjs`（审批日志挖掘）、`publish.mjs` / `tag-current.mjs` /
  `release-github.mjs` / `lib/github-release.mjs`（发布链）。
- **运行时依赖只有三个**：`@dreki-gg/pi-command-sandbox`、`shell-quote`、`smol-toml`。
  宿主提供的包一律 `peerDependencies`（`@earendil-works/pi-coding-agent >=0.99.0`、
  `@earendil-works/pi-tui *`、`typebox *`），具体版本留在 `devDependencies` 供 typecheck
  （规则与理由见 `AGENTS.md` §pi 宿主兼容）。

## 版本基线

实测 2026-10-26（证据：`package.json`、`pnpm-lock.yaml`、`node -v`、`pnpm -v`、
`node_modules/@earendil-works/pi-coding-agent/package.json`）：

| 项目 | 值 |
| --- | --- |
| 本包版本 | `0.11.0`（最新 tag `v0.11.0`） |
| pi 宿主（devDependency 与已安装副本） | `1.4.0` |
| peer 下限 | `@earendil-works/pi-coding-agent >=0.99.0`（无上界） |
| TypeScript | 声明 `^5.6.0`，lock 解析 `5.9.3`；`strict` + `noEmit`，`include: ["src"]` |
| vitest | `4.1.10` |
| Node / pnpm（本机） | `v26.5.0` / `12.14.0` |
| 编译目标 | `ES2022` + `moduleResolution: bundler` |

支持的宿主区间与「窗口 / 探针 / public floor」的判定规则以 `AGENTS.md` §pi 宿主兼容 为准；
本表只记基线数字，不重复规则。

## 决策记录

> 只追加；被推翻时写新条目并在旧条目上标「已被 <日期> 取代」。日期与来源都写，未指名决策人的不臆测。

### D1 单包 + feature 目录，不用 workspace（2026-08-07）

- 背景：仓库原来是 `packages/pi-ask-mode/` + `pnpm-workspace.yaml` 的单包 workspace；
  目标是「一个 npm 包、内含多个能力」。
- 决定：删掉 `packages/` 与 workspace 配置，改为单包 + `src/features/<name>/` 注册式扩展，
  `src/index.ts` 聚合。
- 后果：8 个 feature 全部按此摆放（证据 `src/index.ts`）；`pnpm-workspace.yaml` 仍存在但只有
  pnpm 自己的配置（`allowBuilds`、`minimumReleaseAgeExclude`），不是多包定义。
- 来源：旧 `PLAN.md` §架构(扩展性设计)，原文见 `git show 0ba02e8:PLAN.md`。

### D2 bash 只读校验依赖 `@dreki-gg/pi-command-sandbox`（2026-08-07）

- 背景：ask 要保留 bash 但只允只读命令；自研正则误判多、维护成本高。
- 决定：用第三方包做分词与逐段校验（含命令替换拒绝、deny-by-default），我们只补「写盘意图」
  （`curl -o/-O`、`wget -O`、`dd of=`、`tee`）。
- 后果：`dependencies` 里保留 `@dreki-gg/pi-command-sandbox ^0.4.3`；2026-10-19 重构后
  写通道改由 `scratchpad` 承担，沙箱仍不开写。
- 来源：旧 `PLAN.md` §待确认决策点 A，原文见 `git show 0ba02e8:PLAN.md`。

### D3 ask 的作用面：只硬禁会改项目的工具（2026-08-07，2026-10-19 扩写）

- 背景：早期想法是「黑名单尽量大」。
- 决定（原）：只摘除 `write`/`edit`，其余工具（read/grep/find/ls、web_search、memory 等）保持可用。
- 决定（2026-10-19 取代前条的「全部禁写」理解）：摘除 `write`/`edit`/`powershell`，
  `bash` 只读，另开**唯一**写通道 `scratchpad`（只写 `<os.tmpdir()>/pi-ask/<session>`）。
  项目写仍然不可能；「不许写任何文件」被明确放弃。
- 后果：`src/lib/tools.ts` 的 jailed 工具登记表按工具名放行 `scratchpad`；现行语义以
  `AGENTS.md` §Feature: ask 为准，本条只留决策脉络。
- 来源：旧 `PLAN.md` §待确认决策点 B；2026-10-19 重构见 `AGENTS.md` §Feature: ask（决策段）。

### D4 模式状态不落盘（2026-08-07）

- 决定：`/ask` 只在会话内切换，退出即恢复进入前的工具集快照，不写任何配置文件。
- 后果：默认值靠 autostart 声明（`/ask-perm ...` 同理不落盘）；`session_start` 只做重置与
  按 session id 去重。
- 来源：旧 `PLAN.md` §待确认决策点 C；取舍理由见 `AGENTS.md` §Feature: permission 需求段。

### D5 系统提示只能链式追加（2026-08-07）

- 背景：`systemPromptAppend` 是 0.65 时代字段，宿主 0.84 已无（静默失效）；整体覆盖
  `systemPrompt` 会丢掉宿主内置提示。
- 决定：`before_agent_start` 返回 `systemPrompt: event.systemPrompt + BANNER`。
- 后果：所有 feature 的横幅（ask / permission）都走这条路径，横幅保持字节稳定以命中
  provider 的 prompt 缓存。
- 来源：旧 `PLAN.md` §系统提示追加，原文见 `git show 0ba02e8:PLAN.md`。

### D6 ask 的可选交互未采纳（2026-08-07）

- 内容：`--ask` 启动参数、`/ask <问题>` 一步到位、`Ctrl+Alt+A` 快捷键。
- 状态：决策点 D 当时**未确认**，因此没有实现；条目移到 `FUTURE.md` 等触发条件。

### D7 UAT 的三条不变量（2026-11-12）

- 背景：开发量上来后，「哪些已交付但没验过」靠记忆必然漏；已评估过把验收塞进 review 或塞进
  `specs/`，前者让两个问题绑死（review 是质量门，UAT 是用户视角），后者把散文当数据库。
- 决定：① 验收单位是用户可见行为，不是提交；② 状态是只追加事件流（`.agents/uat/ledger.jsonl`），
  没有提交、勾选即事件、页面关掉不丢；③ 聚类只在 UAT 侧发生，实施会话只写候选
  （并行会话互相看不见，项的身份必须单点创建）。
- 后果：`record_change` 是唯一写规范记录与候选的工具，但目录本身仍是兜底索引；review 不落任何状态；
  框架刷新用受管文件 + 模板哈希锚，`AGENTS.md` 只重写 workflow 标记块，不升 `FRAMEWORK_VERSION`。
- 来源：`specs/ask-uat.md`；证据 `.agents/implementations/2026-11-12_0313_ask-uat.md`。

### D8 whats-new 的内容源与「一次一版」语义（2026-11-12）

- 背景：插件升级后「改了什么」只能靠翻 README / git log；README 描述的是当前状态、不是增量，
  提交标题（`fix(uat): …`）是写给维护者的。多数插件的做法是升级后首启弹一次变更提示。
- 决定：① 内容源是随包发布的 `CHANGELOG.md`，发布时由 `pnpm release` 把 `## Unreleased`
  改名为目标版本（`scripts/lib/changelog.mjs`），空段落/缺段落直接中止发版——不做运行时拼提交
  标题；② 只在 `session_start(reason=startup)` 且 TUI 模式触发，非 TUI 不消费这次提示；
  ③ 状态是 `<agent-dir>/pi-toolkits-whats-new.json` 里的最高已处理版本，严格升高才提示，
  全新安装与降级都不弹；④ 呈现用会话条目（invalidate 冲不掉、不进模型上下文）；
  ⑤ 不注册 `/whats-new` 等全局命令，只保留自动提示（崔总 2026-11-13）。
- 后果：提示文本与 `CHANGELOG.md` 同源，无法出现「公告说有、实际没发」；维护者必须为每次发版
  写至少一条顶层 bullet（`--skip-changelog` 显式跳过）。发布链因此多一道门，见
  `AGENTS.md` §Feature: whats-new 与 §Release。
