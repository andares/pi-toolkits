<!-- markdownlint-disable MD033 -->
<!-- Inline <a name> anchors are the only reliable TOC targets for CJK headers on GitHub. -->
# ⚙️ @andares/pi-toolkits

[English](README.md) · **中文**

> pi 编码代理的集成扩展工具包 — 一个包,持续生长新能力。

[![npm version](https://img.shields.io/npm/v/@andares/pi-toolkits?label=npm&logo=npm)](https://www.npmjs.com/package/@andares/pi-toolkits)
[![Pi package gallery](https://img.shields.io/badge/pi.dev-package%20gallery-6f42c1)](https://pi.dev/packages/@andares/pi-toolkits)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Package Manager](https://img.shields.io/badge/package%20manager-pnpm-orange?logo=pnpm)](https://pnpm.io)
[![pi >= 0.99](https://img.shields.io/badge/pi-%3E%3D0.99.0-blueviolet)](https://github.com/earendil-works/pi)
[![GitHub](https://img.shields.io/badge/github-andares%2Fpi--toolkits-181717?logo=github)](https://github.com/andares/pi-toolkits)

一句话介绍:目前包含七个开箱即用的功能——**只读咨询模式** `ask`、**会话级边界权限** `ask-perm`、**模型收藏** `favorites`、**提示词暂存** `stash`、**第三方代码评审** `third-review`、**独立压缩模型** `compact-model`、**会话启动自动化** `autostart`,后续持续追加。

**版本要求**:pi `>=0.99.0`。0.99.0 到 1.4.0 的每一个已发布版本都用完整门禁实测过(install → `tsc --noEmit` → 全量测试 → 键位审计 → 对 patch 目标宿主文件做哈希比对),每个版本都在沙箱中把整个 `@earendil-works/*` 家族钉在同一版本。更新的版本随发布逐个验证,下限只在实测结果允许时移动;`pnpm check:compat` 可复现该结论。注:pi ≥ 0.99 的宿主要求「宿主提供的包」一律声明为 peerDependencies `"*"` —— `@earendil-works/pi-tui` 与 `typebox`(ask 的 `scratchpad` 用它构造参数 schema)都按此声明;若放进 `dependencies`,pi 会告警。

---

## 📦 安装

<a name="install"></a>

```bash
# 从 npm 安装(推荐) —— 也已收录进 pi 官方包编目
# https://pi.dev/packages/@andares/pi-toolkits
pi install npm:@andares/pi-toolkits

# 本地开发安装
pi install .

# 单次会话加载,不安装
pi -e ./src/index.ts
```

安装后在任意 pi 会话中验证:

- `/ask` → footer 出现灰色 `ask` 状态,`write`/`edit` 被硬禁用,同时出现 `scratchpad` 工具用于草稿笔记
- `/model`(或 `ctrl+l`)→ 选择器顶部出现收藏提示行;对选中模型按 `ctrl+A` → 文字变**加粗亮黄**、收藏计数 +1(这一步同时就是真机按键检查,见「键位」约定)
- 输入框内按 `ctrl+alt+y` → 当前提示词被暂存并清空输入框
- 完成一个开发任务后输入 `/third-review` → 切换到评审模型执行查+修
- `/compact-model` 选一个便宜快模型 → 之后 `/compact` 与自动压缩的总结都由它执行(footer 出现灰色 `compact` 状态)

---

## 📚 目录

- [安装](#install)
- [功能总览](#features)
  - [🛡️ ask — 只读咨询模式](#ask)
  - [🔐 permission — 会话级边界权限](#permission)
  - [⭐ favorites — 模型收藏](#favorites)
  - [📥 stash — 提示词暂存](#stash)
  - [🔎 review — 第三方代码评审](#review)
  - [🗜️ compact — 独立压缩模型](#compact)
  - [🚀 autostart — 会话启动自动化](#autostart)
  - [🧠 init — agent 记忆框架](#init)
- [开发](#development)
- [贡献](#contributing)
- [许可](#license)

---

## ✨ 功能总览

<a name="features"></a>

| 功能 | 入口 | 一句话说明 |
| --- | --- | --- |
| 🛡️ **ask** 只读咨询模式 | `/ask` | 进入咨询模式:`write`/`edit`/`powershell` 硬禁用,`bash` 只读沙箱,临时启用 `grep`/`find`/`ls`,并开放 `scratchpad` 把草稿写进会话临时目录 |
| 🔐 **permission** 会话级边界权限 | `/ask-perm` | 项目内/外 × 读/写四格模式,默认关闭且从不落盘;项目外写询问、凭据路径硬拒、破坏性命令必问;与 `/ask` 并行组合;另有滚动 JSONL 审批日志供事后挖规则 |
| ⭐ **favorites** 模型收藏 | `/model` 内 `ctrl+A` / `ctrl+J` | 收藏常用模型(加粗亮黄标记),`ctrl+p` 仅在收藏间循环 |
| 📥 **stash** 提示词暂存 | `ctrl+alt+y` | 一段提示词的暂存槽,按键交换 / 连按两次暂存并清空输入框 |
| 🔎 **review** 第三方代码评审 | `/third-review` | 召唤配置的评审模型,对刚完成的任务做查+修,重点检查「本轮需求实现 / 是否有遗漏 / 是否有错误」 |
| 🗜️ **compact** 独立压缩模型 | `/compact-model` | 给 `/compact` 与 auto-compact 配一个便宜快模型做总结,主模型专注对话;未配置零开销、任何异常回落 pi 默认 |
| 🚀 **autostart** 会话启动自动化 | `.pi/autostart.toml` | 项目内声明启动时自动执行的斜杠命令(首批用例:`/add-dir` 多仓库挂载);未信任不执行、未注册命令跳过不发给模型 |
| 🧠 **init** agent 记忆框架 | `/ask-init` | 安装或接管一套固定的记忆结构(`AGENTS.md` + `specs/` + `.agents/memory` + `.agents/implementations`),带快照与覆盖表迁移旧文档,之后可随时审计漂移、预算与重复事实 |

---

## 🛡️ ask — 只读咨询模式

<a name="ask"></a>

用 `/ask` 进入(再按一次退出)。适合只想要「问问题、读代码」的场景:模型不能改项目,但不会被剥夺思考的落点。

**进入后**:

- **项目文件写入仍然机制上不可能** —— `write` / `edit` / `powershell` 从活跃工具集中移除,pi 对未激活工具的调用直接拒绝("Tool not found");闸门还会二次拦截,防止有东西把它们重新打开
- **只留一个写通道:`scratchpad`** —— 参数是**相对**笔记名(`plan.md`、`notes/api.md`),只能落到 `<os.tmpdir()>/pi-ask/<session-id>`。它注册时处于未激活状态(`defaultActive: false`),只在 ask 模式里启用,所以它的声明与「笔记不是交付物」的 guidelines 恰好在适用时才进入请求。单文件上限 256 KiB,路径上已存在的符号链接会被拒绝,里面的东西永不被执行—— bash 沙箱因此完全不需要写权限。宿主没有可写临时目录时工具保持未激活,模式降级为旧的纯只读(进入时的提示会说清楚,不做半开)
- **临时启用只读检索工具** —— `grep` / `find` / `ls`(宿主已注册但默认不激活)在 ask 期间打开,让模型有正规搜索工具而不是只能走 bash;退出时按进入前快照完整恢复
- **`bash` 保留但只读沙箱** —— shell 分词 + 逐段校验 + 写盘意图检测。除常见读取命令外,放行 git 考古族(`blame`、`grep`、`rev-parse`、`describe`、`shortlog`、`reflog show`、`stash list`、`tag -l`、`cat-file` 等)、包元数据查询(`pnpm view`、`pip show/list`、`python -m json.tool`),以及网络读取 `curl -s <url>` / `wget -O - <url>`。仍拦截:重定向、`tee`、`dd`、`sed -i`、安装/构建、git 变更类命令、命令替换、会启动其它程序的选项(`find -exec`、`git grep -O`、`rg --pre`),以及一切写盘目标(`curl -o`、`wget -O file`、`git diff --output=`、`tree -o`)。启发式,非安全边界
- **短横幅而不是清单** —— 系统提示词只追加三行:咨询模式、草稿通道、退出方式。**不再重述 bash 白名单** —— 那是沙箱的职责,被拦时的拒绝理由会直接指出可用的替代,所以细节只在真用到的那一轮付费(旧横幅每个请求都要重申一遍,约 300 token)。横幅不含路径与时间戳,会话内字节稳定,可以稳定命中 provider 的提示词缓存
- **拒绝理由指向下一步** —— 被拦的 `write` / `edit` 会说明草稿用 `scratchpad`、真正改动要 `/ask` 退出;被拦的重定向也同样指路,而不是只说「不能写」
- **灰色 `ask` footer 状态** —— 常驻提示当前处于咨询模式

**草稿生命周期**:每个会话一个目录,位于系统临时目录(`os.tmpdir()`,所以 Windows 的 `%TEMP%` 也适用);进入时创建、退出时**不删**——续会话(`pi -c`)还能找回笔记,进程内切换会话(/new、/resume、fork)会重新绑定到新会话的目录;进入时清掉超过 7 天的旧目录。开启提示会打印路径;里面的内容不属于项目,也不会出现在 `git status` 里。

**退出**:再按 `/ask`,完整恢复进入前的工具集快照(含 scratch 工具与临时启用的只读工具)。

---

## 🔐 permission — 会话级边界权限

<a name="permission"></a>

`/ask-perm` 只在**当前会话**开启边界检查。开关状态、四项模式、会话授权全部只存在扩展内存里:权限**状态**不落盘、默认关闭、关闭后不留任何状态。开启一次不会悄悄跟到下一个会话。另外,值得留档的判定会追加到本地**审批日志**(见下),供事后挖规则用;它是只写的遥测数据,判定时永远不会被读取。

**开启**

- `/ask-perm` —— 打开模式面板。顶行按回车即应用,四行用空格循环、↑↓ 移动;光标默认在最上面,所以「输入指令 + 回车」就是按默认值开启
- `/ask-perm allow allow allow ask` —— 位置参数形式(`in-read in-write out-read out-write`),不弹窗直接开启;没给全的参数回落到默认值。这也是 autostart 使用的形式
- 再输入一次 `/ask-perm` —— 关闭

参数形式重复执行、且四项模式与当前一致时是**空操作**:不会再出一条「ON」提示,也不会清掉已经攒下的会话授权。只有模式真的变了才会提示并清空授权——那些授权是按旧策略给的。

**默认值**:项目内读/写全放行,项目外读放行,项目外写询问。

| 作用域 | 读 | 写 / 执行 |
| --- | --- | --- |
| 项目内(工作目录 + `/add-dir` 加入的目录) | `in read` | `in write` |
| 项目外 | `out read` | `out write` |

`exec` 折进 `write`:任何产生变更的执行都算写。

**检查方式**

- **bash** 先拆成简单命令 —— `&&`、`||`、`;`、管道、`$(…)`、反引号、`bash -c`、`eval`、常见间接包装(`sudo`、`env`、`xargs`、`find -exec`…)、heredoc —— 再逐条判定;`cd` 向前折叠,取最严格的结果,所以 `cd /tmp && rm x` 不会靠第一段蒙混过关
- **带路径的工具**(`read` / `write` / `edit` / `grep` / `find` / `ls`)按自己的路径判定;其它工具按工作目录判定
- **无法解析的输入** —— 非字面量 `cd` 或 `git -C`、路径里的未知 shell 变量、未闭合的 heredoc/命令替换 —— 一律询问,不看模式(fail closed),绝不猜测
- **`git -C <dir>`** 按局部 `cd` 处理:相对路径参数(和仓库本身)按 `<dir>` 判定,而不是工作目录

**回答**:`a` 本次允许 · `s` 本会话允许该目录 · `d` 拒绝 · `f` 本会话拒绝该目录。会话授权在内存中按 `(读|写, 目录)` 保存、按包含关系匹配,关闭模式或会话结束时清空;**会话授权优先于破坏性表**——你按了 `s` 之后,重复同一操作不会再弹;解析不了完整路径的命令则按**完整命令文本**授权,重复同一条命令不会再问。

**固定安全表**(与四格模式无关):

- **凭据路径任何模式都拒绝** —— `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.pi/agent/auth*.json`、`.env` 文件(模板除外)。没有这一条,默认的「项目外读放行」就等于把 `~/.ssh/id_rsa` 交出去
- **破坏性命令永远询问** —— 对 `/`、家目录或工作目录的 `rm`;`git reset --hard`;`git clean -f`;`git push --force`;包 `publish`;`dd` 写裸设备;`mkfs*`;关机/重启;`chmod -R 777`;任何经 `sudo` 的命令。作用域本身表达不了「破坏性」

**审批日志**(只写遥测,默认开启)

每个值得留档的判定都会写成一行 JSON(JSONL),落在 `~/.pi/agent/approval-log/audit-NNNNNN.jsonl`。策略层从不读它:删掉日志或把目录改成只读,不会改变任何判定结果。

- **范围**:`/ask` 模式的拦截同样算审批决定,也会记录(带闸门名与模型可见理由)。
- **记录什么**:交互弹窗(用户看到的原始行、bash 拆解结果、答复、授权与决策耗时)、自动拒绝/拦截、会话授权放行、`/ask-perm` 模式切换,以及每个会话一条 `session` 摘要(调用/弹窗/拦截计数)。普通自动放行的 `read`/`grep` 默认不记,避免把环形缓冲淹在噪声里;`PI_APPROVAL_LOG=all` 连普通自动放行也记,`PI_APPROVAL_LOG=off` 关闭日志。
- **滚动**:每文件 1000 条**或** 8 MiB,最多 10 个文件;创建第 11 个时删掉序号最小的那个。典型体积 15–30 MB(硬上限 80 MB),约保留最近 1 万条判定。
- **保真度**:四格模式、会话根目录、工具调用、每个命令单元(含 `opaque` 单元与解析器备注)、每个目标规范化后的路径/读或写/项目内或外、命中哪条规则层、弹窗原文、答复与产生的授权。`write`/`edit` 的文件**正文永不记录**(只记路径与字节数);bearer token、`token=`/`password=`、URL 内嵌凭据与已知密钥前缀会脱敏。
- **失败与隐私**:目录 `0700`、文件 `0600`,只在本机,可随时删除。日志故障只警告一次并被吞掉——判定链路不会因为日志不可用而失败。`PI_APPROVAL_LOG_DIR` 可改目录。

```bash
# 只看"本会话允许"的弹窗
jq -r 'select(.event=="ask" and .answer.choice=="allow-session")
       | [.ts,.tool,.verdict.target,.input.command] | @tsv' \
  ~/.pi/agent/approval-log/*.jsonl

# 目标根目录 × 答复 —— 找「临时目录直接放行」规则的最短路径
jq -r 'select(.event=="ask") | [.verdict.grantRoot,.answer.choice] | @tsv' \
  ~/.pi/agent/approval-log/*.jsonl | sort | uniq -c | sort -rn

# 解析不了的单元:定位 units.ts 的缺口
jq -r 'select(.event=="ask") | .units[] | select(.opaque) | [.command,.note] | @tsv' \
  ~/.pi/agent/approval-log/*.jsonl | sort | uniq -c | sort -rn
```

仓库内可用 `pnpm approval-report` 生成只读汇总(答复分布、目标根目录、候选规则、opaque 缺口、playwright 模式)。

**与 `/ask` 的组合**:两者是同一总线上的独立闸门,各自只回答自己的问题 —— ask 回答「会不会产生变更」,permission 回答「有没有越过边界」,任一拦截都生效。所以 ask 模式下凭据仍然读不到,permission 在只读沙箱下也照常工作;两个功能互不需要知道对方存在。

**每个会话自动开启**(状态本身不落盘,这就是持久化的替身;审批日志独立于它、默认开启):

```toml
# <项目>/.pi/autostart.toml;想对所有项目生效则用 <agent-dir>/autostart.toml
[command]
run = ["/ask-perm allow allow allow ask"]
```

> **实现说明**:新会话在 `session_start` 重置状态(同一会话的重复 emission 保持状态);开启时 footer 显示 `perm i:A/A o:A/ask`(`A` allow、`a` ask、`D` deny)。子代理会话有自己的状态、不继承父会话的模式;需要子会话也受控时,通过项目 autostart 再开启一次。审批日志由闸门总线(弹窗/拦截/会话摘要)与 permission 闸门(模式切换、会话授权放行)追加;写入器懒初始化、不跨进程保存状态,也从不参与判定。实测目标是 POSIX 宿主(Linux/macOS/WSL);原生 Windows Git-Bash 的路径拼写只做了近似,未验证。bash 拆解使用 `shell-quote`;未知变量会展开成哨兵而不是空字符串,使该命令转为询问而不是被悄悄当成空路径。add-dir 目录从 pi-add-dir 的会话条目 `add-dir:state` 读取。启发式,不是沙箱:项目内的破坏性操作由固定表兜底,而不是靠沙箱。已知盲区一处:**读命令的裸文件名参数**(`cat notes.txt`)不被收集为目标,所以把 `out read` 调成 `ask` 时只有绝对路径形状的读目标会被问——读本身不会写,四格模式的写侧不受影响。

---

## ⭐ favorites — 模型收藏

<a name="favorites"></a>

标记常用模型,让模型切换「粘」在收藏上。收藏**跨会话、跨项目全局持久化**。

**在 `/model` 选择器内**(`/model` 或 `ctrl+l` 打开):

- 顶部提示行显示按键与当前过滤状态
- `ctrl+A` —— 对当前选中模型开/关收藏;收藏的模型文字显示为**加粗亮黄**
- `ctrl+J` —— 开/关「仅显示收藏模型」过滤(可与内置搜索叠加使用)

**模型循环**:只要存在 ≥1 个收藏,`ctrl+p` / `ctrl+shift+p` 就**只在收藏模型间循环**。当前模型不是收藏时,`ctrl+p` 跳到第一个收藏、`ctrl+shift+p` 跳到最后一个;收藏仅 1 个时停在原地(`Only one model available`)。`ctrl+l` / `/model` 始终可自由选择任意模型(含非收藏)。在状态文件中设 `"cycleOnlyFavorites": false` 可恢复全量循环。

**状态文件**:`<agent-dir>/pi-toolkits-favorites.json`(默认 `~/.pi/agent/`,与 auto-naming-session 配置同目录):

```json
{
  "favorites": ["anthropic/claude-sonnet-4"],
  "config": { "cycleOnlyFavorites": true }
}
```

`/favorites` 命令列出当前收藏与循环模式。

> **实现说明**:pi 的 `app.model.cycleForward`(`ctrl+p`)与 `cycleBackward` 是**保留键位**,扩展快捷键无法覆盖;且扩展快捷键只在编辑器聚焦时生效。因此本功能不重绑任何按键,而是在运行时 patch 两个内置原型(带版本守卫、`/reload` 幂等):`ModelSelectorComponent`(提示行、`ctrl+A`/`ctrl+J`、亮黄渲染、仅收藏过滤——按键仅在选择器内消费,编辑器里 `ctrl+j` 换行不受影响)与 `AgentSession.cycleModel`(收藏循环)。若 pi 升级导致 patch 无法应用,会 warn 并优雅降级,不影响其它功能。
>
> **为何是 `ctrl+A` 而不是 `ctrl+F`**:pi 自 1.0 起 `tuiMode` 默认 `fullscreen`(0.87–0.99 默认 `regular`),而在 Windows/WSL 上宿主把 `tui.altScreen.search` 解析为 `ctrl+f`;`TuiAltScreen.handleViewportInput()` 在**把输入交给聚焦覆盖层之前**先检查该绑定,于是 `ctrl+f` 打开了会话记录搜索、根本到不了选择器。曾过渡性地选过 `ctrl+alt+f`——pi 层完全空闲,却被 Windows 侧截图工具作为全局热键截走:**宿主表空闲 ≠ 机器层空闲**。最终从 "favorite" 一词里逐字母审计:`v` 是 Windows Terminal 的粘贴键,`o`/`r`/`t` 是宿主 app 层动作,`i` 与 Tab 字节恒等(选择器的 scope 切换),`e` 可用但无记忆点;`a` 仅遮蔽搜索框内的行首跳转、读作 *add favorite*,且选择器上游无任何消费者。完整依据见 `src/features/favorites/constants.ts` 与 `pnpm check:keybindings`。

---

## 📥 stash — 提示词暂存

<a name="stash"></a>

一个热键 + 一个暂存槽,在「当前提示词」与「暂存提示词」之间腾挪,方便把一段提示词先放一边、空出输入框写新的,需要时再取回。

| 操作 | 效果 |
| --- | --- |
| 按一次 `ctrl+alt+y` | 当前提示词 → 入缓存;缓存内容 → 填入输入框(**交换**) |
| 间隔再按 | 在两段提示词之间**来回切换** |
| **400ms 内连按两次** | 当前提示词入缓存 + **清空输入框**(旧暂存被丢弃),直接开写新提示词;之后按一次取回 |

缓存为空时,单按一次即「暂存 + 清空」。缓存为**进程内内存、不落盘**(提示词可能含敏感内容);`/new` 切会话不清缓存,`/reload` 清空。选择器(`/model`、`/tree` 等)打开时按键不生效(焦点在组件,不在编辑器)。

**为什么是 `ctrl+alt+y`**(四级兼容性调研结论):

| 层面 | 状态 | 说明 |
| --- | --- | --- |
| pi 键位 | ✅ | 无默认 `ctrl+alt+字母` 绑定;扩展快捷键在编辑器内最先分发 |
| Linux 终端 | ✅ | `alt` 以 ESC 前缀编码(`ctrl+alt+y` = `ESC + ctrl+y`),不依赖 kitty 协议即可区分 |
| Windows Terminal | ✅ | 无默认 `ctrl+alt` 绑定 |
| Windows 操作系统 | ✅ | 系统级仅保留 `ctrl+alt+del` |

**被排除的候选**:`ctrl+shift+字母` —— Linux 与 Windows 的终端 emulator 都占用复制/粘贴/标签页;且无 kitty 协议的终端上会坍缩成 `ctrl+字母`(`ctrl+shift+m` 即回车,会直接提交提示词,危险)。纯 `ctrl+字母` —— pi 几乎全部占用,唯一空闲的 `ctrl+q` 是 XON 流控字符,有历史包袱。

---

## 🔎 review — 第三方代码评审

<a name="review"></a>

开发任务完成后,输入 `/third-review` 指令召唤**另一个模型**以第三方身份,对刚完成的代码做「查 + 修」:评审模型拥有**完整工具权限**,确认的问题直接改,不是只读审计。评审回合留在当前会话记录里,评审完成后**会话保持评审模型**(不自动切回)。

> **仅指令触发**:只有 `/third-review` 能发起评审。聊天中直接输入 `third-review` 不会触发(作为普通消息发给模型),避免误发。

**评审提示词重点检查三点**(逐项给出结论):

1. **本轮需求实现** —— 需求是否已完整、正确地实现,与需求描述是否一致
2. **是否有遗漏** —— 功能点、边界情况、异常处理、兼容性、测试等
3. **是否有错误** —— 逻辑错误、潜在 bug、类型/编译错误、安全与性能隐患等

**范围强约束** —— 评审仅限**当前本轮修改内容**,避免扩大范围;本轮改动范围内确认的问题才直接修复,范围外的历史遗留/无关问题只记录提示、不动手改。

**评审模型选择**(每次 `/third-review` 都会弹出选择界面):

- `/third-review` → 弹出 **`/model` 同款选择器**(限高滚动 + 模糊搜索):**默认选中当前配置的模型**(✓ 标记),直接**回车**即用它开始评审
- **换选其他模型** → 立即写回配置(**落盘 + 内存**),**下次默认使用该模型**
- **取消**(Esc)→ 不执行评审,配置不变
- 配置持久化于 `<agent-dir>/pi-toolkits-review.json`(默认 `~/.pi/agent/`):

```json
{ "model": "anthropic/claude-sonnet-4" }
```

- `/review-model` —— 单独的配置入口:弹出同一列表(不改会话模型,只更新默认配置)
- **未配置 / 配置的模型已不可用**(如在 pi 的 models.json 里删掉了该模型)→ 提示后照常弹出列表(此时无默认项)
- 任务仍在进行中(agent 未空闲)时触发 → 提示等待,不执行;同一时间只允许一个评审
- footer 出现灰色 `review` 状态 = 已配置评审模型

---

## 🗜️ compact — 独立压缩模型

<a name="compact"></a>

pi 的 `/compact` 与 auto-compact 默认**用当前会话模型**做上下文总结——主模型往往贵且慢,而压缩总结是典型的「便宜快模型就能干好」的任务。本功能配置一个独立模型接管**全部三种压缩触发**的总结:

| 触发 | 接管后 |
| --- | --- |
| 手动 `/compact [instructions]` | 压缩模型总结,自定义 focus 照常注入 |
| auto-compact 阈值触发 | 压缩模型总结 |
| context overflow 恢复 | 压缩模型总结,重试行为不变 |

**接管后与 pi 内建行为完全一致的部分**(逐字同步 pi 内建实现,复制自 0.87.1、在 1.1.0 → 1.4.0 内字节级不变 —— 除了此处采纳的两项 1.4.0 修正:摘要请求使用模型自身的输出上限而非 `reserveTokens` 的固定比例,以及 `/compact <instructions>` 也会进入 split-turn 前缀;只换执行模型;对话序列化函数(`serializeConversation`)是直接从宿主导入的,因此跟随宿主行为 —— 例如 1.2.0 起不再把 assistant thinking 回填进摘要请求):

- **摘要格式** —— Goal / Progress / Key Decisions 结构化 checkpoint;已有摘要时用迭代更新版 prompt,信息延续不丢
- **切分行为** —— 保留最近 `keepRecentTokens` 的策略、`firstKeptEntryId` / `tokensBefore` 原样回传,不动
- **输出预算** —— 摘要请求使用模型自身的输出上限,与 1.4.0 起的内建一致(#9512:过去按 0.8×/0.5× `reserveTokens` 设上限,长思考会把摘要顶到 "generation hit the token cap" 而失败);`reserveTokens` 只决定何时开始压缩
- **文件清单尾部** —— `<read-files>` / `<modified-files>` 标签照常拼在摘要尾部,details 同形状维护
- **用量统计** —— 压缩模型的 token/cost 计入 session 统计
- **可取消** —— 压缩进行中 `Esc` 干净取消(信号透传到底层调用)

**配置**(`<agent-dir>/pi-toolkits-compact.json`,默认 `~/.pi/agent/`):

```json
{ "model": "google/gemini-2.5-flash" }
```

- `/compact-model` —— 查看/更换:`/model` 同款选择器(限高滚动 + 模糊搜索),**默认选中当前配置的模型**,回车即确认;换选即写入;取消则不变(清除配置:编辑 `pi-toolkits-compact.json` 把 `model` 置为 `null`)
- 未配置 = 功能未启用,全部走 pi 默认,零开销;footer 出现灰色 `compact` 状态 = 已配置

**无损回落**(本功能永远不会把压缩「做挂」):

| 情形 | 行为 |
| --- | --- |
| 未配置 | 直接回落 pi 默认压缩 |
| 配置的模型不可用(如从 models.json 删除) | warning 提示 + 回落 |
| 总结失败 / 摘要为空 / 命中 token 上限 | 提示 + 回落 pi 默认压缩 |
| 用户取消(`Esc`) | 干净取消,无错误刷屏 |

> **实现说明**:接管点是官方的 `session_before_compact` 扩展事件(三种触发都会先经过);返回压缩结果即完全接管,返回 `undefined` 即回落内建。auto-compact 路径绝不弹任何对话框(handler 内只 notify)。`/tree` 分支总结(`session_before_tree`)是另一个事件,本期不接管,留作后续迭代。

---

## 🚀 autostart — 会话启动自动化

<a name="autostart"></a>

多仓库项目的第一步:在项目内声明「开新会话时要自动执行的斜杠命令」,首批用例是 `/add-dir` 挂载兄弟仓库——新会话无需手动重放。

**配置**(`<项目根>/.pi/autostart.toml`,随项目进 git;`.pi/` 是 pi 的项目级配置惯例,先例 `.pi/mcp.json`):

```toml
version = 1

[command]
run = [
  "/add-dir ../shop-frontend",
  "/add-dir ../shop-api",
]
```

无文件 = 功能未启用,零开销、静默跳过。

**两个来源,按序执行,不做合并**:

| 来源 | 路径 | project trust |
| --- | --- | --- |
| 全局(操作者默认) | `<agent-dir>/autostart.toml`(默认 `~/.pi/agent/autostart.toml`) | 不需要 —— 文件属于操作者本人 |
| 项目 | `<项目根>/.pi/autostart.toml` | 需要 |

全局列表先执行,项目列表后执行,因此项目可以覆盖此前的设置(例如后面再执行一条不同参数的 `/ask-perm`)。只有希望所有项目都用同一套命令时才用全局文件;仍然建议以项目级配置为主。

**完全相同的命令行**若同时出现在两个来源,一次重放里只执行一次:重复项跳过,所以把全局的 `/ask-perm ...` 复制到项目里不会再跑一遍、也不会再提示一遍。不同的命令仍然各跑一次——这正是「项目覆盖全局」得以成立的原因。

**执行时机**:

| session_start reason | 是否重放 | 原因 |
| --- | --- | --- |
| `startup` / `new`,空会话 | ✅ | 新会话,按声明重放 |
| `startup`,但会话已有历史 | ❌ | 这是「进程启动即带着旧会话」(`pi -c` / `-r` / `--session` / `--fork`),其分支已携带重放本该重建的状态 |
| `fork`(进程内) | ✅ | 分支点可能早于配置出现 |
| `resume`(进程内 `/resume`) | ❌ | 恢复的分支已携带当时的挂载状态,重放反而会冲突 |
| `reload` | ❌ | 扩展重建,重放会重复副作用 |

> `startup` 这一行为什么要拆开:pi 对**每一次进程启动**都报 `startup`,包括「启动即打开旧会话」的情形;`resume` 只在进程内切换会话时发出,`pi -c` 永远不会报它。所以前两行的判定依据是**会话内容**(是否已有消息),不能只看 reason。

**安全门**(按序):

1. **project trust** —— 未信任目录不自动执行任何命令(warning 提示);配置解析失败同样不执行(error 提示)
2. **命令预校验** —— 只执行「扩展注册的命令」;未注册的命令名**跳过并警告**,绝不发给模型(sendUserMessage 对未处理的 `/x` 会当作普通消息发给 LLM,这是必须预校验的原因)

**关键约束:只支持扩展命令**。`/add-dir`(pi-add-dir)、`/cd`(pi-cd)等 `registerCommand` 注册的命令可以;内置命令(`/compact`、`/reload`、`/resume`…)在 TUI 层分发,扩展层触发不了;skill 命令(`/skill:name`)是展开机制而非执行机制。依赖的目标扩展(如 pi-add-dir)需要先安装。

> **实现说明**:执行用 `sendUserMessage(cmd, { expandPromptTemplates: true })` —— 该选项把 `/cmd args` 路由到命令分发而不是模型 prompt 路径(包装层默认 `false`,`sendUserMessage` 与 `_tryExecuteExtensionCommand` 在 1.1.0–1.4.0 全区间字节级一致,见 AGENTS.md 宿主兼容纪律)。预校验用 `pi.getCommands()`(只认 `source: "extension"`)。依赖 `smol-toml`(零依赖、~10KB、TOML 1.0)。

---

## 🧠 init — agent 记忆框架

<a name="init"></a>

`/ask-init` 给项目安装一套有明确立场的记忆结构,或者接管项目里已经存在的文档。
重点不是目录名,而是把三样混在一起必然腐烂的东西分开:

| 家庭 | 位置 | 回答什么 | 生命周期 |
| --- | --- | --- | --- |
| **计划** | `specs/`(`PLAN.md` + `<unit>.md`) | 要做什么、怎么验收 | 开工前写,结项时更新状态 |
| **记忆** | `.agents/memory/` | 已知什么、定过什么、为什么 | 长期;只追加、只压缩 |
| **证据** | `.agents/implementations/` | 改了什么、什么时候、证据在哪 | 一次写定,不再改写 |

只有「纯给 agent 看」的东西进隐藏目录 `.agents/`,所以仓库根仍然清爽:
`AGENTS.md`、`specs/`、`design/`、`docs/`、`legal/` 都留在外面可读可审。

**命令**:

| 命令 | 作用 |
| --- | --- |
| `/ask-init` | 检测 → 出计划 → 确认 → 移动/脚手架/快照 → 把正文工作派发给模型 |
| `/ask-init plan [--deep]` | 只打印计划,不写任何盘(`--dry-run` 同义) |
| `/ask-init check` | 审计已装的框架(只读;只在 `.agents/framework/reports/` 留下运行期报告) |
| `/ask-init roots` | 把 `pi-add-dir` 添加的目录同步进框架状态 |
| `/ask-init --yes` | 跳过确认面板 |
| `/ask-init --lang zh\|en` | 生成正文的语言(默认按项目自身文档判定) |

**机械那一半保证什么**:

1. **先快照再动** —— 本次可能写的每一条路径(包括所有会被改写的引用文件)都复制到
   `.agents/framework/snapshots/<stamp>/`,并带 sha256 清单与当时的 `git status`。
2. **只写仓内** —— 扩展代码绝不写 added root;在那里建 scope card 是普通工具调用,
   因此会经过权限闸门。
3. **不覆盖** —— 创建时已存在的文件跳过;移动时目标非空则拒绝,并转成人工任务。
4. **计数对账** —— 引用改写与检测用同一个「裸路径」判定,计划里的「N 处 / M 个文件」
   就是运行时报告的数字(并附逐文件清单)。
5. **不静默丢内容** —— 迁移的每个源章节在覆盖表里都有一行:命中、声明去向、或标记
   OPEN 并写理由;只要还有 OPEN,审计就不算通过。

正文那一半是一份带验收标准的工作单:填空入口、合并旧计划、把 `todos/` 收敛进 specs、
去重章节、登记预算债务、填覆盖表。模型用只在本轮激活的 `framework_audit` 工具自检收口。

**迁移既有项目**会把 `memory/`、`implementations/`、`prompts/` 移到 `.agents/` 下
(逐个 `git mv`),把 `memory/PLAN.md` 原样搬到 `specs/PLAN.md`,再改写路径引用,
前后计数都会报出来。`todos/` 退役:需求原文原样进对应单元的 spec。默认是**保守 pass**:
装框架、修机械漂移(墓碑、重复章节、附录顺序),超预算的 `AGENTS.md` 只登记成债务;
`--deep` 才允许结构性改写。

**审计码**(稳定,可跨次对比):`E-PATH-01` 裸旧路径、`E-STATE-01` 记忆被 gitignore、`W-STATE-01` 记忆尚未提交、`E-INDEX-01` 索引与实际文件不一致、`E-LINK-01` 内部链接失效、
`W-BUDGET-01` `AGENTS.md` 超预算、`W-DUP-01` 同一章节出现在两个文件、
`W-ORDER-01` 附录之后又追加章节、`W-COV-01` 覆盖表仍有 OPEN、
`W-TODO-01` 仍存在退役的 `todos/`、`W-ROOT-02` 根下零字节文件、
`W-SCAFFOLD-01` 未填的 `TODO(ask-init)` 标记、`I-INSTALL-01` 尚未安装框架。

**多仓库工作区**:记忆只住主仓。`pi-add-dir` 会把每个 added root 的 `AGENTS.md`
全文注入每次请求,所以根里的入口只能是 **scope card**(≤30 行:这里放什么、它的命令、
去主仓哪个记忆文件读),绝不能是规则的第二份副本。

装进项目的框架契约用英文(给模型读、也随 npm 发布);写进项目的正文跟随项目语言。

> **跑完记得 `/reload`**,让新的 `AGENTS.md` 进入提示词。框架版本记在
> `.agents/framework/state.toml`;若项目的状态版本比当前工具新,则拒绝迁移。

---

## 🛠️ 开发

<a name="development"></a>

**pnpm 是本仓库唯一受支持的包管理器** —— 本仓库内不得使用 `npm install` / `npm publish`。

```bash
pnpm install      # 安装依赖
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest(全部功能单元测试)

pnpm check:keybindings   # 用宿主自己的分发表审计本插件的按键
pnpm check:compat        # 校验声明的 pi 下限:强制 4 条线窗口 + 向后 4 条线探针 → public floor
pnpm approval-report     # 汇总本地审批日志(答复分布、目标目录、候选规则)
```

### 项目结构

```text
src/
├── index.ts              # 入口:聚合各功能模块
├── lib/                  # 共享基础设施(工具集快照/恢复、
│                         # 组合 tool_call 策略的闸门总线、
│                         # 边界闸门会查询的自封闭工具登记表、
│                         # 滚动 JSONL 审批日志、
│                         # review 与 compact 共用的模型 key 解析)
└── features/             # 功能模块 —— 一个功能一个目录
    ├── ask/              # ask 模式:命令 + 状态机、bash 沙箱、
    │                     #           草稿空间(临时目录 + scratchpad 工具)、
    │                     #           系统提示词横幅、测试
    ├── autostart/        # 会话启动自动化:autostart.toml 解析、
    │                     #           命令预校验 + 重放、测试
    ├── compact/          # 独立压缩模型:session_before_compact 接管 +
    │                     #           /compact-model、配置存储、prompt、测试
    ├── favorites/        # 模型收藏:选择器与循环 patch、
    │                     #           持久化存储、测试
    ├── permission/       # 会话级边界权限:模式、面板、bash 拆解、
    │                     #           策略、会话授权、确认对话框、
    │                     #           审计 payload、测试
    ├── review/           # 第三方评审:输入/指令触发、
    │                     #           评审模型配置存储、提示词、测试
    └── stash/            # 提示词暂存:热键状态机 + 测试
```

**新增功能**:新建 `src/features/<name>/`,导出 `registerXxx(pi)`,在 `src/index.ts` 中调用;已有模块保持不变。每个功能自带 `*.test.ts`(vitest)——保持确定性(时钟/状态可注入,不写真实 agent-dir)。

**发布**(仅 pnpm 一条命令):

```bash
pnpm release patch   # 0.1.2 → 0.1.3
pnpm release minor   # 0.1.2 → 0.2.0   (patch 清零)
pnpm release major   # 0.1.2 → 1.0.0   (minor + patch 清零)
pnpm release patch --dry-run   # 预览,不做任何改动
pnpm release:github            # 为当前版本创建/校验 GitHub Release(幂等)
pnpm release:github --audit    # 列出 npm 版本 vs GitHub Release vs 远端 tag
```

`release` 要求且仅要求 `major | minor | patch` 之一;上级递增清零下级。执行链:**工作区必须干净(有未提交变更直接中止,保证 tag 内容 == 发布内容)** → `typecheck + test` 门禁 → 改版本 → git commit + `vX.Y.Z` tag(自检 tag==HEAD 且工作区干净) → `pnpm publish`(`prepublishOnly` 二次门禁) → 推当前分支 → tag 远端没有就推、有就校验哈希一致(带有限次重试——刚推完 GitHub 的 ref 可见性可能滞后)→ 创建 GitHub Release。

若最后一步被跳过(无 `GITHUB_TOKEN`、push 失败、HTTP 报错),该版本会永远没有 Release:下一版自动生成的 release notes 是**对着上一个已发布的 Release** 算 diff 的,于是缺的那版提交被吞进下一版,GitHub 的版本线就与 npm 对不上。`pnpm release:github` 就是补建/续跑入口——不动版本号、不碰 npm;`--audit` 是差集探测器(`--allow-gaps` 把历史缺口降级为警告)。

---

## 🤝 贡献

<a name="contributing"></a>

欢迎提交 PR 与 issue。几条约定:

- **只用 pnpm** —— 不得 `npm install` / `npm publish`;用 `pnpm add` / `pnpm publish`
- **功能模块模式** —— 一个功能一个目录(`src/features/<name>/`),导出 `registerXxx(pi)`,在 `src/index.ts` 注册;共享基础设施放 `src/lib/`
- **测试** —— 每个功能自带 vitest 用例;保持确定性(时钟/状态可注入),不写真实 agent dir
- **内建 patch**(favorites)必须保持**版本守卫 + 幂等** —— 打 patch 前先确认目标原型成员存在,防止重复应用,失败时用 `console.warn` 降级而不是把扩展搞挂
- **内建提示词同步**(compact) —— `src/features/compact/prompt.ts` 里的总结 prompt 逐字抄自 pi 内建压缩;升级 pi 依赖时 diff `dist/core/compaction/compaction.js`(及 `utils.js`),同步字符串与组装辅助函数,保持接管输出与内建字节级一致
- **键位** —— 定新快捷键前先查 pi 默认键位 + 保留键、终端控制字符、OS/终端模拟器占用;跨平台安全优先选 `ctrl+alt+<字母>`。**不得只验证「主屏下我这台机器能用」**:自 pi 1.0 起默认 `fullscreen`,alt-screen 层在对话框看到按键**之前**就消费 `tui.altScreen.*`,且 Windows/WSL 上多个绑定与 Linux 默认值不同。用 `pnpm check:keybindings [候选键...]` 核查(pi 升级后跑 `pnpm check:keybindings --all`),它用宿主自己的 `matchesKey` 探测已安装宿主的**已解析**键位表。**宿主表空闲 ≠ 机器层空闲**:Windows Terminal 默认占 `ctrl+v`(粘贴)与 `ctrl+shift+f`(查找),第三方 Windows 工具常绑 `ctrl+alt+<字母>`(截图工具占过 `ctrl+alt+f`)——定键后必须在真机试按,确认按键真的到得了应用。
- **宿主兼容** —— peer 区间是实测结论而非愿望,而且只往回指:最近 4 个已发布中版本线是**强制窗口**(不兼容就改我们的代码,绝不抬下限),窗口之下再向后探最多 4 条线找出兼容实际停在哪里,对使用者只展示一个数:由此得到的**下限**(`pi >= <floor>`,无上界)。宿主依赖一动就重跑 `pnpm check:compat`,读它的 verdict 段(声明下限与实测不一致会直接判失败)。详见 AGENTS.md「pi 宿主兼容」;升级中发现的键位冲突**上报崔总决策**,不得顺手换键。
- **质量门禁** —— 提交前必须通过 `pnpm typecheck && pnpm test`

---

## 📄 许可

<a name="license"></a>

MIT © 2026 Andares Cui. 见 [LICENSE](LICENSE)。
