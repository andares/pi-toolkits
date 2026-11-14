import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { addedRootsFromBranch, parseInitArgs, registerInit } from "./index.js";
import { stateToToml } from "./apply.js";
import { MANAGED_SPECS, renderManaged } from "./parity.js";
import { CONTRACT_FILE } from "./spec.js";
import { setAskControl } from "../../lib/ask-control.js";
import { installedProject, project, remove } from "./test-helpers.js";
import type { FrameworkState } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface HarnessOptions {
	readonly tools?: string[];
	readonly hasUI?: boolean;
	readonly idle?: boolean;
	readonly branch?: unknown[];
}

function harness(root: string, options: HarnessOptions = {}) {
	const sent: string[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const entries: Array<{ type: string; data?: unknown }> = [];
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	const tools = [...(options.tools ?? ["read", "write", "edit", "bash"])];
	let registered: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		on(name: string, fn: (event?: unknown, ctx?: unknown) => unknown) {
			handlers.set(name, fn);
		},
		registerTool() {},
		registerEntryRenderer() {},
		registerCommand(name: string, spec: { handler: typeof registered }) {
			if (name === "ask-init") registered = spec.handler;
		},
		getActiveTools: () => [...tools],
		setActiveTools: (names: string[]) => {
			tools.length = 0;
			tools.push(...names);
		},
		sendUserMessage: (text: string) => {
			sent.push(text);
		},
		appendEntry: (type: string, data?: unknown) => {
			entries.push({ type, data });
		},
	};
	const ctx = {
		cwd: root,
		mode: options.hasUI ? "tui" : "print",
		hasUI: options.hasUI ?? false,
		isIdle: () => options.idle ?? true,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			select: async () => "Cancel",
			custom: async () => undefined,
		},
		sessionManager: { getBranch: () => options.branch ?? [] },
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		ctx: ctx as unknown as ExtensionCommandContext,
		messages: notifications,
		sent,
		entries,
		tools,
		handlers,
		run: (args: string) => {
			if (!registered) throw new Error("ask-init was not registered");
			return registered(args, ctx as unknown as ExtensionCommandContext);
		},
	};
}

const LEGACY: Record<string, string> = {
	"AGENTS.md": "# demo\n\n细节记忆放在 `memory/`。\n\n## 8. 问题清单\n\n已迁至 `memory/PLAN.md` §5。\n",
	"memory/PLAN.md": "# 计划\n\n## 路线\n\n- 项目一\n",
	"memory/FINISHED.md": "# 已完成\n\n## 摘要\n\n- 见 `implementations/2026-01-01_a.md`\n",
	"implementations/2026-01-01_a.md": "# a\n\n见 `memory/ARCHITECTURE.md`\n",
	"src/a.ts": "// 见 `memory/ARCHITECTURE.md`\n",
};

const NOW = new Date("2026-10-26T10:00:00+08:00");

describe("parseInitArgs", () => {
	it("defaults to a run and accepts subcommands", () => {
		expect(parseInitArgs("").sub).toBe("run");
		expect(parseInitArgs("check").sub).toBe("check");
		expect(parseInitArgs("roots").sub).toBe("roots");
		expect(parseInitArgs("scrub").sub).toBe("scrub");
		expect(parseInitArgs("plan --deep").sub).toBe("plan");
		expect(parseInitArgs("refresh --adopt").adopt).toBe(true);
		expect(parseInitArgs("refresh").adopt).toBe(false);
	});

	it("treats --dry-run as the plan subcommand", () => {
		expect(parseInitArgs("--dry-run").sub).toBe("plan");
	});

	it("parses flags and language", () => {
		const parsed = parseInitArgs("--yes --deep --lang zh");
		expect(parsed.yes).toBe(true);
		expect(parsed.deep).toBe(true);
		expect(parsed.lang).toBe("zh");
		expect(parseInitArgs("--lang=fr").lang).toBeUndefined();
	});
});

describe("addedRootsFromBranch", () => {
	it("reads the last add-dir entry", () => {
		const roots = addedRootsFromBranch({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "add-dir:state",
						data: { dirs: [{ label: "api", absolutePath: "/tmp/api" }] },
					},
					{ type: "custom", customType: "other", data: {} },
				],
			},
		} as unknown as ExtensionCommandContext);
		expect(roots).toEqual([{ label: "api", absolute: "/tmp/api" }]);
	});
});

describe("/ask-init", () => {
	it("writes nothing for a dry run", async () => {
		const root = project({ "README.md": "# demo\n" });
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--dry-run");
			expect(existsSync(join(root, ".agents"))).toBe(false);
			expect(h.messages.some((item) => /nothing was written/.test(item.message))).toBe(true);
		} finally {
			remove(root);
		}
	});

	it("installs the framework and dispatches a work order", async () => {
		const root = project({ "README.md": "# demo\n\nA demo.\n" });
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");

			expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
			expect(existsSync(join(root, ".agents/memory/README.md"))).toBe(true);
			expect(existsSync(join(root, ".agents/memory/ARCHITECTURE.md"))).toBe(true);
			expect(existsSync(join(root, "specs/PLAN.md"))).toBe(true);
			expect(existsSync(join(root, ".agents/framework/state.toml"))).toBe(true);
			expect(existsSync(join(root, ".agents/framework/.gitignore"))).toBe(true);

			expect(h.sent).toHaveLength(1);
			expect(h.sent[0]).toContain("AGENT FRAMEWORK v1");
			expect(h.sent[0]).toContain("framework_audit");
			expect(h.tools).toContain("framework_audit");
			expect(h.entries.some((entry) => entry.type === "ask-init:run")).toBe(true);

			const state = readFileSync(join(root, ".agents/framework/state.toml"), "utf8");
			expect(state).toContain("version = 1");
		} finally {
			remove(root);
		}
	});

	it("adopts a legacy layout and reports the move in the work order", async () => {
		const root = project(LEGACY);
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");

			expect(existsSync(join(root, "memory"))).toBe(false);
			expect(existsSync(join(root, ".agents/memory/FINISHED.md"))).toBe(true);
			expect(existsSync(join(root, ".agents/implementations/2026-01-01_a.md"))).toBe(true);
			expect(readFileSync(join(root, "src/a.ts"), "utf8")).toContain(".agents/memory/ARCHITECTURE.md");
			expect(h.sent[0]).toContain("moved memory/ → .agents/memory/");
		} finally {
			remove(root);
		}
	});

	it("re-asserts the audit tool when pi rebuilds the loadout", async () => {
		const root = project({ "README.md": "# demo\n" });
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");
			h.tools.length = 0;
			h.tools.push("read", "write", "edit");
			h.handlers.get("before_agent_start")?.({}, h.ctx);
			expect(h.tools).toContain("framework_audit");
			h.handlers.get("agent_end")?.({}, h.ctx);
			expect(h.tools).not.toContain("framework_audit");
		} finally {
			remove(root);
		}
	});

	it("audits an installed framework and writes a runtime report", async () => {
		const root = installedProject();
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("check");
			expect(h.messages.some((item) => /ask-init check: \d+ errors/.test(item.message))).toBe(true);
			expect(existsSync(join(root, ".agents/framework/reports"))).toBe(true);
			expect(h.sent).toHaveLength(0);
		} finally {
			remove(root);
		}
	});

	it("switches to audit-only when the framework is already installed", async () => {
		const root = installedProject();
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");
			expect(h.sent).toHaveLength(0);
			expect(h.messages.some((item) => /ask-init check/.test(item.message))).toBe(true);
		} finally {
			remove(root);
		}
	});

	it("does not recommend reload after a dry-run refresh", async () => {
		const root = installedProject();
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("refresh --dry-run");
			expect(h.messages.some((item) => item.message.includes("/reload"))).toBe(false);
			expect(existsSync(join(root, ".agents/uat/README.md"))).toBe(false);
		} finally {
			remove(root);
		}
	});

	it("refreshes framework-owned text on a repeated run and then reports current", async () => {
		const root = installedProject();
		const rendered = renderManaged(MANAGED_SPECS.find((spec) => spec.path === CONTRACT_FILE)!);
		const hash = (text: string) => createHash("sha256").update(text).digest("hex");
		writeFileSync(join(root, CONTRACT_FILE), rendered, "utf8");
		const state: FrameworkState = {
			version: 1,
			tool: "0.0.0-test",
			created: "2026-01-01T00:00:00+08:00",
			updated: "2026-01-01T00:00:00+08:00",
			profile: "core",
			modules: [],
			roots: [],
			managed: [
				{
					path: CONTRACT_FILE,
					sha256: hash(rendered),
					template: "memory-readme",
					templateSha256: hash(rendered),
				},
			],
			migrations: [],
		};
		writeFileSync(join(root, ".agents/framework/state.toml"), stateToToml(state), "utf8");
		try {
			const first = harness(root);
			registerInit(first.pi, { now: NOW, toolVersion: "test" });
			await first.run("--yes");
			expect(first.sent).toHaveLength(0);
			expect(existsSync(join(root, ".agents/uat/README.md"))).toBe(true);
			expect(first.messages.some((item) => /created|refreshed/.test(item.message))).toBe(true);

			const second = harness(root);
			registerInit(second.pi, { now: NOW, toolVersion: "test" });
			await second.run("--yes");
			expect(second.sent).toHaveLength(0);
			expect(second.messages.some((item) => /already current|no framework files changed/.test(item.message))).toBe(true);
		} finally {
			remove(root);
		}
	});

	it("rebuilds a missing AGENTS.md through the normal model work order", async () => {
		const root = installedProject();
		rmSync(join(root, "AGENTS.md"));
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");
			expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
			expect(h.sent.length).toBeGreaterThan(0);
			expect(h.sent[0]).toContain("fill-agents");
		} finally {
			remove(root);
		}
	});

	it("rebuilds a missing core memory seed without a model turn", async () => {
		const root = installedProject();
		rmSync(join(root, ".agents/memory/FINISHED.md"));
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");
			expect(existsSync(join(root, ".agents/memory/FINISHED.md"))).toBe(true);
			expect(h.sent).toHaveLength(0);
			expect(h.messages.some((item) => /mechanical repair/.test(item.message))).toBe(true);
		} finally {
			remove(root);
		}
	});

	it("refuses mutating runs while a phase owns the tree", async () => {
		const root = installedProject();
		try {
			const plan = harness(root);
			plan.tools.push("plan_submit");
			registerInit(plan.pi, { now: NOW, toolVersion: "test" });
			await plan.run("--yes");
			expect(plan.sent).toHaveLength(0);
			expect(plan.messages.some((item) => /ask-plan/.test(item.message))).toBe(true);

			const uat = harness(root);
			uat.tools.push("uat_item");
			registerInit(uat.pi, { now: NOW, toolVersion: "test" });
			await uat.run("--yes");
			expect(uat.sent).toHaveLength(0);
			expect(uat.messages.some((item) => /ask-uat/.test(item.message))).toBe(true);

			setAskControl({ isActive: () => true, exit: () => {} });
			const ask = harness(root);
			registerInit(ask.pi, { now: NOW, toolVersion: "test" });
			await ask.run("--yes");
			expect(ask.sent).toHaveLength(0);
			expect(ask.messages.some((item) => /\/ask is active/.test(item.message))).toBe(true);
		} finally {
			setAskControl(undefined);
			remove(root);
		}
	});

	it("syncs add-dir roots into the state", async () => {
		const root = project({ "README.md": "# demo\n" });
		const sibling = mkdtempSync(join(tmpdir(), "pi-init-root-"));
		try {
			const install = harness(root);
			registerInit(install.pi, { now: NOW, toolVersion: "test" });
			await install.run("--yes");

			const sync = harness(root);
			registerInit(sync.pi, {
				now: NOW,
				toolVersion: "test",
				addedRoots: [{ label: "api", absolute: sibling }],
			});
			await sync.run("roots");
			const state = readFileSync(join(root, ".agents/framework/state.toml"), "utf8");
			expect(state).toContain('label = "api"');
			expect(state).toContain(sibling);
			expect(sync.messages.some((item) => /roots written/.test(item.message))).toBe(true);
			expect(existsSync(join(root, ".agents/framework/snapshots"))).toBe(true);
		} finally {
			remove(root);
			remove(sibling);
		}
	});

	it("refuses the home directory and a non-idle session", async () => {
		const weird = harness(homedir());
		registerInit(weird.pi, { now: NOW, toolVersion: "test" });
		await weird.run("--yes");
		expect(weird.messages.some((item) => /refusing to install/.test(item.message))).toBe(true);

		const root = project({ "README.md": "# demo\n" });
		try {
			const busy = harness(root, { idle: false });
			registerInit(busy.pi, { now: NOW, toolVersion: "test" });
			await busy.run("--yes");
			expect(busy.messages.some((item) => /still streaming/.test(item.message))).toBe(true);
			expect(existsSync(join(root, ".agents"))).toBe(false);
		} finally {
			remove(root);
		}
	});

	it("refuses when write tools are not active (ask mode)", async () => {
		const root = project({ "README.md": "# demo\n" });
		try {
			const h = harness(root, { tools: ["read", "bash"] });
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");
			expect(h.messages.some((item) => /not active in this session/.test(item.message))).toBe(true);
			expect(existsSync(join(root, ".agents"))).toBe(false);
		} finally {
			remove(root);
		}
	});

	it("refuses a framework newer than the tool", async () => {
		const root = installedProject({
			".agents/framework/state.toml": 'version = 99\ntool = "future"\n',
		});
		try {
			const before = readFileSync(join(root, ".agents/framework/state.toml"), "utf8");
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");
			expect(h.sent).toHaveLength(0);
			expect(readFileSync(join(root, ".agents/framework/state.toml"), "utf8")).toBe(before);
			expect(h.messages.some((item) => item.type === "error")).toBe(true);
		} finally {
			remove(root);
		}
	});
});


describe("review regressions", () => {
	it("rejects unknown arguments instead of running by accident", async () => {
		expect(parseInitArgs("--deap").error).toMatch(/unknown argument/);
		expect(parseInitArgs("--lang fr").error).toMatch(/unknown argument/);
		const root = project({ "README.md": "# demo\n" });
		try {
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--deap --yes");
			expect(existsSync(join(root, ".agents"))).toBe(false);
			expect(h.messages.some((item) => item.type === "error")).toBe(true);
			expect(h.sent).toHaveLength(0);
		} finally {
			remove(root);
		}
	});

	it("does not write anything when the state needs an upgrade recipe", async () => {
		const root = installedProject({
			".agents/framework/state.toml": 'version = 0\ntool = "old"\ncreated = "2026-01-01T00:00:00+08:00"\n',
		});
		try {
			const before = readFileSync(join(root, ".agents/framework/state.toml"), "utf8");
			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("--yes");
			expect(h.sent).toHaveLength(0);
			expect(readFileSync(join(root, ".agents/framework/state.toml"), "utf8")).toBe(before);
			expect(h.messages.some((item) => /no automatic upgrade recipe/.test(item.message))).toBe(true);
		} finally {
			remove(root);
		}
	});

	it("scrubs retired language fields, once, and honours --dry-run", async () => {
		const state = [
			"version = 1",
			'tool = "0.11.0"',
			'created = "2026-01-01T00:00:00+08:00"',
			'updated = "2026-01-01T00:00:00+08:00"',
			'profile = "core"',
			"modules = []",
			'lang = "zh"',
			"",
		].join("\n");
		const plan = `${JSON.stringify({ framework: "agent-framework", language: "zh", tasks: [] }, null, 2)}\n`;
		const root = project({
			".agents/framework/state.toml": state,
			".agents/framework/plans/plan-old.json": plan,
		});
		try {
			const dry = harness(root);
			registerInit(dry.pi, { now: NOW, toolVersion: "test" });
			await dry.run("scrub --dry-run");
			expect(dry.messages.at(-1)?.message).toMatch(/would clean/);
			expect(readFileSync(join(root, ".agents/framework/state.toml"), "utf8")).toBe(state);
			expect(readFileSync(join(root, ".agents/framework/plans/plan-old.json"), "utf8")).toBe(plan);

			const h = harness(root);
			registerInit(h.pi, { now: NOW, toolVersion: "test" });
			await h.run("scrub");
			expect(h.messages.at(-1)?.message).toMatch(/cleaned/);
			expect(readFileSync(join(root, ".agents/framework/state.toml"), "utf8")).not.toMatch(/^\s*lang\s*=/m);
			expect(readFileSync(join(root, ".agents/framework/plans/plan-old.json"), "utf8")).not.toMatch(/"language"/);

			const again = harness(root);
			registerInit(again.pi, { now: NOW, toolVersion: "test" });
			await again.run("scrub");
			expect(again.messages.at(-1)?.message).toMatch(/nothing to scrub/);
		} finally {
			remove(root);
		}
	});
});
