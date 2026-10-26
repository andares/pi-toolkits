# PLAN：@andares/pi-toolkits

> 计划只放「还要做什么」：未决项、没留证据的验收、欠着的债。已收口 → `.agents/memory/FINISHED.md`；
> 已知与已定 → `.agents/memory/ARCHITECTURE.md`；改过什么 → `.agents/implementations/`。
> 进度不写在这里：进度只有一个事实源，就是 agent 的 todo 清单。
>
> 文件来历：2026-10-26 采纳 agent-framework v1 时，旧 `PLAN.md`（ask 落地期，2026-08）被原样搬到
> `specs/PLAN.md` 再整形——决策点 A/B/C/D 进 `.agents/memory/ARCHITECTURE.md`（D1–D6），已收口的
> 落地清单进 `.agents/memory/FINISHED.md`（M0）。原文永久留在 git 历史：`git show 0ba02e8:PLAN.md`。

## 路由

| 想知道 | 读 |
| --- | --- |
| 不变量、命令、宿主兼容纪律、各 feature 现行规格 | `AGENTS.md` |
| 分层、版本基线、仍生效的决策 | `.agents/memory/ARCHITECTURE.md` |
| 已收口里程碑 | `.agents/memory/FINISHED.md` |
| 延期项与触发条件 | `.agents/memory/FUTURE.md` |
| 记忆的写规则与预算 | `.agents/memory/README.md` |

## 未决 1 — AGENTS.md 超预算（债务，2026-10-26 实测）

- 实测：`wc -c AGENTS.md` = **58663 字节**（34227 字符）。预算：soft 12000 / hard 20000
  （`.agents/memory/README.md` 的 Budgets 表；`framework_audit` 的 `W-BUDGET-01` 用字节比）。
  超出 hard 预算 38663 字节，本文件首次登记时是 57797 字节（加索引段后 +866）。
- 本轮按保守 pass 处理：**不搬章节、不重写正文**，只登记债务（工作单 `budget-debt` 的原文要求：
  "This pass does not rewrite prose: record the overflow in `specs/PLAN.md` as debt"）。
- 章节与建议去处（字符数 = `##` 到下一个 `##` 之间，含子标题与代码块）：

  | 章节 | 字符 | 建议去处（留一行指针） |
  | --- | --- | --- |
  | §pi 宿主兼容 | 9687 | 记忆层新建 `FUNCTION-COMPAT.md`（保留「窗口/探针/public floor」三条不变量在 AGENTS.md） |
  | §Feature: permission | 9347 | 记忆层新建 `FUNCTION-PERMISSION.md`（AGENTS.md 只留四格默认值、a/s/d/f、凭据/破坏性两张表） |
  | §Feature: init | 4301 | 记忆层新建 `FUNCTION-INIT.md`（AGENTS.md 只留命令入口与"覆盖表有 OPEN 不算完成"） |
  | §Feature: autostart | 3935 | 记忆层新建 `FUNCTION-AUTOSTART.md`（AGENTS.md 只留"仅扩展命令 + 项目信任"） |
  | §Feature: ask | 2928 | 记忆层新建 `FUNCTION-ASK.md`（AGENTS.md 只留"项目写不可能 + scratchpad 唯一写通道"） |
  | §Release | 1880 | 暂留（发布命令与回滚是不可省的操作步骤） |
  | §分发与发现 | 1030 | 暂留（关键词即注册，发布前必看） |

  上表按「扇出即重建上下文」的顺序搬：先 permission/init/autostart 三个功能段（可整段指针化），
  再动宿主兼容（它的三条不变量必须留在 AGENTS.md，否则每次请求都要多点一次指针）。
  口径备注：`framework_audit` 的 `W-BUDGET-01` 也报其中几段的数，与上表差个位数字符；
  差异大的是 autostart（它报 863）——它把该段 TOML 代码块里顶格的 `#` 行当成一级标题提前截断，
  上表按真实边界量。

- 验收：`wc -c AGENTS.md` ≤ 12000 字节；每个搬走的章节在原位置留 `§见 <path>#<heading>`；
  覆盖表（`.agents/framework/reports/`）补一行说明新家；`framework_audit` 的 `W-BUDGET-01` 消失。
- 为什么不在本轮做：结构性改写属于 `--deep`（`AGENTS.md` §Feature: init 的「默认保守 pass」条）；
  且这次是 adopt 首轮，先把索引、路径、覆盖表立起来，压缩单独一轮更容易审 diff。

## 未决 2 — ask 的手动验收没有证据（TBD）

旧计划的 `## Verification` 里有 6 条人工项，仓库里没有任何记录说明谁在哪个宿主版本上按过。
**状态：TBD**（不是"通过"，也不是"失败"）。

- 待验（原样保留旧计划的口径）：
  1. `/ask` 进入 → footer 出现灰色 `ask` 状态、有 notify；
  2. 要求模型 write/edit → 被硬拒（Tool not found），磁盘无变化；
  3. `ls`/`git status`/`cat` 等只读 bash 放行；`rm`/`npm install`/`git commit`/重定向被 block 且带 reason；
  4. 模型回答受 banner 约束；
  5. `/ask` 退出 → 工具集完整恢复、footer 状态清除；
  6. 退出后 write/edit 正常工作（快照恢复正确）。
- 已有证据（覆盖不到上面 6 条）：`pnpm test`（ask 单元测试与沙箱边界用例）、
  `pnpm check:compat` 矩阵、`AGENTS.md` §Feature: ask「已验证」里的 scratchpad 冒烟。
- 收口方式：崔总在一次真实会话里逐条过一遍，结论写回 `AGENTS.md` §Feature: ask 的「已验证」，
  然后删掉本条。

## 未决 3 — 根目录 `plans/` 与 `specs/` 两个计划家

- 现状：根下 `plans/` 还有 5 个单元方案——`compact-model.md`、`favorites.md`、`permission.md`、
  `review.md`、`stash.md`（2026-08-08 – 2026-10-23 写入）。框架只认 `specs/` 是计划的家
  （`.agents/memory/README.md` 的 Where things live 表），`README.md` 描述的布局也是 `specs/`。
- 为什么本轮没动：目录移动不在工作单里（"do not move, rename or scaffold directories yourself
  unless a task says so"）。
- 待办：崔总点头后 `git mv plans/*.md specs/` → 改写引用（AGENTS.md / README / 代码注释）→
  更新本文件的路由表。
- 证据：`ls plans/`。

## 未决 4 — 运维与审计的已知账

- `W-STATE-01`（未提交）：`.agents/memory/` 与 `specs/` 还在工作区，没进 git。新装后的正常状态；
  本轮不自行 commit（提交是崔总的动作）。
- `E-PATH-01`（已知误报，2026-10-26 实测 119 处 / 17 文件）：`ls -d memory implementations prompts`
  三个都报 No such file or directory（它们已在 `.agents/` 下），所以“迁移后会断”的前提不成立；
  命中的是 init 功能的**实现与测试夹具**（`src/` 14 文件 108 处，工具本来就要检测/改写
  这两个裸名）与 AGENTS/README 里「旧目录 → `.agents/`」的迁移说明（3 文件 11 处）。
  改这些字面量会破坏 `/ask-init` 的语义，故不修；条目与触发条件见 `.agents/memory/FUTURE.md` F4。
- `W-SCAFFOLD-01`（已就地修掉）：AGENTS.md 的审计码清单原本原样写了 ask-init 的 `TODO` 占位字面，
  被自己的规则命中；改成「未填的 ask-init 模板标记（`TODO` 占位）」。
- `W-COV-01`（已修）：覆盖表已填满，0 OPEN。

## 已延期（指针，不在这里展开）

- ask 的可选交互（`--ask` / `/ask <问题>` / 快捷键）→ `.agents/memory/FUTURE.md` F1。
- `/ask soft` 确认门（不撤工具、写操作弹 a/s/d/f）→ `.agents/memory/FUTURE.md` F2。
- autostart 的新配置 section（环境变量、模型选择等）→ `.agents/memory/FUTURE.md` F3。
