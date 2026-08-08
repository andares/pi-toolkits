# PLAN: @andares/pi-toolkits — 模型收藏 favorite 功能

## Context

**为什么做**:给 pi 增加"模型收藏"能力,在 `/model` 打开的选择器里标记常用模型,并让 `ctrl+p`/`ctrl+shift+p` 在存在收藏时**只在收藏模型间循环**。

**需求拆解**(用户原话整理):

1. `/model` 打开后的模型列表界面**上方增加一行提示**:ctrl+F 对当前选中模型开关收藏;ctrl+J 开关"仅显示收藏模型"
2. 收藏的模型文字显示为**加粗亮黄色**
3. ctrl+F / ctrl+J 只在该选择器场景生效;若 pi 框架支持"场景内遮罩全局快捷键"则无冲突,否则换不冲突键位
4. **关键行为**:存在收藏后,`ctrl+p`/`ctrl+shift+p` 仅在收藏模型间切换,不再全量跳转
5. 参考 `@cnife/pi-auto-naming-session` 插件的做法(会话标题持久化到 agent-dir JSON、事件驱动、`getAgentDir()` 定位)

**调研结论(pi 0.84.0 源码级确认,见下 "Reuse")**:

- ✅ **无需改键位/遮罩全局快捷键**。pi 的扩展快捷键(`pi.registerShortcut`)只在编辑器聚焦时经 `CustomEditor.handleInput` 分发,选择器打开时根本收不到扩展快捷键;而且 `app.model.cycleForward/cycleBackward`(ctrl+p / shift+ctrl+p)在 extension runner 里是**保留键位**(`restrictOverride: true`),扩展注册同名快捷键会被跳过。因此正确做法不是"遮罩键",而是:
  - **选择器内**:直接 patch `ModelSelectorComponent.prototype.handleInput`,在它把 ctrl+f/ctrl+j 转发给搜索框之前拦截(仅选择器场景生效,天然无全局冲突)
  - **编辑器内 ctrl+p**:patch `AgentSession.prototype.cycleModel`(这是 ctrl+p 的最终落点,前向/后向都走它),存在收藏时过滤循环列表;键位本身不动,零冲突
- **键位冲突盘点**(用户关心的点):
  - `ctrl+f`:`tui.editor.cursorRight` 默认含 ctrl+f(编辑器内光标右移)——但我们的拦截**只在选择器内**,编辑器内不受影响;选择器内搜索框的"光标右移"被接管(有 ←/→ 箭头键可替代,可接受)。系统级 ctrl+f 无冲突
  - `ctrl+j`:`tui.input.newLine` 默认含 ctrl+j(插入换行)——同样只在选择器内接管;单行搜索框里 ctrl+j 本就无实际用途,可接受
  - `ctrl+p`/`ctrl+shift+p`:保留键位,但我们不改键,只改 `cycleModel` 语义,无冲突
  - 结论:**不需要换键位**,ctrl+F/ctrl+J 全部按用户原方案落地
- **收藏持久化**:照抄 auto-naming-session 的配置方式——`getAgentDir()` 下写 JSON(`~/.pi/agent/pi-toolkits-favorites.json`),跨会话跨项目全局生效
- **选择器 UI 注入只能靠 prototype patch**:pi 扩展 API 没有"渲染进内置选择器"的钩子(`ModelSelectorComponent` 是内置类,`ctx.ui.custom()` 只能整体替换组件,且其构造需要内部 `SettingsManager`/`ModelRuntime`,ctx 拿不到)。所以采用运行时 patch 内置类原型(带版本守卫,失败则降级不启用)

## Approach

### 依赖

- `package.json` 增加 `@earendil-works/pi-tui@^0.84.0`(**runtime 依赖**):需要它的 `matchesKey`(纯函数,兼容 kitty 协议按键序列)、`Text` 组件(构建提示行/列表项)。与 pi-coding-agent 同版本,保证与 pi 运行时同一实例、同一 `getKeybindings()` 单例
- `@earendil-wells/pi-ai` 仅作类型用(devDependencies,`Model` 类型)
- ⚠️ 关键:键匹配用 `matchesKey(data, "ctrl+f")` 这种**纯函数**,不用 `getKeybindings().matches(...)`(后者依赖单例,若 pi 未来升级 pi-tui 版本产生双实例会失效;`Text` 类用鸭子类型,不依赖 instanceof)

### 功能模块 `src/features/favorites/`

```
src/features/favorites/
├── index.ts          # registerFavorites(pi):原型 patch + 命令 + 事件 + footer 状态
├── store.ts          # 收藏存储:JSON 持久化(getAgentDir),has/toggle/count/订阅
├── patch-selector.ts # ModelSelectorComponent 原型 patch(提示行/ctrl+F/ctrl+J/亮黄渲染/仅收藏过滤)
├── patch-cycle.ts    # AgentSession.prototype.cycleModel 收藏过滤循环
└── constants.ts      # 键位、颜色 ANSI、状态 key、文件名、配置
```

`src/index.ts` 追加 `registerFavorites(pi)` 一行。

### Part A — 选择器内 UI(patch-selector.ts)

对 `ModelSelectorComponent.prototype` 做 3 处 patch(全部带版本守卫:先确认原型存在 `handleInput`/`updateList`/`filterModels`,缺则 warn 并跳过):

1. **`handleInput` 包装**:先于原实现检查
   - `matchesKey(data, "ctrl+f")` → 对 `this.filteredModels[this.selectedIndex]` 取反收藏(store.toggle)→ 更新提示行文本(收藏数)→ `this.tui.requestRender()`;若"仅收藏"过滤开启且该模型被取消收藏,重跑 `filterModels`
   - `matchesKey(data, "ctrl+j")` → 翻转"仅显示收藏"开关 → 重跑 `filterModels`(保留当前搜索词)→ 更新提示行(`[ON]/[OFF]`)
   - 其余按键走原 `handleInput`
2. **`updateList` 包装**:注入提示行 + 收藏亮黄渲染
   - **提示行注入**(惰性、幂等):实例首次 `updateList` 时 `new Text(...)` 并 `this.children.splice(2, 0, hint)`(top border+spacer 之后、provider/scope 提示之前)。文本用 `rawKeyHint`/`theme.fg("muted", ...)` 拼:`ctrl+F favorite · ctrl+J only-favorites [OFF] ★n`;ctrl+F/ctrl+J 切换后 `setText` 刷新
   - **渲染**:整体复刻原 `updateList`(约 45 行,当前模型/选中行/滚动指示/空态/错误态逻辑不变),仅列表项 id 颜色改为:收藏 → **加粗亮黄 ANSI `\x1b[1;93m`**(标准 16 色亮黄,与主题无关,任何 ColorMode 可用);非收藏 → 保持原 accent/muted 逻辑。颜色主题取捕获的 `ctx.ui.theme` 代理(与组件内部同一实例,`session_start` 事件时捕获;非 TUI 模式无主题则跳过亮黄、退回原实现)
3. **`filterModels` 包装**:"仅显示收藏"开启时,临时把 `this.activeModels` 换成收藏子集再调原方法(`try/finally` 还原),复用原方法的 fuzzyFilter+选中位逻辑,**零重复**;搜索词/scope 切换/目录刷新后都会重新收敛到 `filterModels`,过滤自动生效

> ⚠️ 提示行"右上方"说明:pi-tui 的 `Text` 组件只能左对齐(无 right-align 原语,`Container` 逐行渲染)。提示行放在选择器顶部(border 下第一行),视觉上即"列表界面上方"。若必须真右对齐,需要自绘 overlay(复杂、易碎),不建议。

### Part B — ctrl+p 收藏循环(patch-cycle.ts)

对 `AgentSession.prototype.cycleModel` 包装(仅当 `store.config.cycleOnlyFavorites !== false` 且收藏非空时启用):

```ts
const orig = AgentSession.prototype.cycleModel;
AgentSession.prototype.cycleModel = async function (direction = "forward") {
  // 收藏为空 → 原行为
  if (!store.hasAny()) return orig.call(this, direction);
  // 候选列表与内置一致:scoped 有值用 scoped,否则用可用模型快照;再过滤出收藏
  const source = this._scopedModels.length > 0
    ? this._scopedModels.map(sm => sm.model)
    : this._modelRuntime.getAvailableSnapshot();
  const favs = source.filter(m => store.has(m.provider, m.id));
  if (favs.length <= 1) return orig.call(this, direction); // 原逻辑给出 "Only one model available"
  // 复刻 _cycleAvailableModel 的应用逻辑(~20 行):
  //   当前模型索引(不在收藏 → 前向=第一个收藏、后向=最后一个收藏,已确认) → 取模下一个 →
  //   agent.state.model / appendModelChange / setDefaultModelAndProvider /
  //   setThinkingLevel / await _emitModelSelect(next, current, "cycle")
  //   → return { model, thinkingLevel: this.thinkingLevel, isScoped: scoped? }
};
```

- 复刻逻辑为 `_cycleAvailableModel` 的同一套(TS private 是编译期限制,运行时 `this._xxx` 可访问;用结构化 interface 断言)
- `model_select` 事件(source: "cycle")由 `_emitModelSelect` 照常发出,footer 状态/其他扩展不受影响
- 键位 `ctrl+p`/`shift+ctrl+p` 绑定不动,只是 cycleModel 语义变化;ctrl+l(/model 或 `app.model.select`)仍可自由选任何模型(含非收藏),逃逸通道天然存在

### 状态与命令

- **持久化**:`store.ts` 读写 `getAgentDir()/pi-toolkits-favorites.json`,结构 `{ favorites: string[], cycleOnlyFavorites: true }`(favorites 为 `provider/id` 字符串数组;原子写:tmp+rename)。加载失败/损坏 → 空集合 + 默认配置 + console.warn,不影响启动
- **footer 状态**(轻量增强):`pi.on("model_select")` 里 `ctx.ui.setStatus("favorites", count>0 ? theme.fg("accent",`★ ${count}`) : undefined)`;`session_start` 时同步一次
- **命令**(轻量增强):`/favorites` 列出收藏(notify 或 setWidget),空则提示"暂无收藏,在 /model 里按 ctrl+F 添加"

### 冲突与降级

- **版本守卫**:patch 前 `typeof proto.handleInput === "function"` 等检查;不满足 → console.warn 跳过该 patch(选择器功能缺失,ctrl+p 保持原行为),扩展整体不崩
- **双实例风险**:pi-tui 依赖与 pi 锁定同版本(`^0.84.0`),`matchesKey` 纯函数免疫单例漂移
- **reload 幂等**:patch 用模块级 `alreadyPatched` 标志;`/reload` 重复加载不重复包裹

## Files to modify

| 文件 | 动作 |
| --- | --- |
| `package.json` | 增加依赖 `@earendil-works/pi-tui@^0.84.0`;devDep `@earendil-works/pi-ai@^0.84.0`(类型) |
| `src/index.ts` | 追加 `registerFavorites(pi)` |
| `src/features/favorites/index.ts` | 新建:patch 编排 + `/favorites` 命令 + footer 状态 + 主题捕获 |
| `src/features/favorites/store.ts` | 新建:JSON 持久化收藏存储 |
| `src/features/favorites/patch-selector.ts` | 新建:ModelSelectorComponent 三处 patch |
| `src/features/favorites/patch-cycle.ts` | 新建:AgentSession.cycleModel 收藏循环 |
| `src/features/favorites/constants.ts` | 新建:键位/颜色/文件名/状态 key |
| `README.md` | 更新:收藏功能用法 |

## Reuse

- `@earendil-works/pi-coding-agent@0.84.0`(peer dep,已装):`ExtensionAPI`/`ExtensionContext`(注册、事件)、`AgentSession`(patch 目标)、`ModelSelectorComponent`(patch 目标)、`keyHint`/`rawKeyHint`(提示行文案)、`getAgentDir()`(状态文件路径,与 `@cnife/pi-auto-naming-session` 同款用法)、`ctx.ui.theme`(活的主题代理)、`ctx.ui.setStatus`/`notify`(footer/命令反馈)
- `@earendil-works/pi-tui@0.84.0`(新增依赖):`matchesKey`(键匹配,兼容 kitty 协议)、`Text`(提示行/列表项)
- **参考实现(仅借鉴模式,不拷贝逻辑)**:`@cnife/pi-auto-naming-session` —— agent-dir JSON 配置读写、事件驱动状态、`pi.on` 事件注册风格;`src/features/ask/`(本仓库既有 feature 骨架,`registerXxx(pi)` 模式)
- **关键源码依据(pi 0.84.0 dist)**:
  - `dist/core/extensions/runner.js` — `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 含 `app.model.cycleForward/Backward`(扩展快捷键无法覆盖 ctrl+p 的根因)
  - `dist/modes/interactive/components/custom-editor.js` — `handleInput` 分发顺序(扩展快捷键 → app 动作 → 编辑器);`onExtensionShortcut` 仅在编辑器聚焦时生效
  - `dist/modes/interactive/components/model-selector.js` — `handleInput`/`updateList`/`filterModels`/`loadModelsFromSnapshot`/`setScope` 全流程(过滤在所有路径收敛于 `filterModels`,故"仅收藏"过滤只需包这一处)
  - `dist/core/agent-session.js` — `cycleModel`/`_cycleScopedModel`/`_cycleAvailableModel`/`_emitModelSelect`/`_getThinkingLevelForModelSwitch`(ctrl+p 落点与复刻模板)
  - `dist/modes/interactive/theme/theme.js` — `theme` 是 Proxy,实时读 `globalThis` 当前主题;`ctx.ui.theme` 即该代理

## Steps

- [ ] 1. `pnpm add @earendil-works/pi-tui@^0.84.0 && pnpm add -D @earendil-works/pi-ai@^0.84.0`;确认与 pi 运行时同实例(`getKeybindings` 单例测试)
- [ ] 2. `store.ts`:收藏集合 + 配置(cycleOnlyFavorites 默认 true)+ JSON 持久化(load/save/has/toggle/count/subscribe),含损坏容错与原子写
- [ ] 3. `constants.ts`:键位名、亮黄 ANSI、状态 key、文件名
- [ ] 4. `patch-selector.ts`:三处 patch(handleInput 拦截 ctrl+F/ctrl+J、updateList 注入提示行+亮黄渲染、filterModels 收藏过滤),版本守卫 + 幂等标志
- [ ] 5. `patch-cycle.ts`:`AgentSession.prototype.cycleModel` 收藏过滤(复刻应用逻辑,处理 scoped/available 两源、当前模型不在收藏时的首/尾跳转)
- [ ] 6. `index.ts`:`registerFavorites(pi)` 编排(patch 顺序、`session_start` 捕获主题、`model_select` footer 状态、`/favorites` 命令)
- [ ] 7. `src/index.ts` 注册;`pnpm typecheck` 通过;`pnpm test` 不回归
- [ ] 8. README 更新;git commit

## Verification

- [ ] `pnpm typecheck` 零错误;`pnpm test`(既有 ask 用例不回归)
- [ ] 本地 `pi -p -e ./src/index.ts` 启动无报错、无 "Extension shortcut conflict" 类警告
- [ ] 手动冒烟(TUI):
  - `/model` 打开 → 顶部出现提示行(ctrl+F / ctrl+J + 收藏数);`ctrl+l` 打开同样生效
  - ↑/↓ 选中某模型按 ctrl+F → 该行变**加粗亮黄**,提示行收藏数 +1,agent-dir JSON 落盘;再按一次取消
  - 按 ctrl+J → 列表只剩收藏模型(亮黄);配合搜索词过滤正常;再按恢复
  - 当前模型行 `✓` 与亮黄可共存;错误态/空态/滚动指示渲染不破
  - **ctrl+p / ctrl+shift+p**:无收藏时行为与原来一致;收藏 ≥2 个后,只在收藏间循环(当前模型非收藏时,前向跳到第一个收藏、后向跳到最后一个);收藏仅 1 个时显示 "Only one model available"
  - ctrl+l 仍可自由选择非收藏模型(逃逸通道)
- [ ] 收藏持久化:重启 pi 后收藏仍在(JSON 文件存在且正确)
- [ ] 降级:伪造原型缺失(临时注释 patch 守卫)确认不崩、仅功能缺失

## 已确认决策点(用户拍板)

- **A. 当前模型不是收藏时 ctrl+p 跳转**:✅ 前向→第一个收藏、后向→最后一个收藏
- **B. `cycleOnlyFavorites` 配置**:✅ 加,默认 `true`;JSON 设 `false` 恢复全量循环
- **C. 收藏行标记**:✅ 仅加粗亮黄,不加 ★ 前缀
- **D. 提示行位置**:✅ 选择器顶部左对齐一行(pi-tui 无右对齐原语)
- **E. footer 状态与 `/favorites` 命令**:轻量增强,按计划实现(提示行/命令里的收藏计数保留,仅行内不加 ★)
