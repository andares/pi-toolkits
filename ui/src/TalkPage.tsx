/**
 * `/ask-talk` view — one reply, annotated.
 *
 * Differences from the spec review are all in the chrome: no version chip, no
 * history, no diff rail, and the footer's decisions are replaced by a composer +
 * Continue. The blocks, the note cards and the outline are the same components,
 * because they are the same job.
 *
 * Notes are one-per-block. Saved notes and the composer draft survive a refresh;
 * Continue also collects the note currently open in its editor, then commits
 * once and closes the port.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import * as api from "./api";
import { initialLang, rememberLang, translate, type Lang, type MessageKey } from "./i18n";
import {
	BackToTop,
	ClosePageButton,
	Composer,
	ManualCloseNotice,
	Outline,
	preferredScrollBehavior,
	useFooterHeight,
} from "./shared";

const SAVE_DEBOUNCE_MS = 300;

export function TalkPage(props: { initial: api.TalkState }) {
	const [lang, setLang] = createSignal<Lang>(initialLang());
	const [state, setState] = createSignal<api.TalkState>(props.initial);
	const [notes, setNotes] = createSignal<Record<string, string>>(props.initial.notes);
	const [draft, setDraft] = createSignal(props.initial.draft);
	const [sent, setSent] = createSignal(props.initial.sent);
	const [submitting, setSubmitting] = createSignal(false);
	const [editing, setEditing] = createSignal<string>();
	const [noteDraft, setNoteDraft] = createSignal("");
	const [error, setError] = createSignal<string>();
	const [tabClosed, setTabClosed] = createSignal(false);
	/** undefined = open; true/false = manually closed, server reachable or not. */
	const [manualClose, setManualClose] = createSignal<boolean>();
	let stopEvents: (() => void) | undefined;

	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(lang(), key, vars);

	useFooterHeight();

	const items = createMemo(() => state().items);
	const locked = createMemo(() => sent() || submitting());
	const noteCount = createMemo(() => Object.values(notes()).filter((text) => text.trim() !== "").length);

	/** Note entries in document order, for the rail. */
	const noteEntries = createMemo(() =>
		items()
			.map((item) => ({ id: item.id, label: item.label, text: notes()[item.id] ?? "" }))
			.filter((entry) => entry.text.trim() !== ""),
	);

	const replyAt = createMemo(() => {
		const at = state().reply.at;
		const date = new Date(at);
		return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
	});

	/**
	 * The page's name is the session's name.
	 *
	 * Several talk pages can be open at once, one per parallel session; "the last
	 * reply" is the same phrase in all of them, so the window has to say which
	 * session it belongs to. The server sends the title; this only supplies the
	 * fallback for a session that has not been named yet.
	 */
	const pageTitle = createMemo(() => {
		const title = state().title?.trim();
		return title !== undefined && title !== "" ? title : t("talkUntitled");
	});

	async function reload() {
		// A refresh replaces the reply. A save still waiting out its debounce
		// belongs to the old snapshot: letting it fire after the new state arrives
		// writes the old draft (and any still-valid block notes) into the new reply.
		if (saveTimer !== undefined) {
			clearTimeout(saveTimer);
			saveTimer = undefined;
		}
		try {
			const next = await api.fetchState();
			if (next.mode !== "talk") return;
			setState(next);
			setNotes(next.notes);
			setDraft(next.draft);
			setSent(next.sent);
			// A refresh denotes a new snapshot. Do not let an editor from the old
			// reply leak its draft into the next Continue.
			setEditing(undefined);
			setNoteDraft("");
			setError(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	onMount(() => {
		stopEvents = api.subscribe({
			onRevision: () => void reload(),
			onAnnotations: () => void reload(),
			onDecided: () => undefined,
			onRefresh: () => void reload(),
			onSent: () => setSent(true),
		});
		onCleanup(() => {
			stopEvents?.();
			stopEvents = undefined;
			if (saveTimer !== undefined) clearTimeout(saveTimer);
		});
	});

	createEffect(() => {
		document.title = pageTitle();
	});

	function closedManually(serverClosed: boolean): void {
		stopEvents?.();
		stopEvents = undefined;
		// A debounced notes write after the closed state would only produce a
		// network error; more importantly, this path must never become Continue.
		if (saveTimer !== undefined) {
			clearTimeout(saveTimer);
			saveTimer = undefined;
		}
		setManualClose(serverClosed);
	}

	function scheduleSave(nextNotes: Record<string, string>, nextDraft: string) {
		if (saveTimer !== undefined) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = undefined;
			void api.postTalkNotes(nextNotes, nextDraft).catch((cause: unknown) => {
				// The port closes right after Continue; losing a late keystroke then is
				// expected, not an error worth shouting about.
				if (sent()) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		}, SAVE_DEBOUNCE_MS);
	}

	function writeNote(blockId: string, text: string) {
		const next = { ...notes() };
		if (text.trim() === "") delete next[blockId];
		else next[blockId] = text;
		setNotes(next);
		scheduleSave(next, draft());
	}

	function removeNote(blockId: string) {
		const next = { ...notes() };
		delete next[blockId];
		setNotes(next);
		if (editing() === blockId) setEditing(undefined);
		scheduleSave(next, draft());
	}

	function updateDraft(value: string) {
		setDraft(value);
		scheduleSave(notes(), value);
	}

	/** Include the note currently open in its editor, even without Save. */
	function notesForSubmit(): Record<string, string> {
		const next = { ...notes() };
		const blockId = editing();
		if (blockId !== undefined) {
			if (noteDraft().trim() === "") delete next[blockId];
			else next[blockId] = noteDraft();
		}
		return next;
	}

	async function submit() {
		if (locked()) return;
		const pendingNotes = notesForSubmit();
		const hasNotes = Object.values(pendingNotes).some((text) => text.trim() !== "");
		if (!hasNotes && draft().trim() === "") {
			setError(t("talkNothingToSend"));
			return;
		}
		setNotes(pendingNotes);
		if (saveTimer !== undefined) {
			clearTimeout(saveTimer);
			saveTimer = undefined;
		}
		setSubmitting(true);
		try {
			await api.postContinue(pendingNotes, draft());
			setSent(true);
			setSubmitting(false);
			setError(undefined);
			// A tab opened by an external launcher is not script-opened, so most
			// browsers refuse; the sent state is the real fallback, not this call.
			window.close();
			setTimeout(() => setTabClosed(true), 300);
		} catch (cause) {
			setSubmitting(false);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	function jumpToBlock(blockId: string) {
		requestAnimationFrame(() => {
			document
				.getElementById(`block-${blockId}`)
				?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "center" });
		});
	}

	return (
		<Show
			when={manualClose() === undefined}
			fallback={<ManualCloseNotice lang={lang()} serverClosed={manualClose() === true} />}
		>
		<div class="page">
			<header class="topbar">
				<div class="masthead">
					<div class="brand">
						<span class="brand-mark" aria-hidden="true">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
								<title>Reply notes</title>
								<path d="M4 5h16M4 11h16M4 17h9" />
							</svg>
						</span>
						<span class="eyebrow">{t("talkTitle")}</span>
					</div>
					<div class="top-actions">
						<button
							type="button"
							class="ghost lang"
							onClick={() => {
								const next: Lang = lang() === "en" ? "zh" : "en";
								setLang(next);
								rememberLang(next);
							}}
						>
							{lang() === "en" ? "中文" : "EN"}
						</button>
						<ClosePageButton lang={lang()} onClosed={closedManually} />
					</div>
				</div>

				<div class="title-block">
					<h1>{pageTitle()}</h1>
					<div class="meta">
						<span class="meta-path">{replyAt()}</span>
						<span class="meta-dot" aria-hidden="true" />
						<span class="meta-version">{state().reply.model ?? "—"}</span>
						<span class="meta-dot" aria-hidden="true" />
						<span class="meta-changed">
							{t(items().length === 1 ? "talkBlocksOne" : "talkBlocks", { count: items().length })}
						</span>
						<Show when={sent()}>
							<span class="readonly">{t("talkSentBadge")}</span>
						</Show>
					</div>
				</div>
			</header>

			<Show when={error()}>
				<div class="error">{t("error", { message: error() ?? "" })}</div>
			</Show>

			<div class="layout">
				<main class="reading">
					<Show when={sent()}>
						<div class="done">
							<div class="done-title">{t("talkSentTitle")}</div>
							<div class="done-hint">{tabClosed() ? t("closeHint") : t("closing")}</div>
						</div>
					</Show>

					<Show when={items().length === 0}>
						<p class="empty">{t("emptySpec")}</p>
					</Show>

					<div class="blocks">
						<For each={items()}>
							{(item) => (
								<article id={`block-${item.id}`} class="block block-talk">
									<div class="block-bar bar-talk" aria-hidden="true" />
									<div class="block-inner">
									<Show when={item.kind !== "heading"}>
										<div class="block-head">
											<span class="block-id">{item.id}</span>
											<Show when={!locked()}>
												<button
													type="button"
													class="add"
													onClick={() => {
														if (editing() === item.id) {
															setEditing(undefined);
															return;
														}
														setEditing(item.id);
														setNoteDraft(notes()[item.id] ?? "");
													}}
												>
													{notes()[item.id] ? t("editNote") : `+ ${t("addNote")}`}
												</button>
											</Show>
										</div>
									</Show>
										<div class="block-body" innerHTML={item.html} />

										<Show when={notes()[item.id]}>
											<div class="note note-talk">
												<span class="note-verdict verdict-talk">{t("yourNote")}</span>
												<span class="note-text">{notes()[item.id]}</span>
												<Show when={!locked()}>
													<button type="button" class="remove" onClick={() => removeNote(item.id)}>
														{t("remove")}
													</button>
												</Show>
											</div>
										</Show>

										<Show when={editing() === item.id && !locked()}>
											<div class="editor">
												<textarea
													class="note-input"
													placeholder={t("talkNotePlaceholder")}
													value={noteDraft()}
													onInput={(event) => setNoteDraft(event.currentTarget.value)}
													onKeyDown={(event) => {
														if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
															event.preventDefault();
															writeNote(item.id, noteDraft());
															setEditing(undefined);
														}
													}}
												/>
												<div class="editor-actions">
													<button type="button" class="ghost" onClick={() => setEditing(undefined)}>
														{t("cancel")}
													</button>
													<button
														type="button"
														class="primary"
														disabled={noteDraft().trim() === ""}
														onClick={() => {
															writeNote(item.id, noteDraft());
															setEditing(undefined);
														}}
													>
														{t("save")}
													</button>
												</div>
											</div>
										</Show>
									</div>
								</article>
							)}
						</For>
					</div>
				</main>

				<aside class="rail">
					<section class="rail-card">
						<span class="eyebrow">{t("talkAbout")}</span>
						<p class="rail-hint">{t("talkAboutBody")}</p>
						<div class="rail-breakdown">
							<div class="rail-row">
								<span>{t("talkBlocksLabel")}</span>
								<b>{items().length}</b>
							</div>
							<div class="rail-row">
								<span>{t("annotations")}</span>
								<b>{noteCount()}</b>
							</div>
							<div class="rail-row">
								<span>{t("talkChars")}</span>
								<b>{state().reply.chars}</b>
							</div>
						</div>
					</section>

					<section class="rail-card">
						<div class="rail-head">
							<span class="eyebrow">{t("annotations")}</span>
							<span class="rail-badge">{noteCount()}</span>
						</div>
						<Show when={noteEntries().length > 0} fallback={<p class="rail-empty">{t("noNotesYet")}</p>}>
							<div class="rail-notes">
								<For each={noteEntries()}>
									{(entry) => (
										<button type="button" class="rail-note" onClick={() => jumpToBlock(entry.id)}>
											<span class="dot dot-brand" aria-hidden="true" />
											<span class="rail-note-body">
												<span class="rail-note-label">{entry.label}</span>
												<span class="rail-note-text">{entry.text}</span>
											</span>
										</button>
									)}
								</For>
							</div>
						</Show>
					</section>
				</aside>
			</div>

			<footer class="footer footer-talk">
				<div class="footer-center">
					<span class="notes-count">
						<span class="dot dot-brand" aria-hidden="true" />
						{t(noteCount() === 1 ? "noteCountOne" : "noteCount", { count: noteCount() })}
					</span>
				</div>
				<div class="footer-composer">
					<Composer
						value={draft}
						onInput={updateDraft}
						onSubmit={() => void submit()}
						placeholder={t("talkPlaceholder")}
						submitLabel={t("talkSubmitHint")}
						disabled={locked()}
					/>
				</div>
				<div class="footer-actions">
					<button type="button" class="btn-approve" disabled={locked()} onClick={() => void submit()}>
						<span>{t("talkContinue")}</span>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path d="M5 12h14M13 6l6 6-6 6" />
						</svg>
					</button>
				</div>
			</footer>

			<Outline headings={state().headings} />
			<BackToTop />
		</div>
		</Show>
	);
}
