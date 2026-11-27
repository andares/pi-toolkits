import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import * as api from "./api";
import { initialLang, rememberLang, translate, type Lang, type MessageKey } from "./i18n";
import { BackToTop, ClosePageButton, ManualCloseNotice, Outline, useFooterHeight } from "./shared";

type EditorTarget = { blockId?: string } | undefined;

/**
 * Read weakest first: "suggest" is the everyday note, "must change" blocks the
 * spec, "question" asks for an answer. The first entry is also the default, so
 * the common note needs no click on a verdict; keep the two in one place.
 */
const VERDICT_ORDER: api.Verdict[] = ["suggest", "change", "question"];
const DEFAULT_VERDICT: api.Verdict = VERDICT_ORDER[0];

interface NoteEntry {
	key: string;
	blockId?: string;
	label: string;
	annotation: api.Annotation;
}

export function SpecView(props: { initial: api.SpecState }) {
	const [lang, setLang] = createSignal<Lang>(initialLang());
	const [state, setState] = createSignal<api.SpecState>(props.initial);
	const [viewVersion, setViewVersion] = createSignal<number>();
	const [error, setError] = createSignal<string>();
	const [outcome, setOutcome] = createSignal<api.Decision | undefined>(
		props.initial.decided && props.initial.decision ? props.initial.decision.action : undefined,
	);
	const [showAll, setShowAll] = createSignal(false);
	const [editor, setEditor] = createSignal<EditorTarget>();
	const [draft, setDraft] = createSignal("");
	const [verdict, setVerdict] = createSignal<api.Verdict>(DEFAULT_VERDICT);
	const [tabClosed, setTabClosed] = createSignal(false);
	/** undefined = open; true/false = manually closed, server reachable or not. */
	const [manualClose, setManualClose] = createSignal<boolean>();
	let stopEvents: (() => void) | undefined;

	const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(lang(), key, vars);

	useFooterHeight();

	async function load(version?: number) {
		try {
			const next = await api.fetchState(version);
			// The same bundle serves `/ask-talk`; a stray reload of that page must not
			// be rendered as a spec review.
			if (next.mode !== "spec") return;
			setState(next);
			setError(undefined);
			// Moving between history entries must not carry an old revision's
			// decision onto the latest, still-reviewable one.
			setOutcome(next.decided && next.decision ? next.decision.action : undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	onMount(() => {
		stopEvents = api.subscribe({
			onRevision: () => {
				if (viewVersion() === undefined) void load();
			},
			onAnnotations: () => {
				if (viewVersion() === undefined) void load();
			},
			onDecided: (decision) => setOutcome(decision.action),
		});
		onCleanup(() => {
			stopEvents?.();
			stopEvents = undefined;
		});
	});

	createEffect(() => {
		const slug = state()?.slug;
		document.title = slug ? `${t("title")} — ${slug}` : t("title");
	});

	const items = createMemo(() => state()?.items ?? []);
	/** Talk items carry no diff status; spec items always do. */
	const statusOf = (item: api.SpecItem): api.BlockStatus => item.status ?? "unchanged";
	const changedCount = createMemo(() => items().filter((item) => statusOf(item) !== "unchanged").length);
	const collapseUnchanged = createMemo(() => !showAll() && changedCount() > 0);
	const hiddenCount = createMemo(() =>
		collapseUnchanged() ? items().filter((item) => statusOf(item) === "unchanged").length : 0,
	);
	const visibleItems = createMemo(() =>
		collapseUnchanged() ? items().filter((item) => statusOf(item) !== "unchanged") : items(),
	);
	const latestRevision = createMemo(() => state()?.history[0]?.n ?? state()?.version);
	const readOnly = createMemo(() => {
		const current = state();
		return current !== undefined && current.version !== latestRevision();
	});
	const counts = createMemo(() => {
		const result: Record<api.BlockStatus, number> = {
			unchanged: 0,
			moved: 0,
			modified: 0,
			added: 0,
			removed: 0,
		};
		for (const item of items()) result[statusOf(item)] += 1;
		return result;
	});
	const historyAsc = createMemo(() => [...(state()?.history ?? [])].reverse());

	const globalNotes = createMemo(() => state()?.annotations.global ?? []);
	const globalEditorOpen = createMemo(() => editor() !== undefined && editor()!.blockId === undefined);
	const globalCardVisible = createMemo(() => globalNotes().length > 0 || globalEditorOpen());

	const annotationFor = (blockId: string): api.Annotation[] =>
		state()?.annotations.blocks.find((entry) => entry.blockId === blockId)?.annotations ?? [];

	const noteCount = createMemo(() => {
		const annotations = state()?.annotations;
		if (!annotations) return 0;
		const blockNotes = annotations.blocks.reduce((total, entry) => total + entry.annotations.length, 0);
		return annotations.global.length + blockNotes;
	});

	const noteEntries = createMemo<NoteEntry[]>(() => {
		const current = state();
		if (!current) return [];
		const labels = new Map(current.items.map((item) => [item.id, item.label]));
		const entries: NoteEntry[] = current.annotations.global.map((annotation, index) => ({
			key: `global-${index}`,
			label: t("globalNotesTitle"),
			annotation,
		}));
		for (const group of current.annotations.blocks) {
			const label = labels.get(group.blockId) ?? group.blockId;
			group.annotations.forEach((annotation, index) => {
				entries.push({
					key: `${group.blockId}-${index}`,
					blockId: group.blockId,
					label,
					annotation,
				});
			});
		}
		return entries;
	});

	async function persist(next: api.Annotations) {
		const current = state();
		if (!current) return;
		const optimistic = { ...current, annotations: next };
		setState(optimistic);
		try {
			await api.postAnnotations(current.version, next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			await load(current.version);
		}
	}

	async function addAnnotation(blockId: string | undefined) {
		const comment = draft().trim();
		if (comment === "") return;
		const current = state();
		if (!current) return;
		const annotation: api.Annotation = { verdict: verdict(), comment };
		let next: api.Annotations;
		if (blockId === undefined) {
			next = { ...current.annotations, global: [...current.annotations.global, annotation] };
		} else {
			const blocks = current.annotations.blocks.slice();
			const index = blocks.findIndex((entry) => entry.blockId === blockId);
			if (index === -1) blocks.push({ blockId, annotations: [annotation] });
			else blocks[index] = { ...blocks[index], annotations: [...blocks[index].annotations, annotation] };
			next = { ...current.annotations, blocks };
		}
		setEditor(undefined);
		setDraft("");
		await persist(next);
	}

	async function removeAnnotation(blockId: string | undefined, index: number) {
		const current = state();
		if (!current) return;
		let next: api.Annotations;
		if (blockId === undefined) {
			next = { ...current.annotations, global: current.annotations.global.filter((_, i) => i !== index) };
		} else {
			next = {
				...current.annotations,
				blocks: current.annotations.blocks
					.map((entry) =>
						entry.blockId === blockId
							? { ...entry, annotations: entry.annotations.filter((_, i) => i !== index) }
							: entry,
					)
					.filter((entry) => entry.annotations.length > 0),
			};
		}
		await persist(next);
	}

	function focusGlobalNotes() {
		if (!readOnly() && !globalEditorOpen()) {
			setEditor({ blockId: undefined });
			setDraft("");
			setVerdict(DEFAULT_VERDICT);
		}
		requestAnimationFrame(() => {
			document.getElementById("global-notes")?.scrollIntoView({ behavior: "smooth", block: "start" });
		});
	}

	function toggleGlobalNotes() {
		if (readOnly()) return;
		if (globalEditorOpen()) {
			setEditor(undefined);
			return;
		}
		focusGlobalNotes();
	}

	/** Outline jump: a heading can live in a block hidden by "Only changed". */
	function jumpFromOutline(blockId: string) {
		if (!visibleItems().some((item) => item.id === blockId)) setShowAll(true);
	}

	function jumpToNote(entry: NoteEntry) {
		const target = entry.blockId;
		if (!visibleItems().some((item) => item.id === target)) setShowAll(true);
		requestAnimationFrame(() => {
			document.getElementById(`block-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
	}

	function closedManually(serverClosed: boolean): void {
		// Do not let EventSource reconnect forever after its server was closed or
		// disappeared during /reload. The fallback page has no live state.
		stopEvents?.();
		stopEvents = undefined;
		setManualClose(serverClosed);
	}

	async function decide(action: api.Decision) {
		const current = state();
		if (!current) return;
		try {
			await api.postDecision(action, current.version);
			setOutcome(action);
			// Same trick plannotator uses: close right away, and only fall back to
			// an on-screen note when the browser refused (tabs opened by an
			// external launcher are not script-opened, so some browsers say no).
			window.close();
			setTimeout(() => setTabClosed(true), 300);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	const statusClass = (status: api.BlockStatus) => `badge badge-${status}`;
	const verdictKey = (value: api.Verdict) =>
		(`verdict${value[0].toUpperCase()}${value.slice(1)}` as MessageKey);
	const verdictClass = (value: api.Verdict) => `note-verdict verdict-${value}`;

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
								<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
								<path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" />
							</svg>
						</span>
						<span class="eyebrow">{t("title")}</span>
					</div>
					<div class="top-actions">
						<button
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
					<h1>{state()?.slug ?? "spec"}</h1>
					<div class="meta">
						<span class="meta-path">{state()?.source ?? "specs/spec.md"}</span>
						<span class="meta-dot" aria-hidden="true" />
						<span class="meta-version">
							{t("version", { version: state()?.version ?? 0, total: state()?.totalVersions ?? 0 })}
						</span>
						<span class="meta-dot" aria-hidden="true" />
						<span class="meta-changed">
							{changedCount() > 0 ? t(changedCount() === 1 ? "changedOne" : "changed", { count: changedCount() }) : t("noChange")}
						</span>
						<Show when={readOnly()}>
							<span class="readonly">{t("readOnly")}</span>
						</Show>
					</div>
				</div>

				<div class="history">
					<span class="eyebrow history-label">{t("history")}</span>
					<For each={historyAsc()}>
						{(entry) => (
							<button
								class="chip"
								classList={{ active: entry.n === state()?.version }}
								onClick={() => {
									if (entry.n === latestRevision()) {
										setViewVersion(undefined);
										void load();
									} else {
										setViewVersion(entry.n);
										void load(entry.n);
									}
								}}
							>
								<span class="chip-n">v{entry.n}</span>
								<Show when={entry.changed > 0}>
									<span class="chip-changed">+{entry.changed}</span>
								</Show>
							</button>
						)}
					</For>
					<span class="history-summary">{t(items().length === 1 ? "historySummaryOne" : "historySummary", { count: items().length })}</span>
				</div>
			</header>

			<Show when={error()}>
				<div class="error">{t("error", { message: error() ?? "" })}</div>
			</Show>

			<div class="layout">
				<main class="reading">
					<Show when={readOnly()}>
						<div class="banner">
							<span>{t("viewingOld", { v: viewVersion() ?? state()?.version ?? 0 })}</span>
							<button
								class="link"
								onClick={() => {
									setViewVersion(undefined);
									void load();
								}}
							>
								{t("back")}
							</button>
						</div>
					</Show>

					<Show when={outcome()}>
						<div class="done">
							<div class="done-title">{outcome() === "approve" ? t("approved") : t("denied")}</div>
							<div class="done-hint">{tabClosed() ? t("closeHint") : t("closing")}</div>
						</div>
					</Show>

					<Show when={globalCardVisible()}>
						<section id="global-notes" class="global-card">
							<div class="global-head">
								<span class="eyebrow">{t("globalNotesTitle")}</span>
								<span class="global-count">{globalNotes().length}</span>
								<Show when={!readOnly() && !globalEditorOpen()}>
									<button
										class="add"
										onClick={() => {
											setEditor({ blockId: undefined });
											setDraft("");
											setVerdict(DEFAULT_VERDICT);
										}}
									>
										+ {t("addNote")}
									</button>
								</Show>
							</div>
							<For each={globalNotes()}>
								{(annotation, index) => (
									<div class={`note note-${annotation.verdict}`}>
										<span class={verdictClass(annotation.verdict)}>{t(verdictKey(annotation.verdict))}</span>
										<span class="note-text">{annotation.comment}</span>
										<Show when={!readOnly()}>
											<button class="remove" onClick={() => void removeAnnotation(undefined, index())}>
												{t("remove")}
											</button>
										</Show>
									</div>
								)}
							</For>
							<Show when={globalEditorOpen() && !readOnly()}>
								<NoteEditor
									draft={draft}
									setDraft={setDraft}
									verdict={verdict}
									setVerdict={setVerdict}
									onSave={() => void addAnnotation(undefined)}
									onCancel={() => setEditor(undefined)}
									t={t}
								/>
							</Show>
						</section>
					</Show>

					<Show when={state() && state()!.items.length === 0}>
						<p class="empty">{t("emptySpec")}</p>
					</Show>

					<Show when={hiddenCount() > 0}>
						<div class="collapsed">
							<span>{t(hiddenCount() === 1 ? "unchangedHiddenOne" : "unchangedHidden", { count: hiddenCount() })}</span>
							<button class="link" onClick={() => setShowAll(true)}>
								{t("showAll")}
							</button>
						</div>
					</Show>

					<div class="blocks">
						<For each={visibleItems()}>
							{(item) => (
								<article
									id={`block-${item.id}`}
									class="block"
									classList={{ ["is-" + statusOf(item)]: true }}
								>
									<div class={`block-bar bar-${statusOf(item)}`} aria-hidden="true" />
									<div class="block-inner">
										<div class="block-head">
											<span class={statusClass(statusOf(item))}>
												<span class={`dot dot-${statusOf(item)}`} aria-hidden="true" />
												{t(`status_${statusOf(item)}` as MessageKey)}
											</span>
											<span class="block-id">{item.id}</span>
											<Show when={!readOnly()}>
												<button
													class="add"
													onClick={() => {
														setEditor({ blockId: item.id });
														setDraft("");
														setVerdict(DEFAULT_VERDICT);
													}}
												>
													+ {t("addNote")}
												</button>
											</Show>
										</div>
										<div class="block-body" innerHTML={item.html} />
										<For each={annotationFor(item.id)}>
											{(annotation, index) => (
												<div class={`note note-${annotation.verdict}`}>
													<span class={verdictClass(annotation.verdict)}>
														{t(verdictKey(annotation.verdict))}
													</span>
													<span class="note-text">{annotation.comment}</span>
													<Show when={!readOnly()}>
														<button class="remove" onClick={() => void removeAnnotation(item.id, index())}>
															{t("remove")}
														</button>
													</Show>
												</div>
											)}
										</For>
										<Show when={editor()?.blockId === item.id && !readOnly()}>
											<NoteEditor
												draft={draft}
												setDraft={setDraft}
												verdict={verdict}
												setVerdict={setVerdict}
												onSave={() => void addAnnotation(item.id)}
												onCancel={() => setEditor(undefined)}
												t={t}
											/>
										</Show>
									</div>
								</article>
							)}
						</For>
					</div>
				</main>

				<aside class="rail">
					<section class="rail-card">
						<span class="eyebrow">{t("thisRevision")}</span>
						<div class="rail-big">
							<span class="rail-number">{changedCount()}</span>
							<div class="rail-caption">
								<span>{t("blocksChanged")}</span>
								<span class="muted">{t("ofTotal", { total: items().length })}</span>
							</div>
						</div>
						<div class="rail-breakdown">
							<div class="rail-row">
								<span class="dot dot-added" aria-hidden="true" />
								<span>{t("status_added")}</span>
								<b>{counts().added}</b>
							</div>
							<div class="rail-row">
								<span class="dot dot-modified" aria-hidden="true" />
								<span>{t("status_modified")}</span>
								<b>{counts().modified}</b>
							</div>
							<div class="rail-row">
								<span class="dot dot-moved" aria-hidden="true" />
								<span>{t("status_moved")}</span>
								<b>{counts().moved}</b>
							</div>
							<div class="rail-row">
								<span class="dot dot-removed" aria-hidden="true" />
								<span>{t("status_removed")}</span>
								<b>{counts().removed}</b>
							</div>
						</div>
					</section>

					<section class="rail-card">
						<div class="rail-head">
							<span class="eyebrow">{t("annotations")}</span>
							<span class="rail-badge">{noteCount()}</span>
						</div>
						<Show
							when={noteEntries().length > 0}
							fallback={<p class="rail-empty">{t("noNotesYet")}</p>}
						>
							<div class="rail-notes">
								<For each={noteEntries()}>
									{(entry) => (
										<button class="rail-note" onClick={() => jumpToNote(entry)}>
											<span class={`dot dot-${entry.annotation.verdict}`} aria-hidden="true" />
											<span class="rail-note-body">
												<span class="rail-note-label">{entry.label}</span>
												<span class="rail-note-text">{entry.annotation.comment}</span>
											</span>
										</button>
									)}
								</For>
							</div>
						</Show>
					</section>
				</aside>
			</div>

			<footer class="footer">
				<div class="footer-left">
					<Show when={changedCount() > 0}>
						<button class="ghost" onClick={() => setShowAll(!showAll())}>
							{showAll() ? t("onlyChanged") : t("showAll")}
						</button>
					</Show>
					<button class="ghost" onClick={toggleGlobalNotes} disabled={readOnly()}>
						{t("globalNotes")} ({globalNotes().length})
					</button>
				</div>
				<div class="footer-center">
					<span class="notes-count">
						<span class="dot dot-brand" aria-hidden="true" />
						{t(noteCount() === 1 ? "noteCountOne" : "noteCount", { count: noteCount() })}
					</span>
				</div>
				<div class="footer-actions">
					<button
						class="btn-feedback"
						disabled={readOnly() || outcome() !== undefined}
						onClick={() => void decide("deny")}
					>
						{t("deny")}
					</button>
					<button
						class="btn-approve"
						disabled={readOnly() || outcome() !== undefined}
						onClick={() => void decide("approve")}
					>
						<span>{t("approve")}</span>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path d="M5 12h14M13 6l6 6-6 6" />
						</svg>
					</button>
				</div>
			</footer>

			<Outline headings={state()?.headings ?? []} onJump={jumpFromOutline} />
			<BackToTop />
		</div>
		</Show>
	);
}

interface NoteEditorProps {
	draft: () => string;
	setDraft: (value: string) => void;
	verdict: () => api.Verdict;
	setVerdict: (value: api.Verdict) => void;
	onSave: () => void;
	onCancel: () => void;
	t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

function NoteEditor(props: NoteEditorProps) {
	return (
		<div class="editor">
			<div class="verdicts">
				<For each={VERDICT_ORDER}>
					{(value) => (
						<label classList={{ active: props.verdict() === value }}>
							<input
								type="radio"
								name="verdict"
								checked={props.verdict() === value}
								onChange={() => props.setVerdict(value)}
							/>
							{props.t(`verdict${value[0].toUpperCase()}${value.slice(1)}` as MessageKey)}
						</label>
					)}
				</For>
			</div>
			<textarea
				placeholder={props.t("notePlaceholder")}
				value={props.draft()}
				onInput={(event) => props.setDraft(event.currentTarget.value)}
			/>
			<div class="editor-actions">
				<button class="ghost" onClick={props.onCancel}>
					{props.t("cancel")}
				</button>
				<button class="primary" onClick={props.onSave} disabled={props.draft().trim() === ""}>
					{props.t("save")}
				</button>
			</div>
		</div>
	);
}
