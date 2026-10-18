# PLAN: @andares/pi-toolkits — 会话级边界权限 `/ask-perm`

## Context

**为什么做**:现有第三方 `@gotgenes/pi-permission-system` 把「命令 × 规则 pattern」当作决策主键,
于是必然面对一个无限维度的矩阵:用户可以配得极细,但**会话中不可控**,面对 agent 的组合式调用
(管道、`&&`、`xargs`、子 shell)只能靠 glob 匹配整串命令;`yoloMode` 又落全局盘,
开一次忘了关,此后所有新会话的 ask 全部被吞。结果是:该拦的拦不住、不该拦的拦一堆、
想放开就得赌自己不会忘。

**做法**:换主键。用**「边界(项目内/外)× 操作性质(读/写,exec 折进写)」**四格 + **会话级例外表**:

- 四格有限、可解释、可默认 —— 大部分场景两次切换就够
- 例外交给会话授权(`a/s/d/f`),不落到配置文件
- 一切状态**只在内存**:默认关闭、不落盘、关闭即清空
- 持久化的需求用 autostart 满足(想默认开就写一条命令)

**反馈来源**:VSCode 的三档模式(ask/plan/agent)每档都有各自权限控制的思路,
但 VSCode 用复杂逻辑把细节抹平了;这里做不到那么细,所以只保留四个可解释的旋钮。

## 需求(崔总定稿)

| # | 需求 | 落点 |
| --- | --- | --- |
| 1 | 状态完全不落盘、默认不开 | `index.ts` 闭包状态 + `session_start` 重置 |
| 2 | `/ask-perm` 显示模式面板,光标默认最上,顶行回车即开启 | `panel.ts`(SettingsList + Enter 包装) |
| 3 | 光标下移四行:项目内读 / 项目内写(含 exec) / 项目外读 / 项目外写(含 exec) | `panel.ts` + `constants.ts` |
| 4 | 项目内切 `ask\|allow`,项目外切 `ask\|allow\|deny` | `modes.ts` 的值域 + `constants.ts` |
| 5 | 默认:项目内读/写 allow,项目外读 allow、写 ask | `DEFAULT_MODES` |
| 6 | 再输入一次关闭;开关都提示 | `index.ts` notify |
| 7 | 带 4 个参数直接开启、不弹窗;缺省回落默认值 | `modes.ts#parsePermissionArgs` |
| 8 | 读写判定:写 = 明确写盘/操作/执行,读 = 不产生变化;重点误操作要能识别 | `units.ts` 词表 + 选项守卫 + `constants.ts` 破坏性表 |
| 9 | 复合指令拆解(管道/`&&`/`;`/`xargs`…),按拆出的单位判定 | `units.ts` |
| 10 | 执行位置与目标目录双重判定,任一撞 ask/deny 都处理 | `units.ts` 的 `base` + `targets`,`policy.ts` 取最严格 |
| 11 | 判定不靠 AI | 纯代码(无模型调用) |
| 12 | 会话级 allow list 优先;deny list 直接禁;deny 要明确反馈模型 | `policy.ts` + `formatDenial` |
| 13 | ask 的四个选项 `a/s/d/f` | `prompt.ts` |
| 14 | 项目内要包含 add-dir 加入的仓外目录 | `paths.ts#readAddedDirectories` |
| 15 | 与 `/ask` **并行不冲突** | `src/lib/gates.ts` 闸门总线 |
| 16 | 所有提示与界面文字用英文 | panel/prompt/notify/banner/reason 全英文 |

## 架构

```text
src/lib/gates.ts                    # 闸门总线(跨特性组合 + 对话框串行队列)
src/features/permission/
├── index.ts            # /ask-perm 命令、状态机、gate 注册、footer、系统提示横幅
├── constants.ts        # DEFAULT_MODES + 凭据表 + 破坏性表
├── modes.ts            # 参数解析、格式化
├── panel.ts            # SettingsList + 回车即应用
├── prompt.ts           # SelectList + a/s/d/f
├── paths.ts            # ~ 展开 / realpath / 包含 / add-dir
├── session-rules.ts    # 内存会话授权
├── units.ts            # bash → CommandUnit[]
└── policy.ts           # decideProgram(units) → allow | ask | deny
```

判定顺序:`凭据表(deny) > 会话授权(deny > allow) > 破坏性表(ask) > 四格模式`。

## 攻关点与结论

### 1. 读/写判定

三层:语法层(重定向运算符表)> 命令表层(`READ_COMMANDS` / `WRITE_COMMANDS` / git 与包管理器的
verb 白名单)> 选项守卫(`sed -i`、`sort -o`、`find -delete`、`fd -x`、`curl -o`、`wget -O file`、
`git diff --output`、`-o/--output` 通用规则)。
**未知命令一律按写**。参考实现:`pi-permission-system` 的 `access-intent/bash/command-effects.ts`
(词表思路),但不搬它的 8000 行解析机械。

### 2. 复合指令拆解

`shell-quote` tokenizer → 按分隔符(`&&`/`||`/`;`/`&`/`|`/`|&`)切段 → 每段:
剥 `VAR=val` → 剥 wrapper(名单抄自 `wrapper-analysis.ts` 的 `INDIRECTION_WRAPPER_NAMES`)
→ shell payload 递归 → redirect 抽取 → 命令特定目标抽取 → 路径形状参数兜底。
**不上 tree-sitter**:原插件引 `web-tree-sitter` + bash wasm(4.5MB)换精确 AST,
目标是「常见重点误操作能看出来」,缺口用 `opaque → ask` 兜住。

**踩到的坑(评审阶段修正)**:`shell-quote` 对 `>` 给的是**输出位置**(`["ls",{op:">"},"out.txt"]`),
对 `<` 才是中缀位置——按「目标在 op 后一位」的统一假设处理会让 `echo a > /tmp/x` 被当成读。
现在 op 在 `segmentTokens` 里保留、由 `splitRedirects` 统一消费。

### 3. 执行位置与目标目录

- 执行目录:从 `ctx.cwd` 起按单位顺序折叠**字面量** `cd`;`git -C <dir>` 同样折叠成本次调用的
  局部 base(否则 `git -C ~/.ssh log` 会被当成项目内)。非字面量(`cd "$DIR"`、`cd -`、`cd ~user`)
  → 基址置 `unknown` → 该单位及后续相对命令按 opaque 处理。
- 目标路径:像路径的词(绝对、`~`、含分隔符、通配符)解析;写命令的裸文件名也算目标
  (`rm notes.txt`);存在路径走 realpath(防符号链接逃逸),不存在路径经最近存在祖先规范化。
- 通配符收缩到其展开所在目录(`rm -rf *` → cwd 本身),URL 不算路径。

### 4. 数据模型与判定

```ts
interface CommandUnit {
  raw, headWord, command, args,
  effect: "read" | "write",
  opaque: boolean,
  base: string | null,          // 执行目录, null = 不可解析
  targets: { path, effect, source }[],
  note?: string,
}
```

复合命令取**最严格**(`deny > ask > allow`),不做顺序短路 —— 否则
`cd safe && rm -rf /` 会靠第一段蒙混过关。

## Verification(已完成)

- `pnpm typecheck`
- `pnpm test` —— 17 文件 / 397 测试
- `pnpm check:compat` —— 1.0.0 / 1.0.1 / 1.0.2 / 1.0.3 / 1.0.4 / 1.1.0 / 1.2.0 / 1.3.0
  逐版本 install + typecheck + 397 测试 + 键位审计全绿
- 真实宿主冒烟:`pi -ne -e ./src/index.ts --provider deepseek --model deepseek-flash --tools '' 'Reply with exactly: OK'` → OK
- 覆盖的典型场景(单测):`rm -rf /`、`cd /tmp && rm x`、`$(…)` 内嵌、`sudo -u root rm`、
  `bash -c '…'`、`xargs`、`find -exec`、heredoc、重定向读写、`sed -i`、`git -C`、
  `~/.ssh` 读与写、`.env`、opaque 的 `cd "$DIR"`、会话授权重复不再问

## 已知边界(有意为之)

- 读命令的裸文件名参数不判定 → 把 `out-read` 调成 ask/deny 时,绝对路径以外的读目标不会被问
- 启发式非沙箱;进程替换 opaque;Windows Git-Bash 路径拼写只近似(实测目标 POSIX)
- PowerShell 不拆解,直接 ask
- 子代理会话有自己的状态,不继承父会话模式
