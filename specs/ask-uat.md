# SPEC: `/ask-uat` — 验收台账与浏览器页面

> 状态：**已实现**（2026-11-12）。实施记录见 `.agents/implementations/2026-11-12_0313_ask-uat.md`。

## 1. 目标

回答一个问题：**这一批交付里，哪些还没验过？** 验收单位是「用户可见行为」，不是提交。
实施侧写记录 + 一句话行为；UAT 侧把多条记录聚成少数验收项，页面只负责看摘要、展开测试方案、勾掉。

## 2. 范围

**做**：`record_change`（规范记录 + 候选事件）、`/ask-uat`（聚类 + 页面 + 勾选）、
`.agents/uat/ledger.jsonl`（只追加事件流）、`/ask-init refresh`（框架文字刷新）、
计划期的 bash 窄闸门与访谈协议。

**不做**：在页面里编辑/排序/评论/指派；给 review 盖章（review 与 uat 分离）；
把实施报告 JSON 化（散文保持散文，桥是独立账本）。

## 3. 已确认的决策

| # | 决策 |
| --- | --- |
| D1 | 分钟精度：`YYYY-MM-DD_HHMM_slug.md` + `# YYYY-MM-DDTHH:MM±HH:MM — 标题`；读取端兼容旧的秒级/旧文件名，历史文件不改名 |
| D2 | review 与 uat 完全分离：`/ask-review` 自由发挥、不落状态；页面不显示「审过」 |
| D3 | 实施报告保持散文；N:M 关系放独立账本（一项多记录、一记录多项） |
| D4 | 聚类只在 UAT 侧：实施会话并行且互相看不见，项的身份必须单点创建 |
| D5 | 没有提交：勾选即 `check` 事件；关页面不丢；已勾可反选；不勾也行 |
| D6 | 页面边界：只读摘要 + 勾选 + 证据抽屉，不做任何编辑 |
| D7 | 账本只住主仓（worktree 会话写主仓），只追加、按事件 id 去重、进 git |
| D8 | 每轮上限 40 条候选 / 12 个新项，超出留在 pending 并在页面顶部常显 |
| D9 | 新证据自动重开（`reopened` = 最新证据时间 > 最后一次 check） |
| D10 | `record_change` 只在装了框架的项目激活；`/ask-uat` 没有框架直接拒绝 |
| D11 | 框架刷新不升 `FRAMEWORK_VERSION`：UAT 目录是可选增量，用 `I-UAT-01` 表示未装 |

## 4. 数据模型

```text
.agents/uat/
├── README.md      # 合同（框架拥有，refresh 可重写）
└── ledger.jsonl   # 只追加事件流
```

事件类型：`candidate` / `batch` / `item` / `link` / `check` / `uncheck` / `amend` / `merge` / `drop`。
派生是纯函数（`deriveState`），页面读到的一切都从事件流 + 磁盘上的记录算出来。

`pending` 的定义是「磁盘上未被任何存活项引用的记录」——目录本身就是兜底索引，手写记录同样进队列。

## 5. 验收

- `pnpm test` 48 文件 / 841 测试全绿。
- `pnpm typecheck`、`pnpm ui:typecheck` 绿；产物 `src/features/uat/assets/` 由第二套 Vite 入口构建。
- 真实 pi 1.5.2 冒烟：`pi -p --no-extensions -e ./src/index.ts --tools ''` 回 `OK`。
- 待补（需要崔总真机）：`/ask-uat` 在真实浏览器里勾选一次、确认关页重开仍在。

## 6. 风险

- 摘要会过期：靠 `link` 触发的 `reopened` 兜住；「改了却没记候选」只能靠 `W-UAT-02` 提示年龄，是启发式的天花板。
- 聚类质量取决于实施侧行为句：`hint: "none: <理由>"` 是明确记录，不是缺失字段。
- 账本进 git 会带来分支冲突：事件带 id，读侧去重，冲突两边都留。
