# PLAN: @andares/pi-toolkits — 提示词暂存 prompt stash 功能

## Context

**为什么做**:pi 没有方便地"暂存一段提示词"的能力。需要一个功能:一个缓存区暂存一段提示词,按热键在"当前输入框内容"与"暂存内容"之间切换;快速连按两次 = 把当前提示词纳入缓存并清空输入框(丢弃刚换出来的旧暂存),方便先存起来、空出输入框写新提示词,需要时再按一次取回。

**需求拆解**(用户原话整理):

1. **1 个缓存区**,缓存 1 段提示词(进程内,不落盘)
2. 按热键:当前提示词 → 存入缓存;缓存内容 → 填入输入框(即交换)
3. 反复按:在两段提示词间来回切换
4. **短时间内连按 2 次**:第二次按的效果 = 清空输入框(把第一次交换进输入框的旧暂存清掉),实现"仅将当前提示词纳入缓存 + 空出输入框";之后需要时按一次把暂存取回
5. 热键需经四级兼容调研(pi / Linux shell / Windows Terminal / Windows OS),给用户多个选项;用户已选定 **`ctrl+alt+y`**

**调研结论(已完成,源码/实测/网络三方验证)**:

- **pi 侧**:扩展快捷键(`pi.registerShortcut`)在编辑器聚焦时最先分发(`CustomEditor.handleInput` → `onExtensionShortcut`),正好覆盖"输入框"场景;选择器打开时不触发(焦点不在编辑器),无干扰。`ctx.ui.getEditorText()` / `setEditorText()` 可用(interactive-mode 已确认实现)。
- **键位冲突盘点**(四级):
  - pi 默认绑定:ctrl+a/b/c/d/e/f/g/j/k/l/n/o/p/r/s/t/u/v/w/x/y/z 全部被占用(其中 ctrl+p/l/t/g/x 等是扩展不可覆盖的保留键);ctrl+h/i/m/[ 分别是退格/Tab/回车/Esc(终端控制字符);纯 ctrl+字母**唯一空闲的是 ctrl+q**(但它是 XON 控制字符,历史包袱)
  - ctrl+shift+字母:Linux(GNOME Terminal shift+ctrl+t/w/n/c/v)与 Windows Terminal(ctrl+shift+t/w/n/c/v/f)都是终端 emulator 自己的快捷键,会被截走;且非 kitty 协议终端上 ctrl+shift+y 坍缩为 ctrl+y(无歧义需 kitty 协议,WT 1.25+ 才支持)→ **排除**
  - **ctrl+alt+字母**:pi 仅占 ctrl+alt+];普通终端以 **ESC 前缀编码**(ctrl+alt+y = `\x1b\x19`),**不依赖 kitty 协议**即可与 ctrl+y 区分(已用 `matchesKey` 实测 ✅);Windows Terminal 无默认 ctrl+alt 绑定;Windows OS 仅保留 ctrl+alt+del;Linux 桌面避让 GNOME 的 ctrl+alt+t/l/d/箭头 与 TTY 的 F 键 → **选定 `ctrl+alt+y`(备选 `ctrl+alt+m`)**
- **双击判定**:`Date.now()` 两次按下的时间差 ≤ 400ms 视为连按;用注入 `now` 的纯状态机,可单测

## Approach

### 功能模块 `src/features/stash/`

```
src/features/stash/
├── index.ts      # registerStash(pi):registerShortcut(STASH_KEY, handler)
├── stash.ts      # PromptStash 纯状态机 + STASH_KEY/双击窗口常量(含键位选型注释)
└── stash.test.ts # 单测:交换/切换/连按清空/空缓存首按/窗口边界/三连按
```

`src/index.ts` 追加 `registerStash(pi)`。

### 状态机 `PromptStash`(纯逻辑,可单测)

```ts
press(current: string, now = Date.now()): StashPressResult {
  if (lastPressAt !== 0 && now - lastPressAt <= 400) {
    // 连按:缓存保持(已含当前提示词),清空输入框(丢弃换出的旧暂存)
    lastPressAt = 0;                       // 防止三连按被误判
    return { text: "", kind: "stash-clear", stashed: cache };
  }
  lastPressAt = now;
  const previous = cache; cache = current;
  return { text: previous, kind: "swap", stashed: current };  // 交换
}
```

语义推演(与用户描述逐条对齐):

- 初始 `cache=""`:首按 → cache=当前文本,编辑器填入 "" → **净效果=暂存+清空**(无内容可换入,与"连按"结果一致,合理)
- `cache=C`、编辑器=P:按 → cache=P、编辑器=C;**再按** → cache=C、编辑器=P(来回切换)✅
- 双击:按①交换(cache=P、编辑器=C)→ 400ms 内按② → 编辑器=""、cache 保持 P → **净效果=P 入缓存、框清空、C 丢弃** ✅("把刚才瞬间换出来的提示词再清掉")
- 三连按:按③(lastPressAt 已重置为 0)→ 视为普通按 → cache=C'... 实际是从 cache=P 换回,合理

### 注册 `registerStash(pi)`

```ts
pi.registerShortcut(STASH_KEY, {  // "ctrl+alt+y"
  description: "Stash prompt: swap editor text with stashed prompt; double-press clears editor",
  handler: (ctx) => {
    const current = ctx.ui.getEditorText();
    ctx.ui.setEditorText(stash.press(current).text);
  },
});
```

- 无 notify/状态提示:输入框内容变化本身就是即时反馈,避免每次按键弹 toast
- 状态为进程内模块级(注册时 new PromptStash);`/reload` 会重建(缓存清空,可接受);`/new` 切换会话不清缓存(同进程内延续)

### 与既有功能的关系

- 与 favorites 无冲突(不同键位、不同场景:stash 在编辑器,ctrl+alt+y 无任何 pi 默认绑定)
- ask 模式等扩展快捷键共存:`onExtensionShortcut` 是链式分发的,`getShortcuts` 按注册顺序匹配第一个命中

## Files to modify

| 文件 | 动作 |
| --- | --- |
| `src/features/stash/stash.ts` | 新建:状态机 + 常量(键位选型注释) |
| `src/features/stash/index.ts` | 新建:registerStash |
| `src/features/stash/stash.test.ts` | 新建:状态机单测 |
| `src/index.ts` | 追加 `registerStash(pi)` |
| `README.md` | 新增 stash 功能段(用法 + 键位兼容性说明) |

## Reuse

- `@earendil-works/pi-coding-agent@0.84.0`(peer dep):`ExtensionAPI.registerShortcut(KeyId, { description, handler })`、`KeyId` 类型、`ctx.ui.getEditorText()/setEditorText()`(interactive-mode 已确认:`setEditorText = editor.setText(text)`,编辑器自会重绘)
- `@earendil-works/pi-tui@0.84.0`(已装):`matchesKey` 已用于键位选型验证(ESC 前缀 `\x1b\x19` vs `ctrl+alt+y` 实测匹配;`\r` 不误匹配,排除 Enter 风险)
- **源码依据**:`dist/modes/interactive/components/custom-editor.js`(扩展快捷键最先分发)、`dist/core/extensions/runner.js`(保留键位列表,确认 ctrl+alt+y 不在其中且无冲突警告)

## Steps

- [x] 1. `stash.ts`:PromptStash 状态机 + STASH_KEY/双击窗口常量(含键位选型注释)
- [x] 2. `index.ts`:`registerStash(pi)`(registerShortcut + handler 交换/清空)
- [x] 3. `stash.test.ts`:单测(交换/切换/双击清空/空缓存首按/窗口边界 400ms/三连按)
- [x] 4. `src/index.ts` 注册;`pnpm typecheck` + `pnpm test` 全绿
- [x] 5. README 更新(stash 用法 + 键位四级兼容性矩阵);git commit

## Verification

- [x] `pnpm typecheck` 零错误;`pnpm test`(ask 43 + favorites 16 + stash 新增 8)全绿 — 67 用例
- [x] 本地 `pi -p -e ./src/index.ts` 启动无报错、无 "Extension shortcut conflict" 警告 — 输出 LOADED_OK
- [x] 单测覆盖状态机全分支(注入 now,确定性):
  - 空缓存首按 → 暂存+清空
  - 普通按 = 交换;再按 = 切回(两段提示词来回)
  - 400ms 内连按 → 清空输入框、缓存保持当前提示词、旧暂存被丢弃
  - 超过 400ms 的两按 = 普通交换(非清空);恰好 400ms 边界 = 连按
  - 三连按:第三次为普通交换
- [ ] 手动冒烟(TUI,待用户):
  - 输入提示词 → ctrl+alt+y → 输入框清空(内容进缓存);再输入另一段 → ctrl+alt+y → 换回上一段;再按 → 换回当前段
  - 快速连按两次 → 输入框清空、缓存=按前内容;再按一次 → 取回
  - 与 `/model` 选择器、ask 模式等快捷键不冲突(选择器打开时 ctrl+alt+y 不生效——焦点在组件,编辑器不接收)

## 决策点

- **A. 热键**:✅ 用户选定 `ctrl+alt+y`(备选 ctrl+alt+m;纯 ctrl 仅 ctrl+q 可用但有 XON 历史包袱;ctrl+shift 组合因终端 emulator 占用 + kitty 协议依赖被排除)——已在调研中确认
- **B. 双击窗口**:400ms(短,避免与正常快速打字/切换误触)
- **C. 缓存生命周期**:进程内内存,不落盘(提示词可能含敏感内容,不持久化);`/reload` 重建清空
- **D. 反馈**:不做 notify/状态提示,输入框内容变化即反馈
