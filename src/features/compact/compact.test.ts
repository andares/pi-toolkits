/**
 * compact-model feature — tests.
 *
 * Covers:
 *  - CompactStore: set/get roundtrip (persisted), corrupted-file
 *    degradation, clear persistence
 *  - pickCompactModel: no-UI fallback, empty list, clear option, model pick,
 *    cancel
 *  - session_before_compact handler: unset config → untouched; unavailable
 *    model → warning + fallback; success (summary format, passthrough
 *    fields, usage, details); empty summary → fallback; stopReason
 *    length/error → fallback; abort → silent fallback; split-turn double
 *    call + merged summary + combined usage; customInstructions and
 *    previousSummary prompt variants
 *  - prompt assembly: buildHistoryPromptText / buildTurnPrefixPromptText /
 *    computeFileLists / formatFileOperations / combineUsage
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import type { AvailableModel } from "../../lib/model-config.js";
import { modelKey } from "../../lib/model-config.js";
import {
	buildHistoryPromptText,
	buildTurnPrefixPromptText,
	combineUsage,
	computeFileLists,
	formatFileOperations,
	SUMMARIZATION_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
	type UsageLike,
} from "./prompt.js";
import {
	CompactStore,
	getCompactStore,
	setSharedCompactStore,
} from "./store.js";
import { pickCompactModel, registerCompact } from "./index.js";

// ─── fakes & setup ─────────────────────────────────────────────

let tmpDir: string;
let storeSeq = 0;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-toolkits-compact-"));
});

beforeEach(() => {
	storeSeq += 1;
	setSharedCompactStore(
		new CompactStore(join(tmpDir, `compact-${storeSeq}.json`)),
	);
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function freshStoreFile(): string {
	storeSeq += 1;
	return join(tmpDir, `compact-${storeSeq}.json`);
}

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

/** The response type ModelRegistry.complete() resolves to (pi's AssistantMessage). */
type AssistantMessageLike = Awaited<ReturnType<ModelRegistry["complete"]>>;

function fakeUsage(over: Partial<UsageLike> = {}): UsageLike {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: {
			input: 0.001,
			output: 0.002,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.003,
		},
		...over,
	};
}

function fakeResponse(
	text: string,
	over: Partial<AssistantMessageLike> = {},
): AssistantMessageLike {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: fakeUsage(),
		timestamp: Date.now(),
		...over,
	} as AssistantMessageLike;
}

interface CtxOverrides {
	models?: AvailableModel[];
	complete?: (
		model: AvailableModel,
		context: { messages: Array<{ role: string; content: unknown }> },
		options: { maxTokens?: number; signal?: AbortSignal },
	) => Promise<AssistantMessageLike>;
	hasUI?: boolean;
	customResult?: AvailableModel | undefined;
}

function fakeCtx(overrides: CtxOverrides = {}) {
	const notify = vi.fn();
	const custom = vi.fn(async () => overrides.customResult);
	const setStatus = vi.fn();
	const complete =
		overrides.complete ??
		(vi.fn(async () => fakeResponse("## Goal\n- test summary")) as NonNullable<
			CtxOverrides["complete"]
		>);
	const ctx = {
		mode: "tui",
		hasUI: overrides.hasUI ?? true,
		isIdle: () => true,
		modelRegistry: {
			getAvailable: () => overrides.models ?? MODELS,
			complete,
		},
		ui: { notify, custom, setStatus },
	} as unknown as ExtensionContext;
	return { ctx, notify, custom, setStatus, complete };
}

function fakePi() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const on = vi.fn((event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
		handlers.set(event, handler);
	});
	const registerCommand = vi.fn(
		(name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, def);
		},
	);
	const pi = { on, registerCommand } as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: 1,
	};
}

function fakeEvent(over: Partial<SessionBeforeCompactEvent["preparation"]> = {}) {
	const preparation = {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMessage("hello world")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 12345,
		previousSummary: undefined,
		fileOps: {
			read: new Set(["/a/read.ts", "/b/mod.ts"]),
			written: new Set(["/b/mod.ts"]),
			edited: new Set(["/c/edit.ts"]),
		},
		settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 20000 },
		...over,
	};
	return {
		type: "session_before_compact",
		preparation,
		branchEntries: [],
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	} as unknown as SessionBeforeCompactEvent;
}

function registeredHandler() {
	const { pi, handlers, commands } = fakePi();
	registerCompact(pi);
	const handler = handlers.get("session_before_compact");
	expect(handler).toBeTypeOf("function");
	return { handler: handler!, commands };
}

// ─── store ─────────────────────────────────────────────────────

describe("CompactStore", () => {
	it("persists set/get roundtrip", () => {
		const file = freshStoreFile();
		const store = new CompactStore(file);
		expect(store.getModel()).toBeUndefined();
		store.setModel("google/gemini-2.5-flash");
		expect(store.getModel()).toBe("google/gemini-2.5-flash");
		const raw = JSON.parse(readFileSync(file, "utf8"));
		expect(raw).toEqual({ model: "google/gemini-2.5-flash" });
	});

	it("reloads from disk", () => {
		const file = freshStoreFile();
		new CompactStore(file).setModel("anthropic/claude-sonnet-4");
		const second = new CompactStore(file);
		expect(second.getModel()).toBe("anthropic/claude-sonnet-4");
	});

	it("degrades to unset on corrupted file", () => {
		const file = freshStoreFile();
		writeFileSync(file, "{not json", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(new CompactStore(file).getModel()).toBeUndefined();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("ignores non-string model values", () => {
		const file = freshStoreFile();
		writeFileSync(file, JSON.stringify({ model: 42 }), "utf8");
		expect(new CompactStore(file).getModel()).toBeUndefined();
	});

	it("persists clear as null", () => {
		const file = freshStoreFile();
		const store = new CompactStore(file);
		store.setModel("google/gemini-2.5-flash");
		store.setModel(undefined);
		expect(store.getModel()).toBeUndefined();
		const raw = JSON.parse(readFileSync(file, "utf8"));
		expect(raw).toEqual({ model: null });
	});

	it("notifies subscribers on set", () => {
		const listener = vi.fn();
		const store = new CompactStore(freshStoreFile());
		store.subscribe(listener);
		store.setModel("google/gemini-2.5-flash");
		expect(listener).toHaveBeenCalledTimes(1);
		store.setModel(undefined);
		expect(listener).toHaveBeenCalledTimes(2);
	});
});

// ─── pickCompactModel ──────────────────────────────────────────

describe("pickCompactModel", () => {
	it("notifies and returns when there is no dialog UI", async () => {
		const { ctx, notify, custom } = fakeCtx({ hasUI: false });
		const model = await pickCompactModel(ctx, getCompactStore());
		expect(model).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("pi-toolkits-compact.json"),
			"error",
		);
	});

	it("notifies when no models are available", async () => {
		const { ctx, notify } = fakeCtx({ models: [] });
		await pickCompactModel(ctx, getCompactStore());
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("没有可用模型"),
			"error",
		);
	});

	it("hints how to clear the config when cancelled", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { ctx, notify } = fakeCtx({ customResult: undefined });
		const model = await pickCompactModel(ctx, getCompactStore());
		expect(model).toBeUndefined();
		expect(getCompactStore().getModel()).toBe("google/gemini-2.5-flash");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("置为 null"),
			"info",
		);
	});

	it("persists the picked model", async () => {
		const { ctx } = fakeCtx({ customResult: MODELS[0] });
		const model = await pickCompactModel(ctx, getCompactStore());
		expect(modelKey(model!)).toBe("google/gemini-2.5-flash");
		expect(getCompactStore().getModel()).toBe("google/gemini-2.5-flash");
	});

	it("keeps config on cancel", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { ctx, notify } = fakeCtx({ customResult: undefined });
		await pickCompactModel(ctx, getCompactStore());
		expect(getCompactStore().getModel()).toBe("google/gemini-2.5-flash");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("已取消"),
			"info",
		);
	});

	it("warns when the configured model is unavailable", async () => {
		getCompactStore().setModel("google/nonexistent");
		const { ctx, notify } = fakeCtx({ customResult: MODELS[0] });
		await pickCompactModel(ctx, getCompactStore());
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("不存在或不可用"),
			"warning",
		);
		expect(getCompactStore().getModel()).toBe("google/gemini-2.5-flash");
	});
});

// ─── session_before_compact handler ────────────────────────────

describe("session_before_compact handler", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns undefined without calling the model when unset", async () => {
		const { handler } = registeredHandler();
		const { ctx, complete } = fakeCtx();
		const result = (await handler(
			fakeEvent() as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(result).toBeUndefined();
		expect(complete).not.toHaveBeenCalled();
	});

	it("falls back with a warning when the model is unavailable", async () => {
		getCompactStore().setModel("google/nonexistent");
		const { handler } = registeredHandler();
		const { ctx, notify, complete } = fakeCtx();
		const result = (await handler(
			fakeEvent() as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(result).toBeUndefined();
		expect(complete).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("google/nonexistent"),
			"warning",
		);
	});

	it("returns the compaction payload on success", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const { ctx, complete } = fakeCtx();
		const event = fakeEvent();
		const result = (await handler(
			event as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(result?.compaction).toBeDefined();
		const compaction = result!.compaction!;
		expect(compaction.summary).toContain("## Goal");
		expect(compaction.summary).toContain("<read-files>\n/a/read.ts\n</read-files>");
		expect(compaction.summary).toContain(
			"<modified-files>\n/b/mod.ts\n/c/edit.ts\n</modified-files>",
		);
		expect(compaction.firstKeptEntryId).toBe("kept-1");
		expect(compaction.tokensBefore).toBe(12345);
		expect(compaction.usage).toEqual(fakeUsage());
		expect(compaction.details).toEqual({
			readFiles: ["/a/read.ts"],
			modifiedFiles: ["/b/mod.ts", "/c/edit.ts"],
		});
		expect(complete).toHaveBeenCalledTimes(1);
		const [model, , options] = (complete as ReturnType<typeof vi.fn>).mock
			.calls[0] as [
			AvailableModel,
			unknown,
			{ maxTokens: number; signal: AbortSignal },
		];
		expect(modelKey(model)).toBe("google/gemini-2.5-flash");
		// 0.8 × reserveTokens(16000) = 12800, under the model cap (8192).
		expect(options.maxTokens).toBe(8192);
		expect(options.signal).toBe(event.signal);
	});

	it("clamps the budget by reserveTokens when the model cap is larger", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const bigCapModel = { ...MODELS[0], maxTokens: 65536 };
		const { ctx, complete } = fakeCtx({ models: [bigCapModel] });
		await handler(fakeEvent() as never, ctx);
		const [, , options] = (complete as ReturnType<typeof vi.fn>).mock
			.calls[0] as [
			AvailableModel,
			unknown,
			{ maxTokens: number },
		];
		expect(options.maxTokens).toBe(12800);
	});

	it("falls back with a warning on an empty summary", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const { ctx, notify } = fakeCtx({
			complete: vi.fn(async () => fakeResponse("   ")),
		});
		const result = (await handler(
			fakeEvent() as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(result).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("摘要为空"),
			"warning",
		);
	});

	it("falls back when the response hit the token cap", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const { ctx, notify } = fakeCtx({
			complete: vi.fn(async () =>
				fakeResponse("partial", { stopReason: "length" }),
			),
		});
		const result = (await handler(
			fakeEvent() as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(result).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("token cap"),
			"error",
		);
	});

	it("falls back silently when the user aborted", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const controller = new AbortController();
		const event = fakeEvent();
		Object.assign(event, { signal: controller.signal });
		controller.abort();
		const { ctx, notify } = fakeCtx({
			complete: vi.fn(async () => {
				throw new Error("aborted mid-flight");
			}),
		});
		const result = (await handler(
			event as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(result).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("merges history + turn-prefix summaries on split turns", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const { ctx, complete } = fakeCtx({
			complete: vi.fn(async (_model, context) => {
				const text = (context.messages[0]?.content as Array<{ text?: string }>)[0]
					?.text;
				return text?.includes("# Instructions")
					? fakeResponse("TURN PREFIX CHECKPOINT", { usage: fakeUsage({ input: 7 }) })
					: fakeResponse("HISTORY SUMMARY");
			}),
		});
		const event = fakeEvent({
			turnPrefixMessages: [userMessage("prefix msg")],
			isSplitTurn: true,
			previousSummary: "OLD SUMMARY",
		});
		const result = (await handler(
			event as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(complete).toHaveBeenCalledTimes(2);
		const compaction = result!.compaction!;
		expect(compaction.summary).toContain("HISTORY SUMMARY");
		expect(compaction.summary).toContain("**Turn Context (split turn):**");
		expect(compaction.summary).toContain("TURN PREFIX CHECKPOINT");
		// 100 (history) + 7 (turn prefix) — combined usage.
		expect(compaction.usage?.input).toBe(107);
	});

	it("keeps the previous summary as history text on split turns with no messages", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const { ctx, complete } = fakeCtx({
			complete: vi.fn(async () => fakeResponse("TURN PREFIX CHECKPOINT")),
		});
		const event = fakeEvent({
			messagesToSummarize: [],
			turnPrefixMessages: [userMessage("prefix msg")],
			isSplitTurn: true,
			previousSummary: "OLD SUMMARY",
		});
		const result = (await handler(
			event as never,
			ctx,
		)) as SessionBeforeCompactResult | undefined;
		expect(complete).toHaveBeenCalledTimes(1);
		const compaction = result!.compaction!;
		expect(compaction.summary).toContain("OLD SUMMARY");
		expect(compaction.summary).toContain("**Turn Context (split turn):**");
	});

	it("injects customInstructions as an Additional focus line", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const prompts: string[] = [];
		const { ctx } = fakeCtx({
			complete: vi.fn(async (_model, context) => {
				prompts.push(
					(context.messages[0]?.content as Array<{ text?: string }>)[0]?.text ??
						"",
				);
				return fakeResponse("## Goal\n- x");
			}),
		});
		const event = fakeEvent();
		Object.assign(event, { customInstructions: "保留命令输出细节" });
		await handler(event as never, ctx);
		expect(prompts[0]).toContain("Additional focus: 保留命令输出细节");
	});

	it("switches to the update prompt when a previous summary exists", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const prompts: string[] = [];
		const { ctx } = fakeCtx({
			complete: vi.fn(async (_model, context) => {
				prompts.push(
					(context.messages[0]?.content as Array<{ text?: string }>)[0]?.text ??
						"",
				);
				return fakeResponse("## Goal\n- x");
			}),
		});
		await handler(
			fakeEvent({ previousSummary: "OLD" }) as never,
			ctx,
		);
		expect(prompts[0]).toContain(UPDATE_SUMMARIZATION_PROMPT);
		expect(prompts[0]).not.toContain(SUMMARIZATION_PROMPT);
		expect(prompts[0]).toContain("<previous-summary>\nOLD\n</previous-summary>");
	});

	it("wraps the serialized conversation in tags", async () => {
		getCompactStore().setModel("google/gemini-2.5-flash");
		const { handler } = registeredHandler();
		const prompts: string[] = [];
		const { ctx } = fakeCtx({
			complete: vi.fn(async (_model, context) => {
				prompts.push(
					(context.messages[0]?.content as Array<{ text?: string }>)[0]?.text ??
						"",
				);
				return fakeResponse("## Goal\n- x");
			}),
		});
		await handler(fakeEvent() as never, ctx);
		expect(prompts[0].startsWith("<conversation>\n")).toBe(true);
		expect(prompts[0]).toContain("hello world");
		expect(prompts[0].endsWith(SUMMARIZATION_PROMPT)).toBe(true);
	});
});

// ─── prompt assembly ───────────────────────────────────────────

describe("buildHistoryPromptText", () => {
	it("uses the initial prompt without a previous summary", () => {
		const text = buildHistoryPromptText("CONV", undefined, undefined);
		expect(text).toBe(`<conversation>\nCONV\n</conversation>\n\n${SUMMARIZATION_PROMPT}`);
	});

	it("embeds the previous summary and uses the update prompt", () => {
		const text = buildHistoryPromptText("CONV", "OLD", undefined);
		expect(text).toContain("<previous-summary>\nOLD\n</previous-summary>");
		expect(text.endsWith(UPDATE_SUMMARIZATION_PROMPT)).toBe(true);
	});

	it("appends the custom focus after the base prompt", () => {
		const text = buildHistoryPromptText("CONV", undefined, "FOCUS X");
		expect(text).toBe(
			`<conversation>\nCONV\n</conversation>\n\n${SUMMARIZATION_PROMPT}\n\nAdditional focus: FOCUS X`,
		);
	});
});

describe("buildTurnPrefixPromptText", () => {
	it("formats conversation then instructions", () => {
		const text = buildTurnPrefixPromptText("CONV");
		expect(text.startsWith("# Conversation\nCONV\n\n# Instructions\n")).toBe(true);
	});
});

describe("computeFileLists", () => {
	it("splits read-only vs modified and sorts both", () => {
		const { readFiles, modifiedFiles } = computeFileLists({
			read: new Set(["/z.ts", "/a.ts", "/m.ts"]),
			written: new Set(["/w.ts"]),
			edited: new Set(["/e.ts", "/m.ts"]),
		});
		expect(readFiles).toEqual(["/a.ts", "/z.ts"]);
		expect(modifiedFiles).toEqual(["/e.ts", "/m.ts", "/w.ts"]);
	});
});

describe("formatFileOperations", () => {
	it("returns empty when no files", () => {
		expect(formatFileOperations([], [])).toBe("");
	});

	it("formats both sections joined by a blank line", () => {
		const tail = formatFileOperations(["/a.ts"], ["/b.ts"]);
		expect(tail).toBe(
			"\n\n<read-files>\n/a.ts\n</read-files>\n\n<modified-files>\n/b.ts\n</modified-files>",
		);
	});
});

describe("combineUsage", () => {
	it("adds numeric fields field-wise", () => {
		const a = fakeUsage();
		const combined = combineUsage(a, fakeUsage());
		expect(combined.input).toBe(200);
		expect(combined.output).toBe(100);
		expect(combined.totalTokens).toBe(300);
		expect(combined.cost.total).toBeCloseTo(0.006);
	});

	it("preserves optional splits only when either side reports them", () => {
		const a = fakeUsage();
		const combined = combineUsage(a, fakeUsage({ cacheWrite1h: 10 }));
		expect(combined.cacheWrite1h).toBe(10);
		const none = combineUsage(fakeUsage(), fakeUsage());
		expect(none.cacheWrite1h).toBeUndefined();
	});
});
