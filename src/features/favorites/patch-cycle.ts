/**
 * favorites feature — AgentSession.cycleModel patch.
 *
 * ctrl+p / ctrl+shift+p keep their keybindings (they are reserved built-ins
 * that extensions cannot rebind); instead we change the semantics of the
 * cycle itself. When `cycleOnlyFavorites` (default true) is set AND at least
 * one favorite exists, cycling is restricted to favorited models:
 *
 *  - candidates come from the same source stock cycling would use (scoped
 *    models if any — filtered to currently available ones like stock —
 *    else the available-model snapshot), filtered to favorites
 *  - if the current model is not a favorite: forward jumps to the first
 *    favorite, backward to the last (user-confirmed)
 *  - with exactly one favorite, already on it → undefined (stock "only one
 *    model available" feedback); otherwise jump to it
 *  - the apply logic mirrors pi 0.87's _cycleScopedModel/_cycleAvailableModel
 *    (state swap, session persistence, default-model persistence only when
 *    `options.persist` is set, thinking-level re-clamp, model_select emit
 *    with source "cycle")
 *
 * Version guard: missing cycleModel → warn and skip; the patch is idempotent
 * across /reload.
 */
import {
	AgentSession,
	type ModelCycleResult,
} from "@earendil-works/pi-coding-agent";
import { getFavoritesStore, modelKey } from "./store.js";

/**
 * pi's `Model<any>` — the exact type of `ModelCycleResult.model` in
 * pi-coding-agent 0.87. Derived here instead of importing `Model` from
 * @earendil-works/pi-ai, whose 0.87 index.d.ts re-exports it via an
 * extensioned `"./types.ts"` specifier that not every TS resolver substitutes
 * to `types.d.ts` (tsc 5.9 bundler does; other tsserver builds don't).
 */
type AnyModel = NonNullable<ModelCycleResult>["model"];

/**
 * Structural view of the AgentSession internals the patch touches.
 * AgentSession's members are TS-private (compile-time only), so this view is
 * safe to use as the patched method's `this` type at runtime.
 */
interface CycleSessionInternals {
	// pi-lens-ignore: no-any-type, — pi's Model generic requires `any` (constraint is Api); pi itself uses Model<any> everywhere
	_scopedModels: ReadonlyArray<{ model: AnyModel; thinkingLevel?: string }>;
	// pi-lens-ignore: no-any-type, — same as above
	_modelRuntime: { getAvailableSnapshot(): AnyModel[] };
	// pi-lens-ignore: no-any-type, — same as above
	model: AnyModel;
	agent: { state: { model: unknown } };
	sessionManager: { appendModelChange(provider: string, id: string): void };
	settingsManager: {
		setDefaultModelAndProvider(provider: string, id: string): void;
	};
	/**
	 * pi 0.87: keeps a persisted default usable when cycling inside a
	 * non-empty --models scope.
	 */
	_addPersistedDefaultToNonEmptyScope(model: unknown): void;
	setThinkingLevel(level: unknown): void;
	_getThinkingLevelForModelSwitch(
		explicitLevel?: string,
	): ModelCycleResult["thinkingLevel"] | undefined;
	_emitModelSelect(
		next: unknown,
		previous: unknown,
		source: "cycle",
	): Promise<void>;
	thinkingLevel: ModelCycleResult["thinkingLevel"];
}

interface CycleCandidate {
	model: AnyModel;
	thinkingLevel?: string;
}

/**
 * Index of the next favorite to cycle to.
 *
 * When the current model is not a favorite (`currentIndex === -1`), forward
 * jumps to the first favorite and backward to the last (user-confirmed
 * behavior); otherwise standard wrap-around modulo arithmetic applies.
 */
function nextCycleIndex(
	currentIndex: number,
	direction: "forward" | "backward",
	len: number,
): number {
	if (currentIndex === -1) {
		return direction === "forward" ? 0 : len - 1;
	}
	return direction === "forward"
		? (currentIndex + 1) % len
		: (currentIndex - 1 + len) % len;
}

/** Options accepted by pi 0.87's cycleModel (persist gates default-model persistence). */
interface CycleOptions {
	persist?: boolean;
}

let patched = false;

/** Restrict ctrl+p cycling to favorites. Idempotent; returns false if skipped. */
export function applyCyclePatch(): boolean {
	if (patched) return true;
	// SAFETY: AgentSession's members are TS-private (compile-time only), so a
	// structural view of the runtime prototype is safe to cast to; guarded by
	// the typeof check below before any patching happens.
	const proto = AgentSession.prototype as unknown as {
		cycleModel(
			this: CycleSessionInternals,
			direction?: "forward" | "backward",
			options?: CycleOptions,
		): Promise<ModelCycleResult | undefined>;
	};
	if (typeof proto.cycleModel !== "function") {
		// pi-lens-ignore: no-console-except-error,console-statement, — intentional degradation log
		console.warn(
			"[pi-toolkits/favorites] AgentSession.cycleModel missing; cycle patch skipped.",
		);
		return false;
	}
	patched = true;
	const original = proto.cycleModel;

	proto.cycleModel = async function (
		this: CycleSessionInternals,
		direction: "forward" | "backward" = "forward",
		options: CycleOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (
			!getFavoritesStore().getConfig().cycleOnlyFavorites ||
			!getFavoritesStore().hasAny()
		) {
			return original.call(this, direction, options);
		}

		// Same source and availability filtering as pi 0.87's stock cycling.
		const scoped = this._scopedModels.length > 0;
		let candidates: CycleCandidate[];
		if (scoped) {
			const availableIds = new Set(
				this._modelRuntime
					.getAvailableSnapshot()
					.map((model) => `${model.provider}\0${model.id}`),
			);
			candidates = this._scopedModels.flatMap((sm) =>
				availableIds.has(`${sm.model.provider}\0${sm.model.id}`)
					? [{ model: sm.model, thinkingLevel: sm.thinkingLevel }]
					: [],
			);
		} else {
			candidates = this._modelRuntime
				.getAvailableSnapshot()
				.map((model) => ({ model, thinkingLevel: undefined }));
		}
		const favorites = candidates.filter((candidate) =>
			getFavoritesStore().has(candidate.model),
		);
		if (favorites.length === 0) {
			// No favorites among the current source — fall back to stock cycling.
			return original.call(this, direction);
		}

		const current = this.model;
		const currentIndex = favorites.findIndex(
			(candidate) => modelKey(candidate.model) === modelKey(current),
		);

		// Already on the only favorite — nothing to cycle to.
		if (currentIndex !== -1 && favorites.length === 1) {
			return undefined;
		}
		const nextIndex = nextCycleIndex(currentIndex, direction, favorites.length);

		const next = favorites[nextIndex];
		const thinkingLevel =
			scoped && next.thinkingLevel !== undefined
				? this._getThinkingLevelForModelSwitch(next.thinkingLevel)
				: this._getThinkingLevelForModelSwitch();
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		// pi 0.87: only persist the default model when the caller asked for it.
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(
				next.model.provider,
				next.model.id,
			);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}
		this.setThinkingLevel(thinkingLevel);
		await this._emitModelSelect(next.model, current, "cycle");
		return {
			model: next.model,
			thinkingLevel: this.thinkingLevel,
			isScoped: scoped,
		};
	};

	return true;
}
