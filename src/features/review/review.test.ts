/**
 * review feature — unit tests.
 *
 * Covers the logic behind the third-review command:
 *  - store: set/get persistence round-trip + corrupted-file fallback
 *  - modelKey / resolveConfiguredModel: provider/id resolution, incl. ids
 *    that themselves contain "/" (e.g. openrouter/openai/gpt-5)
 *  - createReviewRunner: busy guard, configured-model path, no-config /
 *    stale-config select path (persist + run), cancel path, setModel
 *    failure, reentrancy
 *
 * The runner reads the shared store via getReviewStore(); each test gets an
 * isolated store backed by a temp file via setSharedReviewStore(). pi and
 * ctx are minimal fakes (vi.fn()).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	createReviewRunner,
	pickReviewModel,
} from "./index.js";
import {
	modelKey,
	resolveConfiguredModel,
	type AvailableModel,
} from "../../lib/model-config.js";
import { REVIEW_PROMPT } from "./prompt.js";
import {
	ReviewStore,
	getReviewStore,
	setSharedReviewStore,
} from "./store.js";

// ─── fakes & setup ─────────────────────────────────────────────

let tmpDir: string;
let storeSeq = 0;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-toolkits-review-"));
});

beforeEach(() => {
	storeSeq += 1;
	setSharedReviewStore(
		new ReviewStore(join(tmpDir, `review-${storeSeq}.json`)),
	);
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function freshStoreFile(): string {
	storeSeq += 1;
	return join(tmpDir, `review-${storeSeq}.json`);
}

function fakeModel(provider: string, id: string, name = id): Model<Api> {
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
	};
}

const MODELS: Model<Api>[] = [
	fakeModel("anthropic", "claude-sonnet-4", "Claude Sonnet 4"),
	fakeModel("anthropic", "claude-opus-4", "Claude Opus 4"),
	fakeModel("openrouter", "openai/gpt-5", "GPT-5"),
];

function fakeCtx(
	overrides: {
		idle?: boolean;
		models?: Model<Api>[];
		mode?: string;
		hasUI?: boolean;
		customResult?: AvailableModel | undefined;
		selectResult?: string | undefined;
	} = {},
) {
	const notify = vi.fn();
	const custom = vi.fn(async () => overrides.customResult);
	const select = vi.fn(async () => overrides.selectResult);
	const ctx = {
		mode: overrides.mode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		isIdle: () => overrides.idle ?? true,
		modelRegistry: {
			getAvailable: () => overrides.models ?? MODELS,
		} as unknown as ModelRegistry,
		ui: { notify, custom, select },
	} as unknown as ExtensionContext;
	return { ctx, notify, custom, select };
}

function fakePi(switched = true) {
	const setModel = vi.fn(async () => switched);
	const sendUserMessage = vi.fn();
	const pi = { setModel, sendUserMessage } as unknown as ExtensionAPI;
	return { pi, setModel, sendUserMessage };
}

// ─── model key & resolution ────────────────────────────────────

describe("modelKey", () => {
	it("joins provider and id with a slash", () => {
		expect(modelKey({ provider: "anthropic", id: "claude-sonnet-4" })).toBe(
			"anthropic/claude-sonnet-4",
		);
	});

	it("keeps slashes inside the id (openrouter-style ids)", () => {
		expect(modelKey({ provider: "openrouter", id: "openai/gpt-5" })).toBe(
			"openrouter/openai/gpt-5",
		);
	});
});

describe("resolveConfiguredModel", () => {
	it("resolves a configured key to the available model", () => {
		const { ctx } = fakeCtx();
		expect(resolveConfiguredModel(ctx, "anthropic/claude-sonnet-4")).toBe(
			MODELS[0],
		);
	});

	it("resolves ids that contain a slash (split on the FIRST slash)", () => {
		const { ctx } = fakeCtx();
		expect(resolveConfiguredModel(ctx, "openrouter/openai/gpt-5")).toBe(
			MODELS[2],
		);
	});

	it("returns undefined when nothing is configured", () => {
		const { ctx } = fakeCtx();
		expect(resolveConfiguredModel(ctx, undefined)).toBeUndefined();
	});

	it("returns undefined when the configured model is gone from the registry", () => {
		const { ctx } = fakeCtx();
		// e.g. deleted from pi's models.json after being configured
		expect(
			resolveConfiguredModel(ctx, "anthropic/claude-opus-4-5"),
		).toBeUndefined();
	});

	it("returns undefined for malformed keys", () => {
		const { ctx } = fakeCtx();
		expect(resolveConfiguredModel(ctx, "no-slash")).toBeUndefined();
		expect(resolveConfiguredModel(ctx, "anthropic/")).toBeUndefined();
		expect(resolveConfiguredModel(ctx, "/claude-sonnet-4")).toBeUndefined();
	});
});

// ─── store ─────────────────────────────────────────────────────

describe("ReviewStore", () => {
	it("set/get round-trips within one instance", () => {
		const store = new ReviewStore(freshStoreFile());
		expect(store.getModel()).toBeUndefined();
		store.setModel("anthropic/claude-sonnet-4");
		expect(store.getModel()).toBe("anthropic/claude-sonnet-4");
	});

	it("persists across instances (file round-trip)", () => {
		const file = freshStoreFile();
		const a = new ReviewStore(file);
		a.setModel("openrouter/openai/gpt-5");
		const b = new ReviewStore(file);
		expect(b.getModel()).toBe("openrouter/openai/gpt-5");
	});

	it("clears the configured model with undefined", () => {
		const store = new ReviewStore(freshStoreFile());
		store.setModel("anthropic/claude-sonnet-4");
		store.setModel(undefined);
		expect(store.getModel()).toBeUndefined();
	});

	it("falls back to unset on a corrupted file", () => {
		const file = freshStoreFile();
		writeFileSync(file, "{ not json", "utf8");
		// Suppress the designed degradation log; the spy asserts it fired.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(new ReviewStore(file).getModel()).toBeUndefined();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("ignores a stored value without a slash", () => {
		const file = freshStoreFile();
		writeFileSync(file, JSON.stringify({ model: "no-slash-here" }), "utf8");
		expect(new ReviewStore(file).getModel()).toBeUndefined();
	});

	it("notifies subscribers on set", () => {
		const store = new ReviewStore(freshStoreFile());
		const listener = vi.fn();
		store.subscribe(listener);
		store.setModel("anthropic/claude-sonnet-4");
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

// ─── pickReviewModel ───────────────────────────────────────────

describe("pickReviewModel", () => {
	it("opens the picker and persists the picked model", async () => {
		const store = new ReviewStore(freshStoreFile());
		const { ctx, custom } = fakeCtx({ customResult: MODELS[2] });
		const picked = await pickReviewModel(ctx, store);
		expect(picked).toBe(MODELS[2]);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(store.getModel()).toBe("openrouter/openai/gpt-5");
	});

	it("returns undefined and does not persist when cancelled", async () => {
		const store = new ReviewStore(freshStoreFile());
		const { ctx, custom } = fakeCtx({ customResult: undefined });
		expect(await pickReviewModel(ctx, store)).toBeUndefined();
		expect(custom).toHaveBeenCalledTimes(1);
		expect(store.getModel()).toBeUndefined();
	});

	it("fails gracefully when no models are available", async () => {
		const { ctx, notify, custom } = fakeCtx({ models: [] });
		const store = new ReviewStore(freshStoreFile());
		expect(await pickReviewModel(ctx, store)).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("没有可用模型"),
			"error",
		);
	});

	it("refuses when no dialog-capable UI is available", async () => {
		const { ctx, notify, custom } = fakeCtx({ hasUI: false });
		const store = new ReviewStore(freshStoreFile());
		expect(await pickReviewModel(ctx, store)).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("不支持模型选择对话框"),
			"error",
		);
	});

	it("works in rpc mode via the host selector", async () => {
		const store = new ReviewStore(freshStoreFile());
		const { ctx, custom, select } = fakeCtx({
			mode: "rpc",
			selectResult: "Claude Opus 4 (anthropic/claude-opus-4)",
		});
		const picked = await pickReviewModel(ctx, store);
		expect(picked).toBe(MODELS[1]);
		// rpc cannot host custom components — the host renders select instead.
		expect(custom).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(store.getModel()).toBe("anthropic/claude-opus-4");
	});

	it("keeps the config untouched when cancelled", async () => {
		const store = new ReviewStore(freshStoreFile());
		store.setModel("anthropic/claude-opus-4");
		const { ctx, custom } = fakeCtx({ customResult: undefined });
		await pickReviewModel(ctx, store);
		expect(custom).toHaveBeenCalledTimes(1);
		// Cancelling a change keeps the existing config.
		expect(store.getModel()).toBe("anthropic/claude-opus-4");
	});

	it("warns when the configured model is unavailable", async () => {
		const store = new ReviewStore(freshStoreFile());
		store.setModel("anthropic/claude-opus-4-5"); // deleted in pi
		const { ctx, notify } = fakeCtx({ customResult: undefined });
		await pickReviewModel(ctx, store);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("不存在或不可用"),
			"warning",
		);
	});

	it("re-picking the configured model does not rewrite the store", async () => {
		const store = new ReviewStore(freshStoreFile());
		store.setModel("anthropic/claude-opus-4");
		const spy = vi.spyOn(store, "setModel");
		const { ctx } = fakeCtx({ customResult: MODELS[1] });
		const picked = await pickReviewModel(ctx, store);
		expect(picked).toBe(MODELS[1]);
		expect(spy).not.toHaveBeenCalled();
	});

	it("persists and confirms when a different model is picked", async () => {
		const store = new ReviewStore(freshStoreFile());
		store.setModel("anthropic/claude-opus-4");
		const { ctx, notify } = fakeCtx({ customResult: MODELS[2] });
		const picked = await pickReviewModel(ctx, store);
		expect(picked).toBe(MODELS[2]);
		expect(store.getModel()).toBe("openrouter/openai/gpt-5");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("已保存为"),
			"info",
		);
	});
});

// ─── createReviewRunner ────────────────────────────────────────

describe("createReviewRunner", () => {
	it("refuses to run while the agent is streaming", async () => {
		const { pi } = fakePi();
		const { ctx, notify } = fakeCtx({ idle: false });
		await createReviewRunner(pi)(ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("等待完成"),
			"warning",
		);
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("shows the picker and runs on the configured model when accepted", async () => {
		getReviewStore().setModel("anthropic/claude-sonnet-4");
		const { pi, setModel, sendUserMessage } = fakePi();
		const { ctx, notify, custom } = fakeCtx({ customResult: MODELS[0] });
		await createReviewRunner(pi)(ctx);
		// The picker is always shown, even with a configured model.
		expect(custom).toHaveBeenCalledTimes(1);
		expect(setModel).toHaveBeenCalledWith(MODELS[0]);
		expect(sendUserMessage).toHaveBeenCalledWith(REVIEW_PROMPT);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("已切换到评审模型"),
			"info",
		);
	});

	it("runs with the configured model without dialogs when the UI cannot pick", async () => {
		getReviewStore().setModel("anthropic/claude-sonnet-4");
		const { pi, setModel, sendUserMessage } = fakePi();
		const { ctx, custom } = fakeCtx({ hasUI: false });
		await createReviewRunner(pi)(ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(setModel).toHaveBeenCalledWith(MODELS[0]);
		expect(sendUserMessage).toHaveBeenCalledWith(REVIEW_PROMPT);
	});

	it("picks, persists and runs when no model is configured", async () => {
		const { pi, setModel, sendUserMessage } = fakePi();
		const { ctx, custom } = fakeCtx({ customResult: MODELS[2] });
		await createReviewRunner(pi)(ctx);
		expect(getReviewStore().getModel()).toBe("openrouter/openai/gpt-5");
		expect(setModel).toHaveBeenCalledWith(MODELS[2]);
		expect(sendUserMessage).toHaveBeenCalledWith(REVIEW_PROMPT);
		expect(custom).toHaveBeenCalledTimes(1);
	});

	it("re-picks, persists and runs when the configured model is unavailable", async () => {
		getReviewStore().setModel("anthropic/claude-opus-4-5"); // deleted in pi
		const { pi, setModel, sendUserMessage } = fakePi();
		const { ctx, notify, custom } = fakeCtx({ customResult: MODELS[0] });
		await createReviewRunner(pi)(ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("不存在或不可用"),
			"warning",
		);
		expect(getReviewStore().getModel()).toBe("anthropic/claude-sonnet-4");
		expect(setModel).toHaveBeenCalledWith(MODELS[0]);
		expect(sendUserMessage).toHaveBeenCalledWith(REVIEW_PROMPT);
		expect(custom).toHaveBeenCalledTimes(1);
	});

	it("aborts when the user cancels the model pick", async () => {
		const { pi, setModel, sendUserMessage } = fakePi();
		const { ctx, custom } = fakeCtx({ customResult: undefined });
		await createReviewRunner(pi)(ctx);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(setModel).not.toHaveBeenCalled();
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(getReviewStore().getModel()).toBeUndefined();
	});

	it("reports and aborts when switching to the review model fails", async () => {
		getReviewStore().setModel("anthropic/claude-sonnet-4");
		const { pi, setModel, sendUserMessage } = fakePi(false); // setModel → false
		const { ctx, notify } = fakeCtx({ customResult: MODELS[0] });
		await createReviewRunner(pi)(ctx);
		expect(setModel).toHaveBeenCalledWith(MODELS[0]);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("无法切换到评审模型"),
			"error",
		);
	});

	it("serializes concurrent triggers (one review at a time)", async () => {
		const { pi } = fakePi();
		// First run blocks inside the picker until we resolve it.
		let release: ((v: AvailableModel | undefined) => void) | undefined;
		const custom = vi.fn(
			() => new Promise<AvailableModel | undefined>((resolve) => (release = resolve)),
		);
		const ctx = {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			modelRegistry: {
				getAvailable: () => MODELS,
			} as unknown as ModelRegistry,
			ui: { notify: vi.fn(), custom },
		} as unknown as ExtensionContext;

		const runner = createReviewRunner(pi);
		const first = runner(ctx);
		// Second trigger while the first is still picking — must be refused.
		const notify2 = vi.fn();
		const ctx2 = {
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			modelRegistry: { getAvailable: () => MODELS } as unknown as ModelRegistry,
			ui: { notify: notify2, custom: vi.fn(async () => undefined) },
		} as unknown as ExtensionContext;
		await runner(ctx2);
		expect(notify2).toHaveBeenCalledWith(
			expect.stringContaining("评审已在执行中"),
			"warning",
		);
		release?.(MODELS[0]);
		await first;
		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});
});
