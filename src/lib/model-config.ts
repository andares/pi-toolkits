/**
 * Shared model-config helpers for features that persist a "provider/id"
 * model key and resolve it against the currently available model list
 * (review, compact-model — favorites keeps its own store-local key logic).
 *
 * Types are derived from pi-coding-agent's own exports (ModelRegistry)
 * rather than imported from @earendil-works/pi-ai: pi-ai 0.87's index.d.ts
 * re-exports `Model`/`Api` via extensioned `./types.ts` specifiers, which
 * tsc 5.9 bundler resolution substitutes to `.d.ts` but some tsserver
 * builds do not. Deriving from ModelRegistry keeps every resolver in
 * agreement with the exact type `ctx.modelRegistry.getAvailable()` returns.
 */
import type {
	ExtensionContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";

/** The model type pi's ModelRegistry exposes (`Model<Api>`). */
export type AvailableModel = ReturnType<ModelRegistry["getAvailable"]>[number];

/** Model identity used as a persisted config key: "provider/id". */
export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Resolve a persisted "provider/id" key against the available model list.
 * Ids may themselves contain slashes (e.g. openrouter/openai/gpt-5), so only
 * the first slash splits provider from id. Returns undefined for missing,
 * malformed, or currently-unavailable keys.
 */
export function resolveConfiguredModel(
	ctx: ExtensionContext,
	key: string | undefined,
): AvailableModel | undefined {
	if (!key) return undefined;
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return undefined;
	const provider = key.slice(0, slash);
	const id = key.slice(slash + 1);
	return ctx.modelRegistry
		.getAvailable()
		.find((m) => m.provider === provider && m.id === id);
}
