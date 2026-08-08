/**
 * favorites feature — ModelSelectorComponent patches.
 *
 * pi's extension API has no hook to render inside the built-in model
 * selector, so we patch the component prototype at runtime. Three hooks:
 *
 *  1. handleInput  — intercept ctrl+f (toggle favorite for the selected
 *                    model) and ctrl+j (toggle "only favorites" filter)
 *                    BEFORE the original forwards them to the search box.
 *                    Scoped to the selector: outside it, ctrl+f/ctrl+j keep
 *                    pi's default editor bindings untouched.
 *  2. updateList   — inject a hint row at the top of the selector and render
 *                    favorited model ids in bold bright yellow.
 *  3. filterModels — when "only favorites" is on, temporarily swap
 *                    activeModels for the favorites subset so the original
 *                    fuzzy-filter/selection logic runs on it (zero
 *                    duplication); every path (search typing, scope toggle,
 *                    catalog refresh) converges here.
 *
 * Version guard: if the prototype no longer has the expected methods (pi
 * upgraded internals), patches are skipped with a warning — the extension
 * keeps loading and ctrl+p falls back to stock behavior.
 */
import {
	ModelSelectorComponent,
	rawKeyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import {
	FAVORITES_ONLY_KEY,
	FAVORITE_TOGGLE_KEY,
	styleFavorite,
} from "./constants.js";
import { getFavoritesStore } from "./store.js";

/** Minimal structural views of the built-in internals we touch. */
interface ModelRef {
	provider: string;
	id: string;
	name?: string;
}
interface ModelItem {
	provider: string;
	id: string;
	model: ModelRef;
}
interface SearchInputLike {
	getValue(): string;
}
interface ListContainerLike {
	clear(): void;
	addChild(child: unknown): void;
}

/** The patched prototype surface (public structural view, no private clash). */
interface SelectorPatchTarget {
	handleInput(keyData: string): void;
	updateList(): void;
	filterModels(query: string): void;
	listContainer: ListContainerLike;
	searchInput: SearchInputLike;
	filteredModels: ModelItem[];
	activeModels: ModelItem[];
	selectedIndex: number;
	currentModel: ModelRef | undefined;
	errorMessage?: string;
	refreshStatusMessage?: string;
	refreshStatusSuccess?: boolean;
	tui: { requestRender(): void };
	children: unknown[];
	// favorites state injected onto instances
	__favoritesOnly?: boolean;
	__favoritesHint?: Text;
	ensureFavoritesHint(): void;
	handleFavoriteToggle(): void;
	toggleFavoritesOnly(): void;
}

let themeProvider: () => Theme | undefined = () => undefined;

/** Called by registerFavorites once the live theme proxy is available. */
export function setSelectorThemeProvider(
	provider: () => Theme | undefined,
): void {
	themeProvider = provider;
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function buildHintText(state: SelectorPatchTarget): string {
	const theme = themeProvider();
	if (!theme) return "";
	const keys = `${rawKeyHint(FAVORITE_TOGGLE_KEY, "favorite")} · ${rawKeyHint(FAVORITES_ONLY_KEY, "only-favorites")}`;
	const mode = state.__favoritesOnly
		? theme.fg("success", " [ON]")
		: theme.fg("muted", " [OFF]");
	const count = getFavoritesStore().count();
	const countText = theme.fg(
		"dim",
		count > 0 ? ` · ${count} favorited` : " · none favorited",
	);
	return theme.fg("muted", "Favorites: ") + keys + mode + countText;
}

let patched = false;

/** Apply the three selector patches. Idempotent; returns false if skipped. */
export function applyModelSelectorPatches(): boolean {
	if (patched) return true;
	const proto =
		ModelSelectorComponent.prototype as unknown as SelectorPatchTarget;
	if (
		typeof proto.handleInput !== "function" ||
		typeof proto.updateList !== "function" ||
		typeof proto.filterModels !== "function"
	) {
		// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
		console.warn(
			"[pi-toolkits/favorites] ModelSelectorComponent API changed; model selector patches skipped.",
		);
		return false;
	}
	patched = true;

	const originalHandleInput = proto.handleInput;
	const originalUpdateList = proto.updateList;
	const originalFilterModels = proto.filterModels;

	// ── 1. Key interception (ctrl+f / ctrl+j) ─────────────────────────────
	proto.handleInput = function (
		this: SelectorPatchTarget,
		keyData: string,
	): void {
		if (matchesKey(keyData, FAVORITE_TOGGLE_KEY)) {
			this.handleFavoriteToggle();
			return;
		}
		if (matchesKey(keyData, FAVORITES_ONLY_KEY)) {
			this.toggleFavoritesOnly();
			return;
		}
		originalHandleInput.call(this, keyData);
	};

	// ── 2. List rendering: hint row + bold bright yellow favorites ────────
	// Replicates the built-in updateList layout (current-model check, selected
	// row, scroll indicator, empty/error states, refresh status) with one
	// change: favorited model ids render in the favorite style.
	proto.updateList = function (this: SelectorPatchTarget): void {
		const theme = themeProvider();
		if (!theme) {
			// Degraded path (theme not captured yet / non-TUI): stock rendering.
			originalUpdateList.call(this);
			return;
		}
		this.ensureFavoritesHint();
		const list = this.listContainer;
		list.clear();
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				this.filteredModels.length - maxVisible,
			),
		);
		const endIndex = Math.min(
			startIndex + maxVisible,
			this.filteredModels.length,
		);
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const isCurrent =
				this.currentModel !== undefined &&
				sameModel(item.model, this.currentModel);
			const isFavorite = getFavoritesStore().has(item.model);
			let line: string;
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = isFavorite
					? styleFavorite(item.id)
					: theme.fg("accent", item.id);
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${prefix + modelText} ${providerBadge}${checkmark}`;
			} else {
				const modelText = isFavorite
					? `  ${styleFavorite(item.id)}`
					: `  ${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${modelText} ${providerBadge}${checkmark}`;
			}
			list.addChild(new Text(line, 0, 0));
		}
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg(
				"muted",
				`  (${this.selectedIndex + 1}/${this.filteredModels.length})`,
			);
			list.addChild(new Text(scrollInfo, 0, 0));
		}
		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) {
				list.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			list.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			list.addChild(new Spacer(1));
			list.addChild(
				new Text(
					theme.fg("muted", `  Model Name: ${selected.model.name}`),
					0,
					0,
				),
			);
		}
		if (this.refreshStatusMessage) {
			list.addChild(new Spacer(1));
			list.addChild(
				new Text(
					theme.fg(
						this.refreshStatusSuccess ? "success" : "muted",
						`  ${this.refreshStatusMessage}`,
					),
					0,
					0,
				),
			);
		}
	};

	// ── 3. "Only favorites" filter ────────────────────────────────────────
	// Swap activeModels for the favorites subset around the original call so
	// the built-in fuzzy-filter + selection-index logic runs on the subset.
	proto.filterModels = function (
		this: SelectorPatchTarget,
		query: string,
	): void {
		if (this.__favoritesOnly) {
			const saved = this.activeModels;
			this.activeModels = saved.filter((item) =>
				getFavoritesStore().has(item.model),
			);
			try {
				originalFilterModels.call(this, query);
			} finally {
				this.activeModels = saved;
			}
		} else {
			originalFilterModels.call(this, query);
		}
	};

	// ── helpers injected onto the prototype ───────────────────────────────
	proto.ensureFavoritesHint = function (this: SelectorPatchTarget): void {
		if (this.__favoritesHint) return;
		const theme = themeProvider();
		if (!theme) return;
		const hint = new Text(buildHintText(this), 0, 0);
		// children: [0]=top border, [1]=spacer, then provider/scope hint rows…
		this.children.splice(2, 0, hint);
		this.__favoritesHint = hint;
	};

	proto.handleFavoriteToggle = function (this: SelectorPatchTarget): void {
		const selected = this.filteredModels[this.selectedIndex];
		if (!selected) return;
		const nowFavorite = getFavoritesStore().toggle(selected.model);
		if (this.__favoritesHint) {
			this.__favoritesHint.setText(buildHintText(this));
		}
		if (this.__favoritesOnly && !nowFavorite) {
			// Un-favorited while the favorites-only filter is on: drop it from
			// the list immediately.
			this.filterModels(this.searchInput.getValue());
		} else {
			this.updateList();
		}
		this.tui.requestRender();
	};

	proto.toggleFavoritesOnly = function (this: SelectorPatchTarget): void {
		this.__favoritesOnly = !this.__favoritesOnly;
		if (this.__favoritesHint) {
			this.__favoritesHint.setText(buildHintText(this));
		}
		this.filterModels(this.searchInput.getValue());
		this.tui.requestRender();
	};

	return true;
}
