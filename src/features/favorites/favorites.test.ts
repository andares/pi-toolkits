/**
 * favorites feature — unit tests.
 *
 * Covers the logic that drives the patches:
 *  - store: toggle/has/count + JSON persistence round-trip + corruption fallback
 *  - cycle patch: favorites-only cycling (fallback to stock when disabled or
 *    no favorites; favorites-only pick; single-favorite jump; not-a-favorite
 *    → forward first / backward last)
 *  - selector patches: ctrl+j favorites-only filter, ctrl+a toggle, hint
 *    injection, idempotent apply, plain ctrl+f left to the host
 *
 * The patches read the shared store via getFavoritesStore(); each test gets an
 * isolated store backed by a temp file via setSharedFavoritesStore(). The
 * selector fake objects inherit the patched ModelSelectorComponent.prototype
 * (setPrototypeOf) so the patched methods resolve with `this` = the fake.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSession,
	initTheme,
	ModelSelectorComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	afterAll,
	beforeEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	FavoritesStore,
	getFavoritesStore,
	modelKey,
	setSharedFavoritesStore,
} from "./store.js";
import { applyCyclePatch } from "./patch-cycle.js";
import { styleFavorite } from "./constants.js";
import {
	applyModelSelectorPatches,
	runFilterModels,
	setSelectorThemeProvider,
} from "./patch-selector.js";

// ─── setup ───────────────────────────────────────────────────────

let tmpDir: string;
let storeSeq = 0;

beforeAll(() => {
	// Initialize pi's live theme proxy so rawKeyHint()/theme.fg() work in the
	// replicated updateList paths.
	initTheme("dark");
	// Fake theme for the selector patch's own rendering (only fg() is used).
	setSelectorThemeProvider(
		() => ({ fg: (_c: string, t: string) => t }) as unknown as Theme,
	);
	tmpDir = mkdtempSync(join(tmpdir(), "pi-toolkits-fav-"));
});

beforeEach(() => {
	storeSeq += 1;
	setSharedFavoritesStore(
		new FavoritesStore(join(tmpDir, `fav-${storeSeq}.json`)),
	);
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const models = [
	{ provider: "anthropic", id: "claude-sonnet-4" },
	{ provider: "anthropic", id: "claude-opus-4" },
	{ provider: "openrouter", id: "openai/gpt-5" },
];

function freshStoreFile(): string {
	storeSeq += 1;
	return join(tmpDir, `fav-${storeSeq}.json`);
}

// ─── store ───────────────────────────────────────────────────────

describe("FavoritesStore", () => {
	it("toggles, counts and keys by provider/id", () => {
		const store = new FavoritesStore(freshStoreFile());
		expect(store.has(models[0])).toBe(false);
		expect(store.toggle(models[0])).toBe(true);
		expect(store.has(models[0])).toBe(true);
		expect(store.count()).toBe(1);
		expect(store.toggle(models[0])).toBe(false);
		expect(store.count()).toBe(0);
	});

	it("persists across instances (file round-trip)", () => {
		const file = freshStoreFile();
		const a = new FavoritesStore(file);
		a.toggle(models[0]);
		a.toggle(models[1]);
		const b = new FavoritesStore(file);
		expect(b.has(models[0])).toBe(true);
		expect(b.has(models[1])).toBe(true);
		expect(b.has(models[2])).toBe(false);
		expect(b.count()).toBe(2);
	});

	it("falls back to empty + defaults on a corrupted file", () => {
		const file = freshStoreFile();
		// Intentionally write invalid JSON — the READ side must tolerate it.
		writeFileSync(file, "{ not json", "utf8");
		// Suppress the designed degradation log; the spy asserts it fired.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const store = new FavoritesStore(file);
			expect(store.count()).toBe(0);
			expect(store.getConfig().cycleOnlyFavorites).toBe(true);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("loads cycleOnlyFavorites config from disk", () => {
		const file = freshStoreFile();
		writeFileSync(
			file,
			JSON.stringify({
				favorites: ["anthropic/claude-sonnet-4"],
				config: { cycleOnlyFavorites: false },
			}),
			"utf8",
		);
		const store = new FavoritesStore(file);
		expect(store.has(models[0])).toBe(true);
		expect(store.getConfig().cycleOnlyFavorites).toBe(false);
	});

	it("writes a valid JSON file", () => {
		const file = freshStoreFile();
		const store = new FavoritesStore(file);
		store.toggle(models[0]);
		const raw = JSON.parse(readFileSync(file, "utf8")) as {
			favorites: string[];
		};
		expect(raw.favorites).toEqual([modelKey(models[0])]);
	});
});

// ─── cycle patch ─────────────────────────────────────────────────

interface FakeCycleSession {
	_scopedModels: Array<{
		model: (typeof models)[number];
		thinkingLevel?: string;
	}>;
	_modelRuntime: { getAvailableSnapshot(): (typeof models)[number][] };
	model: (typeof models)[number];
	agent: { state: { model: unknown } };
	sessionManager: {
		appendModelChange(provider: string, id: string): void;
		calls: Array<[string, string]>;
	};
	settingsManager: {
		setDefaultModelAndProvider(provider: string, id: string): void;
		calls: Array<[string, string]>;
	};
	setThinkingLevel(level: unknown): void;
	_getThinkingLevelForModelSwitch(explicit?: string): string;
	_cycleAvailableModel(direction: "forward" | "backward"): Promise<unknown>;
	_cycleScopedModel(direction: "forward" | "backward"): Promise<unknown>;
	_emitModelSelect(
		next: unknown,
		previous: unknown,
		source: "cycle",
	): Promise<void>;
	thinkingLevel: string;
	emitted: Array<{ next: unknown; previous: unknown; source: string }>;
}

type ModelLike = (typeof models)[number];

/** Stock cycle algorithm used by the real AgentSession (mirrored for the fake). */
function stockAvailableCycle(
	this: FakeCycleSession,
	direction: "forward" | "backward",
): Promise<unknown> {
	const available = this._modelRuntime.getAvailableSnapshot();
	if (available.length <= 1) return Promise.resolve(undefined);
	const current = this.model;
	let idx = available.findIndex(
		(m) => m.provider === current.provider && m.id === current.id,
	);
	if (idx === -1) idx = 0;
	const len = available.length;
	const nextIdx =
		direction === "forward" ? (idx + 1) % len : (idx - 1 + len) % len;
	const next = available[nextIdx];
	this.agent.state.model = next;
	this.sessionManager.appendModelChange(next.provider, next.id);
	this.settingsManager.setDefaultModelAndProvider(next.provider, next.id);
	const level = this._getThinkingLevelForModelSwitch();
	this.setThinkingLevel(level);
	return Promise.resolve({
		model: next,
		thinkingLevel: level,
		isScoped: false,
	});
}

function fakeSession(
	overrides: Partial<FakeCycleSession> = {},
): FakeCycleSession {
	const session = {
		_scopedModels: [],
		_modelRuntime: { getAvailableSnapshot: () => models },
		model: models[0],
		agent: { state: { model: models[0] } },
		sessionManager: {
			calls: [] as Array<[string, string]>,
			appendModelChange(
				this: { calls: Array<[string, string]> },
				provider: string,
				id: string,
			) {
				this.calls.push([provider, id]);
			},
		},
		settingsManager: {
			calls: [] as Array<[string, string]>,
			setDefaultModelAndProvider(
				this: { calls: Array<[string, string]> },
				provider: string,
				id: string,
			) {
				this.calls.push([provider, id]);
			},
		},
		setThinkingLevel(level: unknown) {
			(this as unknown as FakeCycleSession).thinkingLevel = level as string;
		},
		_getThinkingLevelForModelSwitch: (_explicit?: string) => "low",
		_cycleAvailableModel: stockAvailableCycle,
		_cycleScopedModel: stockAvailableCycle,
		_emitModelSelect(next: unknown, previous: unknown, source: "cycle") {
			this.emitted.push({ next, previous, source });
			return Promise.resolve();
		},
		thinkingLevel: "low",
		emitted: [] as FakeCycleSession["emitted"],
	} satisfies FakeCycleSession;
	return { ...session, ...overrides } as FakeCycleSession;
}

type PatchedCycle = (
	this: FakeCycleSession,
	direction?: "forward" | "backward",
) => Promise<
	{ model: ModelLike; thinkingLevel: string; isScoped: boolean } | undefined
>;

describe("cycle patch", () => {
	const originalCycleModel = AgentSession.prototype.cycleModel;

	it("applies once and wraps the original", () => {
		expect(applyCyclePatch()).toBe(true);
		expect(applyCyclePatch()).toBe(true); // idempotent
		expect(AgentSession.prototype.cycleModel).not.toBe(originalCycleModel);
	});

	it("falls back to stock cycling when no favorites exist", async () => {
		const patched = AgentSession.prototype
			.cycleModel as unknown as PatchedCycle;
		const result = await patched.call(fakeSession(), "forward");
		// Stock: sonnet-4 → opus-4 (next available model).
		expect(result?.model.id).toBe("claude-opus-4");
	});

	it("cycles only among favorites once favorites exist", async () => {
		getFavoritesStore().toggle(models[0]);
		getFavoritesStore().toggle(models[1]); // favorites: sonnet-4, opus-4 (gpt-5 excluded)
		const patched = AgentSession.prototype
			.cycleModel as unknown as PatchedCycle;
		const session = fakeSession({ model: models[1] }); // current = opus-4
		const result = await patched.call(session, "forward");
		expect(result?.model.id).toBe("claude-sonnet-4"); // wraps within favorites
		expect(session.emitted[0]?.source).toBe("cycle");
		expect(result?.isScoped).toBe(false);
	});

	it("jumps to first favorite forward / last backward when current is not a favorite", async () => {
		getFavoritesStore().toggle(models[1]);
		getFavoritesStore().toggle(models[2]); // favorites: opus-4, gpt-5; current = sonnet-4 (not fav)
		const patched = AgentSession.prototype
			.cycleModel as unknown as PatchedCycle;

		const forward = await patched.call(
			fakeSession({ model: models[0] }),
			"forward",
		);
		expect(forward?.model.id).toBe("claude-opus-4"); // first favorite

		const backward = await patched.call(
			fakeSession({ model: models[0] }),
			"backward",
		);
		expect(backward?.model.id).toBe("openai/gpt-5"); // last favorite
	});

	it("returns undefined when already on the only favorite", async () => {
		getFavoritesStore().toggle(models[0]);
		const patched = AgentSession.prototype
			.cycleModel as unknown as PatchedCycle;
		expect(
			await patched.call(fakeSession({ model: models[0] }), "forward"),
		).toBeUndefined();
	});

	it("respects cycleOnlyFavorites=false (falls back to stock)", async () => {
		const file = freshStoreFile();
		writeFileSync(
			file,
			JSON.stringify({
				favorites: [modelKey(models[0])],
				config: { cycleOnlyFavorites: false },
			}),
			"utf8",
		);
		setSharedFavoritesStore(new FavoritesStore(file));
		getFavoritesStore().toggle(models[1]); // ensure favorites exist
		const patched = AgentSession.prototype
			.cycleModel as unknown as PatchedCycle;
		const result = await patched.call(
			fakeSession({ model: models[0] }),
			"forward",
		);
		// Stock behavior: next available model, not favorites-only.
		expect(result?.model.id).toBe("claude-opus-4");
	});
});

// ─── selector patches ────────────────────────────────────────────

interface FakeSelector {
	children: unknown[];
	listContainer: { clear(): void; addChild(_c: unknown): void };
	searchInput: { getValue(): string; handleInput(_d: string): void };
	filteredModels: Array<{ provider: string; id: string; model: ModelLike }>;
	activeModels: Array<{ provider: string; id: string; model: ModelLike }>;
	selectedIndex: number;
	currentModel: ModelLike | undefined;
	tui: { requestRender(): void };
	__favoritesOnly?: boolean;
	__favoritesHint?: { setText(_t: string): void };
	handleInput(d: string): void;
	updateList(): void;
	filterModels(q: string, preferredModel?: ModelLike): void;
}

function item(model: ModelLike) {
	return { provider: model.provider, id: model.id, model };
}

function fakeSelector(overrides: Partial<FakeSelector> = {}): FakeSelector {
	const selector = {
		children: [] as unknown[],
		listContainer: { clear() {}, addChild() {} },
		searchInput: { getValue: () => "", handleInput: () => {} },
		filteredModels: [] as FakeSelector["filteredModels"],
		activeModels: [] as FakeSelector["activeModels"],
		selectedIndex: 0,
		currentModel: undefined,
		tui: { requestRender() {} },
		...overrides,
	};
	// Route methods through the patched prototype so the real patched
	// implementations run with `this` = the fake. IMPORTANT: the fake must NOT
	// have own handleInput/updateList/filterModels stubs — own properties
	// shadow the patched prototype methods.
	return Object.setPrototypeOf(
		selector,
		ModelSelectorComponent.prototype,
	) as unknown as FakeSelector;
}

describe("selector patches", () => {
	it("applies once and is idempotent", () => {
		expect(applyModelSelectorPatches()).toBe(true);
		expect(applyModelSelectorPatches()).toBe(true);
	});

	it("ctrl+j toggles the favorites-only filter and filters activeModels", () => {
		getFavoritesStore().toggle(models[0]);
		const selector = fakeSelector({
			activeModels: models.map(item),
			filteredModels: models.map(item),
		});
		selector.handleInput("\x0a"); // ctrl+j
		expect(selector.__favoritesOnly).toBe(true);
		// Original filterModels ran on the favorites subset:
		expect(selector.filteredModels.map((m) => m.id)).toEqual([
			"claude-sonnet-4",
		]);
		selector.handleInput("\x0a"); // toggle off
		expect(selector.__favoritesOnly).toBe(false);
		expect(selector.filteredModels).toHaveLength(3);
	});

	it("ctrl+a toggles favorite for the selected model", () => {
		const selector = fakeSelector({
			filteredModels: models.map(item),
			selectedIndex: 1, // opus-4
			activeModels: models.map(item),
		});
		selector.handleInput("\x01"); // ctrl+a
		expect(getFavoritesStore().has(models[1])).toBe(true);
		selector.handleInput("\x01");
		expect(getFavoritesStore().has(models[1])).toBe(false);
	});

	it("does not intercept the retired keys ctrl+f / ctrl+alt+f (host/machine-owned)", () => {
		const forwarded: string[] = [];
		getFavoritesStore().toggle(models[1]);
		const selector = fakeSelector({
			filteredModels: models.map(item),
			selectedIndex: 1,
			activeModels: models.map(item),
			searchInput: {
				getValue: () => "",
				handleInput: (d: string) => forwarded.push(d),
			},
		});
		selector.handleInput("\x06"); // stock ctrl+f — upstream transcript search
		selector.handleInput("\x1b\x06"); // retired ctrl+alt+f — machine-level hotkey
		// Both reached the search box instead of our toggle, so the store is unchanged.
		expect(forwarded).toEqual(["\x06", "\x1b\x06"]);
		expect(getFavoritesStore().has(models[1])).toBe(true);
	});

	it("injects the hint row once (children.length grows by exactly one)", () => {
		const selector = fakeSelector({
			children: [1, 2, 3, 4] as unknown[],
			activeModels: [],
			filteredModels: [],
		});
		selector.updateList(); // ensureFavoritesHint runs on first updateList
		selector.updateList();
		expect(selector.children).toHaveLength(5); // 4 + exactly 1 hint
		expect(selector.__favoritesHint).toBeDefined();
	});

	it("keeps non-favorites filter behavior when favorites-only is off", () => {
		getFavoritesStore().toggle(models[0]);
		const selector = fakeSelector({
			activeModels: models.map(item),
			filteredModels: models.map(item),
		});
		// No ctrl+j pressed: filterModels with a query keeps all models (stock path).
		selector.filterModels("claude");
		expect(selector.filteredModels.map((m) => m.id)).toEqual([
			"claude-sonnet-4",
			"claude-opus-4",
		]);
	});

	it("forwards pi 1.5.1's preferredModel through the favorites-only swap", () => {
		getFavoritesStore().toggle(models[0]);
		const calls: Array<[string, ModelLike | undefined, number]> = [];
		// Host-independent: the spy stands in for whatever the installed host
		// declares. 1.2.0–1.5.0 ignore the extra argument; 1.5.1+ use it.
		const original = function (
			this: FakeSelector,
			query: string,
			preferredModel?: ModelLike,
		) {
			calls.push([query, preferredModel, this.activeModels.length]);
		};
		const selector = fakeSelector({
			activeModels: models.map(item),
			__favoritesOnly: true,
		});
		runFilterModels(selector, original, "claude", models[1]);
		// One call, preferred model intact, and it ran on the one-entry subset…
		expect(calls).toEqual([["claude", models[1], 1]]);
		// …with the full list restored afterwards.
		expect(selector.activeModels).toHaveLength(3);
	});

	it("mirrors pi 1.5.0's disambiguating model name after the id", () => {
		// The name is shown only when it adds words the id does not convey
		// (pi's getDistinctModelName rule, copied — it is not exported).
		type LineItem = {
			provider: string;
			id: string;
			model: { provider: string; id: string; name?: string };
		};
		const redundant: LineItem = {
			provider: "anthropic",
			id: "claude-sonnet-4",
			model: { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
		};
		const renamed: LineItem = {
			provider: "openrouter",
			id: "minimax/minimax-m3",
			model: {
				provider: "openrouter",
				id: "minimax/minimax-m3",
				name: "MiniMax M3 [rasmus@openrouter, parasail]",
			},
		};
		const lines: string[] = [];
		const selector = fakeSelector({
			activeModels: [],
			filteredModels: [redundant, renamed] as unknown as FakeSelector["filteredModels"],
			listContainer: {
				clear() {},
				addChild: (child: unknown) =>
					lines.push((child as { text?: string }).text ?? ""),
			},
		});
		selector.updateList();
		const redundantLine = lines.find((l) => l.includes("claude-sonnet-4"));
		const renamedLine = lines.find((l) => l.includes("minimax/minimax-m3"));
		expect(redundantLine).toBeDefined();
		expect(redundantLine).not.toContain("(Claude Sonnet 4)");
		expect(renamedLine).toContain(
			"(MiniMax M3 [rasmus@openrouter, parasail])",
		);
		// The full line pins the 1.5.0 column order (id → name → provider badge)
		// and the favorite highlight not leaking ANSI codes into the name. The
		// two spaces after → are the (empty) current-marker column; the fake
		// selector has no currentModel, so no ✓ is drawn.
		expect(redundantLine).toBe("→   claude-sonnet-4 [anthropic]");
		expect(renamedLine).toBe(
			"    minimax/minimax-m3 (MiniMax M3 [rasmus@openrouter, parasail]) [openrouter]",
		);
	});

	it("keeps the favorite highlight while appending the disambiguating name", () => {
		// Regression guard: the 1.5.0 name text must land AFTER the styled id
		// (and outside its ANSI reset), or favorited ids would lose their color.
		const favoriteModel = {
			provider: "anthropic",
			id: "claude-opus-4",
			name: "Claude Opus 4 (max)",
		};
		getFavoritesStore().toggle(favoriteModel);
		const lines: string[] = [];
		const selector = fakeSelector({
			activeModels: [],
			filteredModels: [
				{ provider: favoriteModel.provider, id: favoriteModel.id, model: favoriteModel },
			] as unknown as FakeSelector["filteredModels"],
			listContainer: {
				clear() {},
				addChild: (child: unknown) =>
					lines.push((child as { text?: string }).text ?? ""),
			},
		});
		selector.updateList();
		expect(lines[0]).toBe(
			`→   ${styleFavorite("claude-opus-4")} (Claude Opus 4 (max)) [anthropic]`,
		);
	});
});
