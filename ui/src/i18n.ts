/**
 * Bilingual UI. Chinese and English only — the operator reads the review, the
 * model never sees this text (the feedback markdown is built server-side), so
 * this file is the one place where Chinese is a first-class output.
 *
 * The choice is remembered in localStorage: a review is a short-lived page but
 * it is reopened several times per plan, and re-picking the language each time
 * is friction without a benefit.
 */
export type Lang = "en" | "zh";

const STORAGE_KEY = "plan:lang";

export function initialLang(): Lang {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === "en" || stored === "zh") return stored;
	return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function rememberLang(lang: Lang): void {
	localStorage.setItem(STORAGE_KEY, lang);
}

const en = {
	title: "Plan review",
	version: "v{version} of {total}",
	changed: "{count} changed",
	noChange: "no changes",
	expanded: "collapsed unchanged",
	showAll: "show unchanged",
	onlyChanged: "only changed",
	approve: "Approve",
	deny: "Send feedback",
	globalNotes: "Global notes",
	notePlaceholder: "What should change here?",
	addNote: "Add note",
	save: "Save",
	cancel: "Cancel",
	remove: "Remove",
	verdictChange: "must change",
	verdictSuggest: "suggest",
	verdictQuestion: "question",
	history: "History",
	back: "Back to latest",
	viewingOld: "Read-only: you are viewing v{v}",
	readOnly: "Read-only",
	approved: "Approved",
	denied: "Feedback sent",
	closing: "Closing this tab…",
	closeHint: "You can close this tab now.",
	waiting: "Waiting for the agent…",
	status_unchanged: "unchanged",
	status_moved: "moved",
	status_modified: "modified",
	status_added: "new",
	status_removed: "removed",
	unchangedHidden: "{count} unchanged blocks hidden",
	error: "Something went wrong: {message}",
	emptyPlan: "This plan is empty.",
	notesHint: "Notes are sent with either decision — approve just means “start implementing”.",
	noteCount: "{count} notes",
};

const zh: typeof en = {
	title: "计划评审",
	version: "第 {version} / {total} 版",
	changed: "{count} 处改动",
	noChange: "无改动",
	expanded: "已折叠未变块",
	showAll: "显示未变块",
	onlyChanged: "只看改动",
	approve: "批准",
	deny: "提交意见",
	globalNotes: "全局批注",
	notePlaceholder: "这里应该怎么改？",
	addNote: "添加批注",
	save: "保存",
	cancel: "取消",
	remove: "删除",
	verdictChange: "必须改",
	verdictSuggest: "建议",
	verdictQuestion: "疑问",
	history: "历史",
	back: "回到最新版",
	viewingOld: "只读：正在查看第 {v} 版",
	readOnly: "只读",
	approved: "已批准",
	denied: "意见已提交",
	closing: "正在关闭标签页…",
	closeHint: "现在可以关闭这个标签页了。",
	waiting: "等待模型继续…",
	status_unchanged: "未变",
	status_moved: "位置移动",
	status_modified: "已修改",
	status_added: "新增",
	status_removed: "已删除",
	unchangedHidden: "隐藏了 {count} 个未变块",
	error: "出错了：{message}",
	emptyPlan: "计划是空的。",
	notesHint: "批注无论批准还是提意见都会送达；批准只是让模型开始实施。",
	noteCount: "{count} 条批注",
};

export type MessageKey = keyof typeof en;

const dictionaries: Record<Lang, typeof en> = { en, zh };

export function translate(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
	const template = dictionaries[lang][key] ?? key;
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
