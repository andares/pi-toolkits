# 2026-11-26T16:29+08:00 — Outline popup: rows keep their height instead of being squashed by the flex list

崔总 2026-11-26 报：索引条悬停弹出的 CONTENTS 面板里「文字行有错位，似乎行高设置有问题」（截图 `QQ_2026-11-26_16-15-33.png`，19 个标题）。截图里每行的高亮底比文字高一截、上一行的字被下一行的粉色底盖住，正是「字比行矮 / 字贴底」的样子。

## 根因（实测，不是推测）

`.outline-list` 是 column flex，被 `.outline-panel` 的 `max-height: min(60vh, 460px)` 卡住；`.outline-row` 为了省略号带 `overflow: hidden`——而**带 `overflow` 非 visible 的 flex item，自动最小尺寸是 0**，于是 19 行被 `flex-shrink` 一起压扁：

```
panel 460 / list 418.7 / listScrollH 419（= 没有溢出，说明行被压扁而不是滚动）
rowH 20.56，textH 17.55，bottomGap −3.98   ← 文字溢出到行底之外
```

19 × 32 ≈ 608 + 标题头 ≈ 460 上限，正好越过触发线；标题少的文档看不见这个问题。

## 改了什么

`ui/src/styles.css`

- `.outline-row { flex: none; }`——与 `.outline-bar` 同一处理（那条注释早就写了「inside the bounded strip the bars must scroll, not squash」，列表漏了这一句）。行恢复 31.55px（7px padding + 17.55 行盒 + 7px），文字上下各留 7px。
- `.outline-list` 增加 `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`：行不再压缩后列表真的会滚（19 行 627 > 419），滚动条出现会让行宽在出现/消失时跳动，而列表上下各有 10/12px fade 已经在说「还有」。

`ui/src/shared.tsx`

- 行不压缩后，当前节的行可能落在列表折叠线以下（深文档打开面板，红行看不见）。新增 `createEffect`：面板打开时把活动行滚进可视区（贴最近的一边，和索引条那条同款），并留 14px `REVEAL_INSET` 让行不落在列表自身的 fade 里（否则刚滚出来的行被抹掉一半）。
- 列表加 `ref` 拿元素；`.outline-bars` 那条既有效果不动。

## 证据

CSS / DOM 结构静态复现（真实 `ui/src/styles.css`，19 个中文标题，1200×900 headless Chrome）：

| | rowH | 文字上下留白 | listScrollH vs listH |
| --- | --- | --- | --- |
| 改前 | 20.56 | 上 7 / 下 **−3.98** | 419 / 419（没滚动，全被压扁） |
| 改后 | 31.55 | 上 7 / 下 7 | 627 / 419（滚动） |

真实构建产物 + mock `/api/state`（19 项 talk 页）用 CDP 驱动实测：`rows=19`、`rowH=31.55`、`textTopGap=textBottomGap=7`；滚到第 14 节再打开面板，`scrollTop=60`、活动行「白检」`visible=true`、下方留 24px 让下一行自然淡出。4 个标题的短文档：`listH=listScrollH=139`、面板 181px、不滚动、行高不变。

门禁：`pnpm typecheck` 绿；`pnpm test` 60 文件 / 1011 测试全绿；`pnpm ui:typecheck` 绿；`pnpm ui:build` 已更新 `src/features/review-page/assets/`（UAT 页产物未变）。`pnpm ui:check` 的 git-clean 断言需在 asset 提交后才成立。

未改设计稿：`design/review-outline.ptr` 本来就是行距 32px（b-r1..b-r10 y=56/88/120…、高亮底 30px），这次是把实现修回设计，不是改设计。
