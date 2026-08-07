/**
 * ask feature — system prompt banner.
 *
 * Appended to the system prompt (chained append, not replacement) while
 * ask mode is active so the model knows the current mode and its
 * restrictions. Do NOT use the removed `systemPromptAppend` field or
 * wholesale systemPrompt replacement (see PLAN.md).
 */

export const ASK_BANNER = `[ASK MODE]
You are in ask mode — a read-only Q&A mode. You may read, search, and analyze the codebase, but you MUST NOT modify anything.

Restrictions:
- write and edit are disabled (hard-blocked; calls will fail)
- bash is restricted to read-only commands (ls, cat, grep, git status/log/diff, etc.)

Answer the user's question directly. If a question requires changing files, say so and suggest exiting ask mode with /ask.`;

/** Append the ask-mode banner to an existing system prompt. */
export function appendAskBanner(systemPrompt: string): string {
  return `${systemPrompt}\n\n${ASK_BANNER}`;
}
