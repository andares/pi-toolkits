import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import * as api from "./api";
import { initialLang, rememberLang, translate, type Lang, type MessageKey } from "./i18n";

type EditorTarget = { blockId?: string } | undefined;

export function App() {
	const [lang, setLang] = createSignal<Lang>(initialLang());
	const [state, setState] = createSignal<api.PlanState>();
	const [viewVersion, setViewVersion] = createSignal<number>();
	const [error, setError] = createSignal<string>();
	const [outcome, setOutcome] = createSignal<api.Decision>();
	const [showAll, setShowAll] = createSignal(false);
	const [editor, setEditor] = createSignal<EditorTarget>();
	const [draft, setDraft] = createSignal("");
	const [verdict, setVerdict] = createSignal<api.Verdict>("change");
	const [tabClosed, setTabClosed] = createSignal(false);

	const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(lang(), key, vars);

	async function load(version?: number) {
		try {
			const next = await api.fetchState(version);
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
		void load();
		const stop = api.subscribe({
			onRevision: () => {
				if (viewVersion() === undefined) void load();
			},
			onAnnotations: () => {
				if (viewVersion() === undefined) void load();
			},
			onDecided: (decision) => setOutcome(decision.action),
		});
		onCleanup(stop);
	});

	const items = createMemo(() => state()?.items ?? []);
	const changedCount = createMemo(() => items().filter((item) => item.status !== "unchanged").length);
	const collapseUnchanged = createMemo(() => !showAll() && changedCount() > 0);
	const hiddenCount = createMemo(() =>
		collapseUnchanged() ? items().filter((item) => item.status === "unchanged").length : 0,
	);
	const visibleItems = createMemo(() =>
		collapseUnchanged() ? items().filter((item) => item.status !== "unchanged") : items(),
	);
	const latestRevision = createMemo(() => state()?.history[0]?.n ?? state()?.version);
	const readOnly = createMemo(() => {
		const current = state();
		return current !== undefined && current.version !== latestRevision();
	});

	const annotationFor = (blockId: string): api.Annotation[] =>
		state()?.annotations.blocks.find((entry) => entry.blockId === blockId)?.annotations ?? [];

	const noteCount = createMemo(() => {
		const annotations = state()?.annotations;
		if (!annotations) return 0;
		const blockNotes = annotations.blocks.reduce((total, entry) => total + entry.annotations.length, 0);
		return annotations.global.length + blockNotes;
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

	return (
		<div class="page">
			<header class="topbar">
				<div class="topbar-left">
					<span class="slug">{state()?.slug}</span>
					<span class="version">
						{t("version", { version: state()?.version ?? 0, total: state()?.totalVersions ?? 0 })}
					</span>
					<span class="changed">{changedCount() > 0 ? t("changed", { count: changedCount() }) : t("noChange")}</span>
					<Show when={readOnly()}>
						<span class="readonly">{t("readOnly")}</span>
					</Show>
				</div>
				<div class="topbar-right">
					<button class="ghost" onClick={() => setShowAll(!showAll())}>
						{showAll() ? t("onlyChanged") : t("showAll")}
					</button>
					<button class="ghost" onClick={() => setEditor({ blockId: undefined })}>
						{t("globalNotes")} ({state()?.annotations.global.length ?? 0})
					</button>
					<button
						class="lang"
						onClick={() => {
							const next: Lang = lang() === "en" ? "zh" : "en";
							setLang(next);
							rememberLang(next);
						}}
					>
						{lang() === "en" ? "中文" : "EN"}
					</button>
				</div>
			</header>

			<Show when={error()}>
				<div class="error">{t("error", { message: error() ?? "" })}</div>
			</Show>

			<Show when={readOnly()}>
				<div class="banner">
					{t("viewingOld", { v: viewVersion() ?? 0 })}
					<button class="link" onClick={() => { setViewVersion(undefined); void load(); }}>
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

			<div class="history">
				<span class="history-label">{t("history")}</span>
				<For each={state()?.history ?? []}>
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
							v{entry.n}
							<Show when={entry.changed > 0}>
								<span class="chip-changed">+{entry.changed}</span>
							</Show>
						</button>
					)}
				</For>
			</div>

			<Show when={state() && state()!.items.length === 0}>
				<p class="empty">{t("emptyPlan")}</p>
			</Show>

			<main class="blocks">
				<Show when={hiddenCount() > 0}>
					<div class="hidden-note">
						{t("unchangedHidden", { count: hiddenCount() })}
						<button class="link" onClick={() => setShowAll(true)}>
							{t("showAll")}
						</button>
					</div>
				</Show>
				<For each={visibleItems()}>
					{(item) => (
						<article class="block" classList={{ ["is-" + item.status]: true }}>
							<div class="block-head">
								<span class={statusClass(item.status)}>
									{t(`status_${item.status}` as MessageKey)}
								</span>
								<span class="block-id">{item.id}</span>
								<Show when={!readOnly()}>
									<button
										class="add"
										onClick={() => {
											setEditor({ blockId: item.id });
											setDraft("");
											setVerdict("change");
										}}
									>
										+ {t("addNote")}
									</button>
								</Show>
							</div>
							<div class="block-body" innerHTML={item.html} />
							<For each={annotationFor(item.id)}>
								{(annotation, index) => (
									<div class="note" classList={{ [annotation.verdict]: true }}>
										<span class="note-verdict">{t(`verdict${annotation.verdict[0].toUpperCase()}${annotation.verdict.slice(1)}` as MessageKey)}</span>
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
						</article>
					)}
				</For>
			</main>

			<Show when={editor() && editor()!.blockId === undefined && !readOnly()}>
				<div class="global-panel">
					<For each={state()?.annotations.global ?? []}>
						{(annotation, index) => (
							<div class="note" classList={{ [annotation.verdict]: true }}>
								<span class="note-verdict">{annotation.verdict}</span>
								<span class="note-text">{annotation.comment}</span>
								<button class="remove" onClick={() => void removeAnnotation(undefined, index())}>
									{t("remove")}
								</button>
							</div>
						)}
					</For>
					<NoteEditor
						draft={draft}
						setDraft={setDraft}
						verdict={verdict}
						setVerdict={setVerdict}
						onSave={() => void addAnnotation(undefined)}
						onCancel={() => setEditor(undefined)}
						t={t}
					/>
				</div>
			</Show>

			<footer class="footer">
				<div class="hint">{t("notesHint")} · {noteCount()} {lang() === "zh" ? "条批注" : "notes"}</div>
				<div class="actions">
					<button class="deny" disabled={readOnly() || outcome() !== undefined} onClick={() => void decide("deny")}>
						{t("deny")}
					</button>
					<button class="approve" disabled={readOnly() || outcome() !== undefined} onClick={() => void decide("approve")}>
						{t("approve")}
					</button>
				</div>
			</footer>
		</div>
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
				<For each={["change", "suggest", "question"] as api.Verdict[]}>
					{(value) => (
						<label classList={{ active: props.verdict() === value }}>
							<input
								type="radio"
								name="verdict"
								checked={props.verdict() === value}
								onChange={() => props.setVerdict(value)}
							/>
							{props.t(
								`verdict${value[0].toUpperCase()}${value.slice(1)}` as MessageKey,
							)}
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
