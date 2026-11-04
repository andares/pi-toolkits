/**
 * review feature — third-party review prompt.
 *
 * The review model keeps FULL tool access: this is "check AND fix", not a
 * read-only audit (confirmed with the user). The prompt is sent as a user
 * message via pi.sendUserMessage(), so the review turn — including any fixes
 * it makes — stays in the current session transcript right next to the work
 * under review.
 *
 * The three focus points the user asked for (requirement coverage / anything
 * missing / anything wrong — originally stated as 本轮需求实现 / 是否有遗漏 /
 * 是否有错误) are spelled out one by one in the prompt, together with a hard
 * scope constraint: the review must stay within this round's changes.
 *
 * The prompt is English because everything the model and the operator see at
 * runtime is English (TUI notices, tool text, prompts); keep it that way when
 * editing, and keep the three focus points and the scope rule intact.
 */

export const REVIEW_PROMPT = `Act as a third-party code reviewer and review the development task that was just completed in this session.

The requirement for this round, the development process and the code changes are all in the current session context. Use that context, and actually inspect the repository with tools such as read/grep — do not guess.

Focus on the following three points and give a conclusion for each:
1. Requirement coverage: was this round's requirement implemented completely and correctly? Does the implementation match the requirement as described?
2. Anything missing: are there requirement points, edge cases, error handling, compatibility concerns, or tests that were left out?
3. Anything wrong: are there logic errors, potential bugs, type/compile errors, or security and performance risks in the code?

Hard scope constraint:
- Review only this round's changes (the code changes that correspond to this round's requirement); do not widen the scope;
- Only fix problems confirmed inside this round's changes directly; for problems outside that scope (pre-existing issues, unrelated code) record them as notes — do not touch them.

Requirements:
- Fix confirmed problems directly (write/edit) and briefly state what you changed and why;
- For problems you cannot confirm or should not fix directly, list: location (file/line), description of the problem, and a suggested approach;
- Finish with a review report: the list of findings (fixed / not fixed), the fix notes, an overall verdict (pass / needs changes) and the remaining risks.`;
