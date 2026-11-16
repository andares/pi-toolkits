# 远期与延期

> 每条必须写清：是什么、为什么等、什么条件会把它拉回来（触发条件）。
> 被采纳的条目移入 `specs/PLAN.md`，这里留一行指针。

## F1 — ask 的可选交互（`--ask` 启动参数 / `/ask <问题>` / `Ctrl+Alt+A`）

- 是什么：三种少一步的入口——启动即进咨询模式、一条命令连问带答、全局快捷键切换。
- 为什么没做：旧 `PLAN.md` 的决策点 D 当时**未确认**，未实现（原文 `git show 0ba02e8:PLAN.md`）。
- 触发条件：崔总提出「不想先打 `/ask` 再提问」，或使用中每次进咨询都要手敲 `/ask` 成了主要摩擦。
- 落点：`src/features/ask/index.ts` 的命令注册 + `AGENTS.md` §Feature: ask；实现前先补一条
  `registerShortcut` 的键位审计（见 `AGENTS.md` §pi 宿主兼容「键位冲突检查义务」）。

## F2 — `/ask soft` 确认门（不撤工具，写操作弹 a/s/d/f）

- 是什么：ask 的第二档——不摘除 write/edit，改由确认对话框逐个放行。
- 为什么没做：2026-10-19 定稿时评估过，选了 scratchpad 路线；原文把确认门列为「留作将来」的选项
  （`AGENTS.md` §Feature: ask 决策段）。当时的取舍：对话被打断，且工具在手时模型更爱尝试。
- 触发条件：scratchpad 被当成变通写通道使用，或「ask 里确实要改项目、但每次都想确认」的诉求反复出现。
- 落点：`src/lib/gates.ts`（ask 的 tool_call 策略）+ `src/features/permission/prompt.ts` 的对话框复用。

## F3 — autostart 的新配置 section（环境变量、模型选择等）

- 是什么：`[command]` 之外的第二类启动设置。
- 为什么没做：只有 `/add-dir` 与 `/ask-perm` 两类真实用例，按需扩展、不预设（`AGENTS.md` §Feature: autostart 末条）。
- 触发条件：出现第二个真实用例，必须在会话启动时声明环境变量或模型，而不能用一条斜杠命令表达。
- 落点：`src/features/autostart/autostart.ts` 的解析器 + `README*` 的 schema 段。

## F4 — 审计 `E-PATH-01` 对「自己实现迁移工具的项目」误报

- 是什么：本仓 adopt 后 `framework_audit` 报 `E-PATH-01`：119 处裸旧目录引用（`memory`、`implementations`
  不带 `.agents/` 前缀）。实测（2026-10-26）：根下**没有**这两个旧目录；命中来源是 init 功能的实现与测试夹具
  （`src/` 14 文件 108 处，工具本来就要检测/改写这两个裸名）和 AGENTS/README 里描述
  「旧目录 → `.agents/`」的迁移说明（3 文件 11 处）。
- 为什么没修：改这些字面量会破坏 `/ask-init` 的检测与改写语义；不改产品代码就消不掉这条规则。
- 触发条件：出现第二个「自己实现该框架」的仓库需要 adopt 后 E-* 全绿，或该规则排到改版
  （例如按文件角色跳过工具自身与测试夹具）。
- 落点：`src/features/init/detect.ts` 的 `isBareRef` / `scanRefs` 与 `src/features/init/audit.ts` 的 `checkRefs`。

## F5 — `/third-review` 兼容别名待删除（`/review-model` 已删）

- 是什么：`/third-review` 是 `/ask-review` 的兼容别名（同一 handler、同一配置），2026-11-10 改名时
  留下；`/review-model` 同一天**彻底移除**（每次 `/ask-review` 本来就要选模型，配置命令是第二套
  重复入口）。两者都已从对外文档（README*）里清空，一句话都不提。
- 为什么没删别名：`autostart` 只接受注册表里的命令名，名字消失后 `.pi/autostart.toml` 里写着的
  `/third-review` 会被当成普通消息发给模型；留一个版本期避免这条。
- 触发条件：旧拼写连续一两个版本无人使用（看登记表/使用记录没有 `/third-review`），或崔总直接说删。
- 落点：`src/features/review/index.ts` 的 `REVIEW_COMMAND_ALIAS` + 它的 `registerCommand` 块
  + `review.test.ts` 的注册用例（删完记得连断言一起删）。

## F6 — 预约队列（预先排队一串指令，当前回合结束后依次自动执行）

- 是什么：在 AI 还在跑（或刚跑完一轮）时先把后续动作排进队列，队列**每项可以是扩展命令也可以是
  普通提示词**；等当前回合**完全结束**后按顺序自动逐条送出，一条跑完再送下一条。
  （诉求原文见 2026-11-13 崔总口述："以后可以加一个预约功能，能事先输一堆预约指令，包括正常提示词也支持，
  然后在当前 AI 执行完全结束后，自动依次执行"。）
- 为什么等：宿主没有「排队多条」的公开入口，只有单条投递语义；自己实现要先定清队列的生命周期与
  失败策略，不是一行接线能收口的。
- 已知技术锚（pi 1.5.2 `types.d.ts`，2026-11-13 核对）：
  `pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: true })` ——
  `followUp` = 当前 run 结束后投递；`expandPromptTemplates` 决定 `/cmd` 是走扩展命令还是发给模型。
  `sendMessage` 另有 `triggerTurn` / `deliverAs: "nextTurn"`，但那是自定义消息、不产生用户回合。
- 未定（实现前要跟崔总定）：队列**存在哪**（内存 / 会话条目 / 配置）、`/reload` 与 `/quit` 后是否保留、
  某条失败（命令不存在、模型报错、用户中断）时**继续还是停**、队列是否在 TUI 可见可编辑、
  与 autostart（启动即重放）的先后关系。
- 触发条件：崔总提出「一轮结束后还要接着跑好几步、不想盯着屏幕手动敲下一条」，或已有工作流
  （如 ask → plan → 实施）反复出现固定串行顺序。
- 落点：新 feature `src/features/queue/`（命令注册 + 队列状态机 + `before_agent_start`/回合结束钩子），
  复用 `src/lib/gates.ts` 的闸门与 autostart 的命令预校验（未注册命令名不能发给模型）；
  AGENTS.md 新增 §Feature: queue 与命令速查行；README / README.zh-CN 同步。
