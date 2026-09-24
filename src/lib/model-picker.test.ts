/**
 * model-picker — tests.
 *
 * Mocks ModelSelectorComponent (the real built-in /model component) to
 * capture how openModelPicker drives it: the preselected currentModel, the
 * modelRuntime facade wiring over the registry, and select/cancel
 * resolution. The preselection + scrolling list behavior itself belongs to
 * pi's component (covered by pi) — here we assert OUR wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AvailableModel } from "./model-config.js";
import { openModelPicker } from "./model-picker.js";

const { instances } = vi.hoisted(() => ({
	instances: [] as Array<{
		currentModel: unknown;
		modelRuntime: unknown;
		onSelect: (model: unknown) => void;
		onCancel: () => void;
	}>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	class FakeSelector {
		currentModel: unknown;
		modelRuntime: unknown;
		onSelect: (model: unknown) => void;
		onCancel: () => void;
		constructor(
			_tui: unknown,
			currentModel: unknown,
			modelRuntime: unknown,
			_scopedModels: unknown,
			onSelect: (model: unknown) => void,
			onCancel: () => void,
		) {
			this.currentModel = currentModel;
			this.modelRuntime = modelRuntime;
			this.onSelect = onSelect;
			this.onCancel = onCancel;
			instances.push(this);
		}
		dispose(): void {}
	}
	return { ...actual, ModelSelectorComponent: FakeSelector };
});

function fakeModel(provider: string, id: string, name = id): AvailableModel {
	return {
		id,
		name,
		provider,
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as AvailableModel;
}

const MODELS: AvailableModel[] = [
	fakeModel("google", "gemini-2.5-flash", "Gemini 2.5 Flash"),
	fakeModel("anthropic", "claude-sonnet-4", "Claude Sonnet 4"),
];

function fakeCtx(models: AvailableModel[] = MODELS) {
	const notify = vi.fn();
	const custom = vi.fn((factory: (...args: unknown[]) => unknown) => {
		// Mimic pi's mounting: the factory runs, constructing the component;
		// the component's done() callback resolves the dialog.
		return new Promise((resolve) => {
			factory(
				{ requestRender: vi.fn() },
				undefined,
				undefined,
				(result: unknown) => resolve(result),
			);
		});
	});
	const select = vi.fn(async () => undefined as string | undefined);
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: undefined,
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) =>
				models.find((m) => m.provider === provider && m.id === id),
			getError: () => undefined,
			refresh: async () => ({ aborted: false, errors: new Map() }),
		},
		ui: { notify, custom, select },
	} as unknown as ExtensionContext;
	return { ctx, notify, custom, select };
}

describe("openModelPicker", () => {
	beforeEach(() => {
		instances.length = 0;
	});

	it("resolves undefined without dialogs when the UI cannot pick", async () => {
		const { ctx, custom } = fakeCtx();
		(ctx as { hasUI: boolean }).hasUI = false;
		expect(await openModelPicker(ctx)).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});

	it("notifies when no models are available", async () => {
		const { ctx, notify } = fakeCtx([]);
		expect(await openModelPicker(ctx)).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("没有可用模型"),
			"error",
		);
	});

	it("preselects the current model as the component's currentModel", async () => {
		const { ctx } = fakeCtx();
		const promise = openModelPicker(ctx, MODELS[1]);
		const selector = instances.at(-1)!;
		expect(selector.currentModel).toBe(MODELS[1]);
		selector.onSelect(MODELS[0]);
		expect(await promise).toBe(MODELS[0]);
	});

	it("falls back to the session model when nothing is configured", async () => {
		const { ctx } = fakeCtx();
		const sessionModel = MODELS[0];
		(ctx as { model: unknown }).model = sessionModel;
		const promise = openModelPicker(ctx);
		const selector = instances.at(-1)!;
		expect(selector.currentModel).toBe(sessionModel);
		selector.onCancel();
		expect(await promise).toBeUndefined();
	});

	it("backs the component with a modelRuntime facade over the registry", async () => {
		const { ctx } = fakeCtx();
		const promise = openModelPicker(ctx, MODELS[0]);
		const selector = instances.at(-1)!;
		const runtime = selector.modelRuntime as {
			getAvailableSnapshot(): AvailableModel[];
			getModel(p: string, id: string): AvailableModel | undefined;
			getError(): string | undefined;
			refresh(o?: {
				signal?: AbortSignal;
			}): Promise<{ aborted: boolean; errors: Map<string, Error> }>;
		};
		expect(runtime.getAvailableSnapshot()).toEqual(MODELS);
		expect(runtime.getModel("google", "gemini-2.5-flash")).toBe(MODELS[0]);
		expect(runtime.getError()).toBeUndefined();
		await expect(runtime.refresh()).resolves.toEqual({
			aborted: false,
			errors: new Map(),
		});
		selector.onCancel();
		await promise;
	});

	it("falls back to the host selector in rpc mode (default first)", async () => {
		const { ctx, custom, select } = fakeCtx();
		(ctx as { mode: string }).mode = "rpc";
		select.mockResolvedValue("Claude Sonnet 4 (anthropic/claude-sonnet-4)");
		const picked = await openModelPicker(ctx, MODELS[1]);
		expect(custom).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledWith(
			"选择模型（首项为当前默认，回车使用）",
			[
				"Claude Sonnet 4 (anthropic/claude-sonnet-4)",
				"Gemini 2.5 Flash (google/gemini-2.5-flash)",
			],
		);
		expect(picked).toBe(MODELS[1]);
	});

	it("uses the provided select title in rpc mode and treats cancel as undefined", async () => {
		const { ctx, select } = fakeCtx();
		(ctx as { mode: string }).mode = "rpc";
		select.mockResolvedValue(undefined);
		expect(
			await openModelPicker(ctx, MODELS[0], { selectTitle: "选择评审模型" }),
		).toBeUndefined();
		expect(select).toHaveBeenCalledWith("选择评审模型", expect.any(Array));
	});
});
