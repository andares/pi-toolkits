/**
 * Bilingual UI. Chinese and English only — the operator reads the review, the
 * model never sees this text (the feedback markdown is built server-side), so
 * this file is the one place where Chinese is a first-class output.
 *
 * The choice is remembered in localStorage: a review is a short-lived page but
 * it is reopened several times per spec, and re-picking the language each time
 * is friction without a benefit.
 *
 * This is display-only. The choice never reaches the server, the feedback
 * markdown, or the spec on disk: those are model-facing / on-disk artifacts and
 * must not follow the operator's display preference.
 */
export type Lang = "en" | "zh";

const STORAGE_KEY = "spec:lang";
const LEGACY_STORAGE_KEY = "plan:lang";

export function initialLang(): Lang {
	const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
	if (stored === "en" || stored === "zh") return stored;
	return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function rememberLang(lang: Lang): void {
	localStorage.setItem(STORAGE_KEY, lang);
}

const en = {
	title: "Spec review",
	version: "v{version} of {total}",
	changed: "{count} blocks changed",
	changedOne: "1 block changed",
	noChange: "no changes",
	showAll: "Show unchanged",
	onlyChanged: "Only changed",
	approve: "Approve spec",
	deny: "Send feedback",
	globalNotes: "Global notes",
	globalNotesTitle: "Global notes",
	notePlaceholder: "What should change here?",
	addNote: "Add note",
	save: "Save note",
	cancel: "Cancel",
	remove: "Remove",
	verdictChange: "must change",
	verdictSuggest: "suggest",
	verdictQuestion: "question",
	history: "History",
	historySummary: "{count} blocks",
	historySummaryOne: "1 block",
	back: "Back to latest",
	viewingOld: "Read-only: you are viewing v{v}",
	readOnly: "Read-only",
	approved: "Spec approved",
	denied: "Feedback sent",
	closing: "Closing this tab…",
	closeHint: "You can close this tab now.",
	closePage: "Close",
	closePageHint: "Close this page without sending anything to the agent",
	closePageConfirm: "Close this page and stop its review server? Nothing will be sent to the agent.",
	closePageDone: "Page closed",
	closePageServerClosed: "The review server is closed. Nothing was sent to the agent.",
	closePageUnreachable: "The review server could not be reached. Nothing was sent to the agent.",
	status_unchanged: "unchanged",
	status_moved: "moved",
	status_modified: "modified",
	status_added: "new",
	status_removed: "removed",
	unchangedHidden: "{count} unchanged blocks hidden",
	unchangedHiddenOne: "1 unchanged block hidden",
	error: "Something went wrong: {message}",
	emptySpec: "This spec is empty.",
	noteCount: "{count} notes",
	noteCountOne: "1 note",
	thisRevision: "This revision",
	blocksChanged: "blocks changed",
	ofTotal: "of {total} in the spec",
	annotations: "Annotations",
	noNotesYet: "No notes yet — annotate a block to see it here.",
	talkTitle: "Reply notes",
	talkUntitled: "Untitled session",
	talkBlocks: "{count} blocks",
	talkBlocksOne: "1 block",
	talkSentBadge: "sent",
	talkSentTitle: "Sent back to pi",
	talkNothingToSend: "Write a note or a message first.",
	talkNotePlaceholder: "What do you want to say about this part?",
	editNote: "Edit note",
	yourNote: "your note",
	talkAbout: "This reply",
	talkAboutBody: "Saved notes and your draft survive a refresh. Continue also includes the open editor, sends once and closes the page.",
	talkBlocksLabel: "blocks",
	talkChars: "characters",
	talkPlaceholder: "Anything else for the agent…",
	talkSubmitHint: "Send with Cmd/Ctrl+Enter",
	talkContinue: "Continue",
};

const zh: typeof en = {
	title: "规格评审",
	version: "第 {version} / {total} 版",
	changed: "{count} 处改动",
	changedOne: "1 处改动",
	noChange: "无改动",
	showAll: "显示未变块",
	onlyChanged: "只看改动",
	approve: "批准规格",
	deny: "提交意见",
	globalNotes: "全局批注",
	globalNotesTitle: "全局批注",
	notePlaceholder: "这里应该怎么改？",
	addNote: "添加批注",
	save: "保存批注",
	cancel: "取消",
	remove: "删除",
	verdictChange: "必须改",
	verdictSuggest: "建议",
	verdictQuestion: "疑问",
	history: "历史",
	historySummary: "{count} 块",
	historySummaryOne: "1 块",
	back: "回到最新版",
	viewingOld: "只读：正在查看第 {v} 版",
	readOnly: "只读",
	approved: "规格已批准",
	denied: "意见已提交",
	closing: "正在关闭标签页…",
	closeHint: "现在可以关闭这个标签页了。",
	closePage: "关闭",
	closePageHint: "关闭此页面，不向 agent 发送任何信息",
	closePageConfirm: "关闭此页面并停止它的评审服务吗？不会向 agent 发送任何信息。",
	closePageDone: "页面已关闭",
	closePageServerClosed: "评审服务已关闭，没有向 agent 发送任何信息。",
	closePageUnreachable: "无法连接评审服务；没有向 agent 发送任何信息。",
	status_unchanged: "未变",
	status_moved: "位置移动",
	status_modified: "已修改",
	status_added: "新增",
	status_removed: "已删除",
	unchangedHidden: "隐藏了 {count} 个未变块",
	unchangedHiddenOne: "隐藏了 1 个未变块",
	error: "出错了：{message}",
	emptySpec: "spec 是空的。",
	noteCount: "{count} 条批注",
	noteCountOne: "1 条批注",
	thisRevision: "本版",
	blocksChanged: "处改动",
	ofTotal: "共 {total} 块",
	annotations: "批注",
	noNotesYet: "还没有批注——在段落上写一条就会出现在这里。",
	talkTitle: "回复批注",
	talkUntitled: "未命名会话",
	talkBlocks: "{count} 块",
	talkBlocksOne: "1 块",
	talkSentBadge: "已发送",
	talkSentTitle: "已发回 pi",
	talkNothingToSend: "先写一条批注或一句话。",
	talkNotePlaceholder: "这一块你想说什么？",
	editNote: "改批注",
	yourNote: "你的批注",
	talkAbout: "这条回复",
	talkAboutBody: "已存批注与输入框草稿刷新后仍在；Continue 也会带上正在编辑的批注，只发一次，然后关页面。",
	talkBlocksLabel: "块",
	talkChars: "字符",
	talkPlaceholder: "还想对 agent 说什么…",
	talkSubmitHint: "Cmd/Ctrl+Enter 发送",
	talkContinue: "继续",
};

export type MessageKey = keyof typeof en;

const dictionaries: Record<Lang, typeof en> = { en, zh };

export function translate(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
	const template = dictionaries[lang][key] ?? key;
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
