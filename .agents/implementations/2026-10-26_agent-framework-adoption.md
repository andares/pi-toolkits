# 2026-10-26T11:16:32+08:00 — 采纳 agent-framework v1（adopt，保守 pass）

## 起因

本仓已有 `AGENTS.md`（57797 字节，长期当唯一记忆用）与根级 `PLAN.md`（ask 落地期的旧计划），
没有任何 `.agents/` / `specs/` 结构。崔总运行 `/ask-init`（tool 0.11.0，framework v1）执行 adopt。

## 做了什么

### 确定性的那一半（`/ask-init` 代码执行，本记录只登记结果）

- `git mv`-等价的 `move-file`：`PLAN.md` → `specs/PLAN.md`（内容零改动）。
- 建 6 个文件：`.agents/README.md`、`.agents/memory/README.md`（契约）、
  `.agents/memory/{FINISHED,FUTURE,ARCHITECTURE}.md`（seeds）、`.agents/framework/.gitignore`，
  以及 state `.agents/framework/state.toml`。
- 快照 18 个路径到 `.agents/framework/snapshots/2026-10-26T11-08-56-08-00/`（local-only）。

### 修掉 adoption 自己引入的一处回归（不在工作单里，但不修就交付红的门禁）

- 现象：`pnpm test` 收集到 **36** 个测试文件，其中 6 个在 import 阶段失败，原因是
  `.agents/framework/snapshots/.../files/src/**` 里是源码的**字节副本**，副本的兄弟模块留在 `src/`；
  588 个测试仍然通过，失败文件里 0 个可执行测试。
- 修法：新增 `vitest.config.ts`，在 `configDefaults.exclude` 之外追加 `**/.agents/framework/**`。
  vitest 不读 `.gitignore`，所以必须在测试配置里排除，而不是靠 ignore 文件。
- 复验：`pnpm test` → **30 文件 / 588 测试全绿**；`pnpm typecheck` 无输出（通过）。
  这与 `AGENTS.md` §Feature: init「已验证」里记的 30/588 一致。

### 模型这半边（本记录的写入者）

1. **survey**：读 `package.json`、`pnpm-lock.yaml`、`LICENSE`、`README.md`、`AGENTS.md`、`git log`、
   目录树与 `src/index.ts`；结果写进 `.agents/memory/ARCHITECTURE.md` 的「分层」「版本基线」两节
   （版本基线：本包 0.11.0 / pi 1.4.0 / peer `>=0.99.0` / TS 5.9.3 / vitest 4.1.10 / Node 26.5.0 / pnpm 12.14.0）。
2. **edit-agents**：`AGENTS.md` 新增 `## 记忆与索引`（指向契约、三份记忆、`specs/PLAN.md`、
   `.agents/implementations/`）——修掉 `E-INDEX-01`；`§Feature: init` 的目录树把 `.agents/` 下四个子目录
   写成真路径；审计码清单里原样出现的
   `TODO(ask-init)` 字面改成「未填的 ask-init 模板标记（`TODO` 占位）」——修掉 `W-SCAFFOLD-01`。
   **没有搬任何章节**（预算债见 `specs/PLAN.md` 未决 1）。
3. **edit-plan**：`specs/PLAN.md` 从旧计划整形为「只有未决项」：决策点 A/B/C/D → `ARCHITECTURE.md` D1–D6，
   已收口的落地清单 → `FINISHED.md` M0，`[x]` 进度表与「已完成」项删除，人工验收的 6 条留成未决 2（状态 TBD）。
4. **budget-debt**：`AGENTS.md` 实测 58663 字节 / 34227 字符（soft 12000 / hard 20000 字节），
   章节清单与建议去处写进 `specs/PLAN.md` 未决 1；本轮不动章节。
5. **coverage**：`.agents/framework/reports/coverage-2026-10-26T11-08-56-08-00.md` 填满，
   `##` 与 `###` 各一行，0 OPEN。

## 路径引用改写（迁移允许的唯一一种历史改写，逐条列出）

| 文件 | 原文 | 改为 |
| --- | --- | --- |
| `src/features/ask/index.ts` | `Design notes (see PLAN.md and AGENTS.md):` | `Design notes (see AGENTS.md §Feature: ask, plus the D1–D6 records in .agents/memory/ARCHITECTURE.md):` |
| `src/features/ask/prompt.ts` | `replacement (see PLAN.md).` | `replacement (see \`AGENTS.md\` §Feature: ask and the D5 record in \`.agents/memory/ARCHITECTURE.md\`).` |
| `AGENTS.md` §Feature: init 目录树 | `.agents/` 下四个子目录原先写成短名 | 一行一个 `.agents/<子目录>/` 真路径 |
| `AGENTS.md` 审计码清单 | `` `W-SCAFFOLD-01` 未填的 `TODO(ask-init)` `` | `` `W-SCAFFOLD-01` 未填的 ask-init 模板标记（`TODO` 占位） `` |

两处源码注释改写的理由：`PLAN.md` 已不在根下，且 ask 的设计说明现已分居 `AGENTS.md` §Feature: ask
（现行语义）与 `.agents/memory/ARCHITECTURE.md` D1–D6（决策脉络）。

## 证据与复核

- `git status --porcelain`：`R  PLAN.md -> specs/PLAN.md`、`?? .agents/`、`?? vitest.config.ts`、
  `M AGENTS.md`、`M src/features/ask/{index,prompt}.ts`。
- `pnpm test`：30 文件 / 588 测试全绿（2026-10-26 11:13 实测）。`pnpm typecheck`：通过。
- `framework_audit`（2026-10-26 末次跑）：**1 error / 2 warnings / 0 info**。
  `E-PATH-01`（已知误报，理由与触发条件记在 `.agents/memory/FUTURE.md` F4）、
  `W-BUDGET-01`（债务，`specs/PLAN.md` 未决 1）、`W-STATE-01`（待提交，未决 4）。
  `E-INDEX-01` / `W-COV-01` / `W-SCAFFOLD-01` 本轮已消。

## 没做的事（有意）

- 不提交（commit 是崔总的动作）；不动根下 `plans/`（工作单禁止搬目录，见 `specs/PLAN.md` 未决 3）；
  不搬 `AGENTS.md` 的大章节（保守 pass，债已登记）；不改 `E-PATH-01` 涉及的字面量（会破坏 init 功能）。
