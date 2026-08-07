# PLAN: @andares/pi-toolkits — 集成架构初始化 + ask 功能实现

## Context

**为什么做**:新项目 `pi-toolkits`(GitHub: `andares/pi-toolkits`, MIT, 2026 Andares Cui)是 pi 编码代理的**集成插件**——一个 npm 包 `@andares/pi-toolkits`,内含多个功能模块,后续会不断增加功能(不只是 ask)。当前**只实现 `ask` 这一个指令**(只读咨询模式),但架构必须为后续功能留好扩展位。

**已确认的约束**:

- 包安装名必须为 `@andares/pi-toolkits`(npm 账号 `andares`);npm 发布配置**后续另议**,本轮不做
- 工具链纯 pnpm(已用 pnpm-workspace 验证过 pnpm 11 语义);npm 相关产物如有残留需移除(当前无 `package-lock.json`/`.npmrc` 残留,node_modules 为 pnpm 安装)
- ask 需求(来自前期讨论,用户已确认):
  - `/ask` 开关指令,切换时**灰色提示**
  - 进入后**移除 write/edit**(硬限制,非提示性)
  - bash **保留**但走**只读命令沙箱**(启发式,接受不完美)
  - 进入后**系统提示词追加**一段注明当前模式与操作限制的说明

**现状**(本次会话已做的清理,待确认保留):

- `packages/pi-ask-mode/`(旧 workspace 单包结构)与 `pnpm-workspace.yaml` 已删除
- 仓库根为 `LICENSE`/`README.md`(旧内容)/`package.json`(旧 workspace 根)/`pnpm-lock.yaml`/`node_modules`/空 `src/`

## 架构(扩展性设计)

**单包 + 功能模块注册**,不用 workspace:

```text
pi-toolkits/
├── package.json              # @andares/pi-toolkits,"pi.extensions": ["./src/index.ts"]
├── tsconfig.json
├── README.md
├── .gitignore                # 已有
├── LICENSE                   # 已有
└── src/
    ├── index.ts              # 入口:聚合注册所有功能模块
    ├── lib/                  # 共享基础设施(跨功能复用)
    │   └── tools.ts          # 工具集快照/恢复等
    └── features/             # 功能模块,每功能一目录
        └── ask/
            ├── index.ts      # registerAsk(pi):命令 + 状态机 + 事件门
            ├── constants.ts  # 工具名单、文案
            ├── bash-sandbox.ts # 只读 bash 沙箱
            └── prompt.ts     # 系统提示 banner
```

**扩展模式**:每个功能模块导出 `registerXxx(pi: ExtensionAPI): void`,`src/index.ts` 顺序调用。后续新增功能 = 新建 `src/features/<name>/` + index 加一行,不动既有模块。

## ask 功能规格

### 交互

- `/ask` 切换(进/出);退出时恢复进入前的工具集快照
- 切换提示:
  - `ctx.ui.notify(..., "info")` 一条消息(如 `Ask mode ON — read-only`)
  - 常驻 footer 状态:`ctx.ui.setStatus("ask-mode", theme.fg("muted", "ask"))`,退出时清除 —— **灰色提示**由此实现(`ThemeColor` 含 `muted`,0.84 已确认)
- 可选交互(见决策点 D):`--ask` 启动参数、`/ask <问题>` 一步到位、Ctrl+Alt+A 快捷键

### 限制矩阵(硬保证层)

- **核心机制**:`pi.setActiveTools()` 移除 `write`/`edit`。已验证 pi 0.84 agent-loop 源码(`prepareToolCall`):不在活跃列表的工具被调用直接返回 "Tool not found",**不执行**——这是运行时硬拒绝,不是提示性限制
- **bash**:保留在工具集,但 `pi.on("tool_call")` 门对 bash 命令做只读校验,不通过返回 `{ block: true, reason }`(agent-loop 确认 block 为硬拦截)
- 其他工具(`read`/`grep`/`find`/`ls`/lens 工具/`web_search`/`memory` 等)保持可用(决策点 B 讨论是否扩展黑名单)

### bash 沙箱(决策点 A)

- 推荐:**依赖 `@dreki-gg/pi-command-sandbox@^0.4`**(现成、shell-quote 真实分词、逐段校验、命令替换拒绝、deny-by-default;零 pi 依赖,不会因 pi 升级失效;含 `allowCommand` 钩子留扩展位)
- 备选:自研正则方案(markokocic 式)——不推荐,维护成本高且误判多

### 系统提示追加

- `pi.on("before_agent_start")` 返回 `{ systemPrompt: event.systemPrompt + BANNER }`——链式追加,不丢 pi 内置内容(0.84 runner 源码确认链式语义)
- **禁用项**(踩过的坑):`systemPromptAppend` 字段(0.65 时代产物,0.84 已无,静默失效);整体覆盖 `systemPrompt`(plannotator 式,会丢 pi 内置提示,不适合轻量模式)

### 状态持久化(决策点 C)

- 默认**不持久化**:每次会话手动 `/ask`。简单、无跨会话状态污染

## Files to modify

| 文件 | 动作 |
| --- | --- |
| `package.json` | 重写:name `@andares/pi-toolkits`、去 workspace/private、`pi.extensions`、scripts |
| `src/index.ts` | 新建:入口聚合 |
| `src/lib/tools.ts` | 新建:工具集快照/恢复 |
| `src/features/ask/{index,constants,bash-sandbox,prompt}.ts` | 新建:ask 模块 |
| `tsconfig.json` | 新建(strict + noEmit,include src) |
| `README.md` | 更新:单包结构、ask 用法 |
| `pnpm-lock.yaml` / `node_modules` | 更新/重装(锁文件随 package.json 变化) |
| `packages/`、`pnpm-workspace.yaml` | 已删,确认不恢复 |

## Reuse

- `@earendil-works/pi-coding-agent`(已装 0.84,类型来源):`ExtensionAPI`、`isToolCallEventType`(如需要)
- `@dreki-gg/pi-command-sandbox`(决策点 A 通过后引入):`isSafeCommand`
- 参考实现(仅阅读,不拷贝):`@dreki-gg/pi-ask-mode`(当前 API 用法)、pi 官方 `examples/extensions/plan-mode`(工具快照/恢复模式)

## Steps

- [ ] 1. 结构收尾:确认 `packages/`、`pnpm-workspace.yaml` 删除;根 `package.json` 重写为 `@andares/pi-toolkits` 单包;删旧 `src` 内容(如有)
- [ ] 2. 建骨架:`src/index.ts`(聚合)、`src/lib/tools.ts`(快照/恢复)、`src/features/ask/` 空壳(各文件导出占位),tsconfig
- [ ] 3. 实现 `registerAsk`:状态机(`enter`/`exit`/`toggle`)、工具集快照与恢复、灰色 footer 状态 + notify、`/ask` 命令注册
- [ ] 4. bash 沙箱:接入 `isSafeCommand`(依赖或自研),`tool_call` 门(ask 激活时只拦 bash,其余放行;write/edit 已从工具集移除,门可作第二层防御一并 block)
- [ ] 5. 系统提示 banner:常量文案 + `before_agent_start` 链式追加
- [ ] 6. 可选交互(决策点 D 通过后):`--ask` flag、`/ask <问题>`、快捷键
- [ ] 7. `pnpm install` 更新锁文件;`pnpm typecheck` 通过
- [ ] 8. README 更新(单包结构、ask 用法、开发说明);git commit

## Verification

- [ ] `pnpm typecheck` 零错误
- [ ] 本地加载:`pi install .` 或 `pi -e ./src/index.ts` 启动无报错、无警告
- [ ] 手动冒烟:
  - `/ask` 进入 → footer 出现灰色 `ask` 状态,notify 提示
  - 要求模型 `write`/`edit` 文件 → 被硬拒绝(Tool not found),磁盘无变化
  - 模型执行 `ls`/`git status`/`cat` 等只读 bash → 放行;`rm`/`npm install`/`git commit`/重定向 → 被 block(带 reason)
  - 模型行为带 banner 约束(回答只读咨询类问题)
  - `/ask` 退出 → 工具集完整恢复,footer 状态清除
- [ ] 沙箱边界用例(如依赖 sandbox 包,直接跑其自带行为;若自研,补 vitest 用例:`echo "a && rm -rf /"` 拦截、`echo "hi"` 放行等)
- [ ] 回归:退出 ask 后 write/edit 正常工作(快照恢复正确)

## 待确认决策点

- **A. bash 沙箱实现**:依赖 `@dreki-gg/pi-command-sandbox`(推荐)还是自研
- **B. 黑名单范围**:仅 write/edit(用户已明确的最小集)还是顺带拦 `memory`/`skill_manage`/`preview_export` 等隐式写盘工具
- **C. 状态持久化**:默认不做,是否确认
- **D. 可选交互**:`--ask` 启动参数 / `/ask <问题>` 一步到位 / Ctrl+Alt+A 快捷键,做哪些
