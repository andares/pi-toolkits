/**
 * favorites feature — AgentSession.cycleModel patch.
 *
 * ctrl+p / ctrl+shift+p keep their keybindings (they are reserved built-ins
 * that extensions cannot rebind); instead we change the semantics of the
 * cycle itself. When `cycleOnlyFavorites` (default true) is set AND at least
 * one favorite exists, cycling is restricted to favorited models:
 *
 *  - candidates come from the same source stock cycling would use (scoped
 *    models if any, else the available-model snapshot), filtered to favorites
 *  - if the current model is not a favorite: forward jumps to the first
 *    favorite, backward to the last (user-confirmed)
 *  - with exactly one favorite, already on it → undefined (stock "only one
 *    model available" feedback); otherwise jump to it
 *  - the apply logic mirrors _cycleAvailableModel (state swap, session +
 *    settings persistence, thinking-level re-clamp, model_select emit with
 *    source "cycle")
 *
 * Version guard: missing cycleModel → warn and skip; the patch is idempotent
 * across /reload.
 */
import {
	AgentSession,
	type ModelCycleResult,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getFavoritesStore, modelKey } from "./store.js";

/**
 * Structural view of the AgentSession internals the patch touches.
 * AgentSession's members are TS-private (compile-time only), so this view is
 * safe to use as the patched method's `this` type at runtime.
 */
interface CycleSessionInternals {
// pi-lens-ignore: no-any-type, — pi's Model generic requires `any` (constraint is Api); pi itself uses Model<any> everywhere
_scopedModels: ReadonlyArray<{ model: Model<any>; thinkingLevel?: string }>;
// pi-lens-ignore: no-any-type, — same as above
_modelRuntime: { getAvailableSnapshot(): Model<any>[] };
// pi-lens-ignore: no-any-type, — same as above
model: Model<any>;
	agent: { state: { model: unknown } };
	sessionManager: { appendModelChange(provider: string, id: string): void };
	settingsManager: {
		setDefaultModelAndProvider(provider: string, id: string): void;
	};
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
	// pi-lens-ignore: no-any-type, — matches pi's Model<any> API
	model: Model<any>;
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

let patched = false;

/** Restrict ctrl+p cycling to favorites. Idempotent; returns false if skipped. */
export function applyCyclePatch(): boolean {
	if (patched) return true;
	const proto = AgentSession.prototype as unknown as {
		cycleModel(
			this: CycleSessionInternals,
			direction?: "forward" | "backward",
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
	): Promise<ModelCycleResult | undefined> {
		if (
			!getFavoritesStore().getConfig().cycleOnlyFavorites ||
			!getFavoritesStore().hasAny()
		) {
			return original.call(this, direction);
		}

		const scoped = this._scopedModels.length > 0;
		const candidates: CycleCandidate[] = scoped
			? this._scopedModels.map((sm) => ({
					model: sm.model,
					thinkingLevel: sm.thinkingLevel,
				}))
			: this._modelRuntime
					.getAvailableSnapshot()
					.map((model) => ({ model, thinkingLevel: undefined }));
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
		this.settingsManager.setDefaultModelAndProvider(
			next.model.provider,
			next.model.id,
		);
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
