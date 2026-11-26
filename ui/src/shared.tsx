/**
 * Shared page furniture — the parts both review modes use unchanged.
 *
 * `SpecView` and `TalkView` differ in what they put around the blocks; the
 * blocks themselves, the outline and the back-to-top button must not know which
 * mode they are in, or the two pages drift apart within one release.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { postClose, type Heading } from "./api";
import { translate, type Lang, type MessageKey } from "./i18n";

/** Same mapping the server uses for outline depth: the levels present, capped at 4. */
function depthOf(level: number, levels: readonly number[]): number {
	const distinct = [...new Set(levels)].sort((a, b) => a - b);
	const index = distinct.indexOf(level);
	return index < 0 ? 0 : Math.min(index, 3);
}

/** Bar width per depth (px) — deeper headings get shorter bars, like a stack of rulers. */
const BAR_WIDTH = [16, 13, 10, 8];

/** How many bars the collapsed strip shows before it starts sampling. */
const MAX_BARS = 24;

/** Keep a revealed outline row clear of the list's 10–12px edge fade. */
const REVEAL_INSET = 14;

/**
 * Evenly thin the outline down to `MAX_BARS`, always keeping the first heading
 * and the one currently being read: precision here is explicitly cheap, "I can
 * see roughly where I am and can jump" is the whole promise.
 */
export function sampleHeadings(
	headings: readonly Heading[],
	activeId: string | undefined,
	max = MAX_BARS,
): Heading[] {
	if (max <= 0) return [];
	if (headings.length <= max) return [...headings];
	const activeIndex = headings.findIndex((heading) => heading.blockId === activeId);
	if (max === 1) return [headings[activeIndex >= 0 ? activeIndex : 0]!];

	const kept = new Set<number>();
	if (activeIndex >= 0) kept.add(activeIndex);
	kept.add(0);
	// Reserve slots for the pinned entries BEFORE sampling. Adding the active
	// heading to a full sample afterwards would produce 25 bars for a 24-bar cap.
	const slots = max - kept.size;
	const step = slots > 1 ? (headings.length - 1) / (slots - 1) : 0;
	for (let i = 0; i < slots; i += 1) {
		kept.add(slots === 1 ? headings.length - 1 : Math.round(i * step));
	}
	return [...kept]
		.sort((a, b) => a - b)
		.map((index) => headings[index])
		.filter((heading): heading is Heading => heading !== undefined);
}

/** Scroll offset for "which section am I in" — clears the sticky-looking top bar. */
const SPY_OFFSET = 140;

/** One motion policy for outline jumps and back-to-top. */
export function preferredScrollBehavior(): ScrollBehavior {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export interface OutlineProps {
	headings: Heading[];
	/** Called before scrolling; spec mode uses it to un-hide filtered blocks. */
	onJump?: (blockId: string) => void;
}

export function Outline(props: OutlineProps) {
	const [open, setOpen] = createSignal(false);
	const [activeId, setActiveId] = createSignal<string>();
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	let flashed: HTMLElement | undefined;
	let scrollFrame: number | undefined;
	let barsElement: HTMLDivElement | undefined;
	let listElement: HTMLDivElement | undefined;

	const levels = createMemo(() => props.headings.map((heading) => heading.level));
	const bars = createMemo(() => sampleHeadings(props.headings, activeId()));
	const depth = (level: number) => depthOf(level, levels());

	function openSoon() {
		if (closeTimer !== undefined) clearTimeout(closeTimer);
		setOpen(true);
	}

	function closeSoon() {
		if (closeTimer !== undefined) clearTimeout(closeTimer);
		closeTimer = setTimeout(() => setOpen(false), 200);
	}

	onMount(() => {
		const spy = () => {
			let current: string | undefined;
			for (const heading of props.headings) {
				const element = document.getElementById(`block-${heading.blockId}`);
				if (!element) continue;
				if (element.getBoundingClientRect().top <= SPY_OFFSET) current = heading.blockId;
				else break;
			}
			setActiveId(current);
		};
		// Reading every heading's rect is layout work; do it at most once per frame,
		// not once per raw scroll event.
		const scheduleSpy = () => {
			if (scrollFrame !== undefined) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = undefined;
				spy();
			});
		};
		window.addEventListener("scroll", scheduleSpy, { passive: true });
		spy();
		onCleanup(() => {
			window.removeEventListener("scroll", scheduleSpy);
			if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
		});
	});

	onCleanup(() => {
		if (closeTimer !== undefined) clearTimeout(closeTimer);
		if (flashTimer !== undefined) clearTimeout(flashTimer);
		flashed?.classList.remove("is-target");
	});

	// CSS bounds the strip so it can never run off the screen; when that bound
	// does bite (a very short window, a longer sample), the bar for the section
	// being read has to stay visible — otherwise the red marker disappears at
	// whichever end is scrolled out of the strip.
	createEffect(() => {
		const id = activeId();
		const strip = barsElement;
		if (!strip || id === undefined) return;
		const index = bars().findIndex((heading) => heading.blockId === id);
		const bar = strip.children[index] as HTMLElement | undefined;
		if (!bar) return;
		const box = strip.getBoundingClientRect();
		const rect = bar.getBoundingClientRect();
		if (rect.top < box.top) strip.scrollTop -= box.top - rect.top;
		else if (rect.bottom > box.bottom) strip.scrollTop += rect.bottom - box.bottom;
	});

	// Same promise for the opened panel: the rows keep their full height and the
	// list scrolls once the headings outgrow `max-height`, so the row for the
	// section being read can sit below the fold. Reveal it when the panel opens
	// (nearest edge, like the strip) instead of always starting at the top and
	// leaving the operator to hunt for the red row. The inset keeps the row out
	// of the list's own 10–12px fade, which would erase half of it.
	createEffect(() => {
		if (!open()) return;
		const list = listElement;
		const id = activeId();
		if (!list || id === undefined) return;
		const index = props.headings.findIndex((heading) => heading.blockId === id);
		const row = index >= 0 ? (list.children[index] as HTMLElement | undefined) : undefined;
		if (!row) return;
		const box = list.getBoundingClientRect();
		const rect = row.getBoundingClientRect();
		const style = getComputedStyle(list);
		const top = box.top + Number.parseFloat(style.paddingTop) + REVEAL_INSET;
		const bottom = box.bottom - Number.parseFloat(style.paddingBottom) - REVEAL_INSET;
		if (rect.top < top) list.scrollTop -= top - rect.top;
		else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
	});

	function jump(blockId: string) {
		props.onJump?.(blockId);
		requestAnimationFrame(() => {
			const element = document.getElementById(`block-${blockId}`);
			if (!element) return;
			element.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
			// Clearing only the previous timer would leave its element highlighted
			// forever when the operator jumps twice in quick succession.
			flashed?.classList.remove("is-target");
			flashed = element;
			element.classList.add("is-target");
			if (flashTimer !== undefined) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => {
				element.classList.remove("is-target");
				if (flashed === element) flashed = undefined;
			}, 1200);
			setActiveId(blockId);
			setOpen(false);
		});
	}

	return (
		<Show when={props.headings.length > 0}>
			<nav
				class="outline"
				aria-label="Contents"
				classList={{ "is-open": open() }}
				onMouseEnter={openSoon}
				onMouseLeave={closeSoon}
			>
				<div class="outline-bars" aria-hidden={open()} ref={(node) => (barsElement = node)}>
					<For each={bars()}>
						{(heading) => (
							<span
								class="outline-bar"
								classList={{ "is-active": heading.blockId === activeId() }}
								style={{
									width: `${BAR_WIDTH[depth(heading.level)]}px`,
								}}
							/>
						)}
					</For>
				</div>

				<div class="outline-panel" aria-hidden={!open()}>
					<div class="outline-head">
						<span class="eyebrow">CONTENTS</span>
						<span class="outline-count">
							{props.headings.length} {props.headings.length === 1 ? "heading" : "headings"}
						</span>
					</div>
					<div class="outline-list" ref={(node) => (listElement = node)}>
						<For each={props.headings}>
							{(heading) => (
								<button
									type="button"
									class="outline-row"
									classList={{ "is-active": heading.blockId === activeId() }}
									style={{ "padding-left": `${10 + depth(heading.level) * 14}px` }}
									onClick={() => jump(heading.blockId)}
									tabIndex={open() ? 0 : -1}
									title={heading.text}
								>
									<span class="outline-text">{heading.text}</span>
								</button>
							)}
						</For>
					</div>
				</div>
			</nav>
		</Show>
	);
}

/**
 * Back to top — appears only once the whole rail has scrolled past.
 *
 * The rail is the right column (version stats + note index). While any part of
 * it is on screen there is something to read over there, so the shortcut is
 * noise; once it is gone the operator is deep in the document and the way back
 * is worth a button. In the single-column layout (<1040px) the rail sits below
 * the reading column instead, so "rail gone" would mean "almost at the bottom";
 * that layout falls back to a plain one-screen threshold.
 */
export function BackToTop() {
	const [visible, setVisible] = createSignal(false);

	onMount(() => {
		const narrow = window.matchMedia("(max-width: 1040px)");
		const rail = document.querySelector<HTMLElement>(".rail");
		let observer: IntersectionObserver | undefined;

		const byScroll = () => setVisible(window.scrollY > window.innerHeight * 0.8);

		const rebuild = () => {
			observer?.disconnect();
			observer = undefined;
			if (narrow.matches || !rail) {
				byScroll();
				return;
			}
			setVisible(false);
			observer = new IntersectionObserver(
				(entries) => {
					const entry = entries.at(-1);
					if (!entry) return;
					// "Whole rail above the viewport" — not merely "not intersecting",
					// which would also fire while it is still below the fold.
					setVisible(!entry.isIntersecting && entry.boundingClientRect.bottom <= 0);
				},
				{ threshold: 0 },
			);
			observer.observe(rail);
		};

		const onScroll = () => {
			if (narrow.matches || !rail) byScroll();
		};

		rebuild();
		window.addEventListener("scroll", onScroll, { passive: true });
		narrow.addEventListener("change", rebuild);
		onCleanup(() => {
			observer?.disconnect();
			window.removeEventListener("scroll", onScroll);
			narrow.removeEventListener("change", rebuild);
		});
	});

	return (
		<Show when={visible()}>
			<button
				type="button"
				class="back-to-top"
				onClick={() => {
					window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
				}}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<path d="M12 19V5M6 11l6-6 6 6" />
				</svg>
				<span>Back to top</span>
			</button>
		</Show>
	);
}

/**
 * Publish the footer height so floating widgets can sit above it.
 *
 * The talk page's composer grows while typing and the footer grows with it; a
 * constant would either overlap the buttons or float them into the middle of
 * the screen depending on which page is open.
 */
export function useFooterHeight(): void {
	onMount(() => {
		const footer = document.querySelector<HTMLElement>(".footer");
		if (!footer) return;
		const publish = () => {
			document.documentElement.style.setProperty(
				"--footer-h",
				`${footer.getBoundingClientRect().height + 18}px`,
			);
		};
		const observer = new ResizeObserver(publish);
		observer.observe(footer);
		publish();
		onCleanup(() => observer.disconnect());
	});
}

export interface ClosePageButtonProps {
	lang: Lang;
	/** False means the server was already gone (for example after `/reload`). */
	onClosed: (serverClosed: boolean) => void;
}

/**
 * Close a review without producing a decision or a message for the agent.
 *
 * There is no dialog component in this UI to reuse; the browser's native
 * confirmation supplies the second step without inventing a new visual system.
 * The server may already be unreachable after `/reload`, so failure to reach it
 * is not allowed to strand the tab: the parent still enters its closed state.
 */
export function ClosePageButton(props: ClosePageButtonProps) {
	const [busy, setBusy] = createSignal(false);
	const t = (key: MessageKey) => translate(props.lang, key);

	async function close() {
		let serverClosed = false;
		try {
			await postClose();
			serverClosed = true;
		} catch {
			// The fallback page must not claim an unreachable server was stopped.
		}
		props.onClosed(serverClosed);
		// External launchers usually create tabs that scripts may not close. The
		// parent's closed state is therefore the reliable fallback, not this call.
		window.close();
	}

	return (
		<button
			type="button"
			class="ghost close-page"
			disabled={busy()}
			title={t("closePageHint")}
			onClick={() => {
				if (busy() || !window.confirm(t("closePageConfirm"))) return;
				setBusy(true);
				void close();
			}}
		>
			{t("closePage")}
		</button>
	);
}

/** Terminal state shown when the browser refuses to close an external tab. */
export function ManualCloseNotice(props: { lang: Lang; serverClosed: boolean }) {
	const t = (key: MessageKey) => translate(props.lang, key);
	return (
		<div class="page page-closed">
			<main class="manual-close-notice" role="status">
				<div class="done">
					<div class="done-title">{t("closePageDone")}</div>
					<div class="done-hint">
						{props.serverClosed ? t("closePageServerClosed") : t("closePageUnreachable")}
					</div>
					<div class="done-hint">{t("closeHint")}</div>
				</div>
			</main>
		</div>
	);
}

export interface ComposerProps {
	value: () => string;
	onInput: (value: string) => void;
	onSubmit: () => void;
	placeholder: string;
	submitLabel: string;
	disabled?: boolean;
}

/** Tallest the composer grows before it scrolls internally. */
const COMPOSER_MAX = 220;

/**
 * One line's worth of box, and the border widths that `scrollHeight` omits.
 *
 * `scrollHeight` is content + padding; a CSS `height` is the border box. Copying
 * one into the other drops the borders, which clips the last line by a couple of
 * pixels — visible as text sitting too high in the field.
 */
function composerMetrics(element: HTMLTextAreaElement): { oneLine: number; border: number } {
	const style = getComputedStyle(element);
	const px = (value: string) => Number.parseFloat(value) || 0;
	const lineHeight = Number.parseFloat(style.lineHeight);
	const fontSize = Number.parseFloat(style.fontSize);
	const line = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.5;
	const border = px(style.borderTopWidth) + px(style.borderBottomWidth);
	const padding = px(style.paddingTop) + px(style.paddingBottom);
	return { oneLine: line + padding + border, border };
}

/**
 * One line at rest, taller while focused, scrolling past ~40vh.
 *
 * Collapsing on blur is deliberate: the composer is a message box, not a
 * document pane. But "collapsed" is exactly ONE LINE, never less — a field
 * shorter than its own line clips the first line too, which is the bug this
 * function exists to not have. Text beyond the first line may be cut off while
 * blurred; the text itself is kept and comes back on focus.
 */
export function Composer(props: ComposerProps) {
	let element: HTMLTextAreaElement | undefined;

	const resize = (expanded: boolean) => {
		if (!element) return;
		const { oneLine, border } = composerMetrics(element);
		const cap = Math.min(window.innerHeight * 0.4, COMPOSER_MAX);
		element.style.height = "auto";
		const content = element.scrollHeight; // content + padding, no border
		const full = content + border;
		const wanted = expanded ? Math.min(full, cap) : oneLine;
		element.style.height = `${Math.max(wanted, oneLine)}px`;
		element.style.overflowY = expanded && full > cap ? "auto" : "hidden";
	};

	onMount(() => resize(document.activeElement === element));

	return (
		<textarea
			ref={(node) => {
				element = node;
			}}
			class="composer-input"
			rows={1}
			placeholder={props.placeholder}
			value={props.value()}
			disabled={props.disabled}
			onFocus={() => resize(true)}
			onBlur={() => resize(false)}
			onInput={(event) => {
				props.onInput(event.currentTarget.value);
				resize(true);
			}}
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
					event.preventDefault();
					props.onSubmit();
				}
			}}
			aria-label={props.placeholder}
			title={props.submitLabel}
		/>
	);
}
