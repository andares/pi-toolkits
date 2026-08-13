/**
 * review feature — third-party review prompt.
 *
 * The review model keeps FULL tool access: this is "check AND fix", not a
 * read-only audit (confirmed with the user). The prompt is sent as a user
 * message via pi.sendUserMessage(), so the review turn — including any fixes
 * it makes — stays in the current session transcript right next to the work
 * under review.
 *
 * The three focus points the user asked for (本轮需求实现 / 是否有遗漏 /
 * 是否有错误) are spelled out verbatim in the prompt, together with a hard
 * scope constraint: the review must stay within this round's changes.
 */

export const REVIEW_PROMPT = `请以第三方代码评审的身份，对本次会话中刚完成的开发任务进行 Review。

本轮需求、开发过程和代码改动都在当前会话上下文中，请结合上下文，并用 read/grep 等工具实际检查仓库代码，不要凭空猜测。

请重点检查以下三点（逐项给出结论）：
1. 本轮需求实现：本轮需求是否已完整、正确地实现？实现与需求描述是否一致？
2. 是否有遗漏：需求中是否有遗漏的功能点、边界情况、异常处理、兼容性、测试等？
3. 是否有错误：代码中是否存在逻辑错误、潜在 bug、类型/编译错误、安全与性能隐患等？

范围强约束：
- 本次 Review 仅限当前本轮修改内容（本轮需求对应的代码改动），避免扩大范围；
- 本轮改动范围内确认的问题才直接修复；范围外的问题（历史遗留、无关代码）只记录提示，不要动手修改。

要求：
- 对确认的问题直接修复（write/edit），并简要说明改了什么、为什么改；
- 无法确认或不宜直接改的问题，列出：位置（文件/行）、问题描述、建议方案；
- 最后输出评审报告：发现问题清单（已修复 / 未修复）、修复说明、总体结论（通过 / 需修改）与剩余风险。`;
