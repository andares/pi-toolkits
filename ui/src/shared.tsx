/**
 * Shared page furniture — the parts both review modes use unchanged.
 *
 * `SpecView` and `TalkView` differ in what they put around the blocks; the
 * blocks themselves, the outline and the back-to-top button must not know which
 * mode they are in, or the two pages drift apart within one release.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Heading } from "./api";

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
				<div class="outline-bars" aria-hidden={open()}>
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
					<div class="outline-list">
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
 * One line at rest, taller while focused, scrolling past ~40vh.
 *
 * Collapsing on blur is deliberate: the composer is a message box, not a
 * document pane. The text stays, the height does not.
 */
export function Composer(props: ComposerProps) {
	let element: HTMLTextAreaElement | undefined;

	const resize = (expanded: boolean) => {
		if (!element) return;
		element.style.height = "auto";
		const cap = Math.min(window.innerHeight * 0.4, COMPOSER_MAX);
		const wanted = expanded ? Math.min(element.scrollHeight, cap) : element.scrollHeight;
		element.style.height = `${Math.max(expanded ? Math.min(wanted, cap) : 24, 24)}px`;
		element.style.overflowY = expanded && element.scrollHeight > cap ? "auto" : "hidden";
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
