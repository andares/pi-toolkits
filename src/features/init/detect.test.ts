import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
	countBareRefs,
	detect,
	isBareRef,
	parseHeadings,
	parseState,
	readDoc,
	scanRefs,
} from "./detect.js";
import { project, remove } from "./test-helpers.js";

describe("isBareRef", () => {
	const text = "see memory/DESIGN.md, .agents/memory/X.md, my-memory/y, ~/.pi/agent/memory/z";

	it("counts a reference that starts a path token", () => {
		const index = text.indexOf("memory/");
		expect(isBareRef(text, index, "memory/")).toBe(true);
	});

	it("ignores the framework path, compound names and other path tails", () => {
		expect(countBareRefs(text, "memory/")).toBe(1);
	});

	it("counts references inside backticks and parentheses", () => {
		expect(countBareRefs("(`memory/A.md`)", "memory/")).toBe(1);
		expect(countBareRefs("(memory/A.md)", "memory/")).toBe(1);
	});
});

describe("parseHeadings", () => {
	it("skips headings inside fenced code blocks", () => {
		const text = ["# Title", "```md", "## not a heading", "```", "## Real", "### Nested"].join("\n");
		expect(parseHeadings(text).map((heading) => heading.text)).toEqual(["Title", "Real", "Nested"]);
	});
});

describe("detect", () => {
	it("reads context files, headings and language", () => {
		const root = project({
			"AGENTS.md": "# 项目指南\n\n这是给代理看的说明，内容以中文为主。\n\n## 定位\n\n相片管理软件。\n\n## 硬规则\n\n不要猜。\n",
			"src/app.ts": "// 见 memory/ARCHITECTURE.md\n",
		});
		try {
			const facts = detect(root);
			expect(facts.language).toBe("zh");
			expect(facts.context.agents?.headings.map((heading) => heading.text)).toContain("硬规则");
			expect(facts.refs.hits).toBe(1);
			expect(facts.isGit).toBe(false);
		} finally {
			remove(root);
		}
	});

	it("detects legacy directories with real file counts", () => {
		const root = project({
			"memory/ARCHITECTURE.md": "# Architecture\n",
			"memory/PLAN.md": "# Plan\n\n## Route\n\n- item\n",
			"implementations/2026-01-01_a.md": "# a\n",
			"implementations/2026-01-02_b.md": "# b\n",
			"todos/2026-01-03-x.md": "# x\n",
			"specs/a.md": "# a\n",
			"AGENTS.md": "# demo\n\nSee `implementations/2026-01-01_a.md` and `memory/PLAN.md`.\n",
		});
		try {
			const facts = detect(root);
			expect(facts.deprecated.memory).toBe(true);
			expect(facts.deprecated.implementations).toBe(true);
			expect(facts.deprecatedFiles.implementations).toBe(2);
			expect(facts.retiredTodos).toBe(true);
			expect(facts.legacyMemory.map((doc) => doc.rel).sort()).toEqual([
				"memory/ARCHITECTURE.md",
				"memory/PLAN.md",
			]);
			expect(facts.refs.hits).toBe(2);
			expect(facts.refs.byArea["(root)"]?.hits).toBe(2);
		} finally {
			remove(root);
		}
	});

	it("detects a CLAUDE-only project and nested scope cards", () => {
		const root = project({
			"CLAUDE.md": "# rules\n",
			"website/AGENTS.md": "# website\n\nScope card.\n",
			".pi/AGENTS.md": "# pi\n",
		});
		try {
			const facts = detect(root);
			expect(facts.context.claude?.rel).toBe("CLAUDE.md");
			expect(facts.context.agents).toBeUndefined();
			expect(facts.context.piAgents?.rel).toBe(".pi/AGENTS.md");
			expect(facts.nestedAgents.map((file) => file.rel)).toContain("website/AGENTS.md");
			expect(facts.warnings.join("\n")).toMatch(/only CLAUDE\.md exists/);
		} finally {
			remove(root);
		}
	});

	it("warns when AGENTS.override.md shadows the entry", () => {
		const root = project({
			"AGENTS.md": "# a\n",
			"AGENTS.override.md": "# b\n",
		});
		try {
			const facts = detect(root);
			expect(facts.warnings.join("\n")).toMatch(/AGENTS\.override\.md/);
		} finally {
			remove(root);
		}
	});

	it("round-trips the state file", () => {
		const root = project({
			".agents/framework/state.toml": [
				"version = 1",
				'tool = "1.2.3"',
				'created = "2026-01-01T00:00:00+08:00"',
				'updated = "2026-01-02T00:00:00+08:00"',
				'profile = "core"',
				'modules = ["design"]',
				'lang = "zh"',
				"",
				"[[roots]]",
				'label = "api"',
				'path = "../api"',
				'absolute = "/tmp/api"',
				'role = "backend"',
				'agents_md = "none"',
				'source = "add-dir"',
				"",
			].join("\n"),
			"AGENTS.md": "# 中文\n\n说明。\n",
		});
		try {
			const facts = detect(root);
			expect(facts.state?.version).toBe(1);
			expect(facts.state?.tool).toBe("1.2.3");
			expect(facts.state?.modules).toEqual(["design"]);
			expect(facts.state?.roots[0]).toMatchObject({ label: "api", agentsMd: "none" });
			expect(facts.language).toBe("zh");
		} finally {
			remove(root);
		}
	});

	it("flags a state version that is newer than the tool", () => {
		const root = project({
			".agents/framework/state.toml": 'version = 99\ntool = "x"\n',
			"AGENTS.md": "# a\n",
		});
		try {
			const facts = detect(root);
			expect(facts.warnings.join("\n")).toMatch(/newer than this tool/);
		} finally {
			remove(root);
		}
	});

	it("scans references but never inside the framework runtime directory", () => {
		const root = project({
			"src/a.ts": "// memory/X.md\n",
			".agents/framework/reports/old.md": "memory/X.md\n",
		});
		try {
			const scan = scanRefs(root);
			expect(scan.paths).toEqual(["src/a.ts"]);
			expect(scan.hits).toBe(1);
		} finally {
			remove(root);
		}
	});

	it("reads a zero-byte root file and a document heading map", () => {
		const root = project({ "crash-dump": "", "AGENTS.md": "# A\n\n## B\n" });
		try {
			writeFileSync(join(root, "crash-dump"), "", "utf8");
			const facts = detect(root);
			expect(facts.rootEmptyFiles).toContain("crash-dump");
			expect(readDoc(root, "AGENTS.md")?.headings).toHaveLength(2);
		} finally {
			remove(root);
		}
	});

	it("parses a deliberately partial state file", () => {
		const state = parseState('version = 1\nroots = []\n');
		expect(state.version).toBe(1);
		expect(state.lang).toBe("en");
		expect(state.profile).toBe("core");
	});
});


describe("review regressions", () => {
	it("treats ./ and ../ prefixes as references but not other path tails", () => {
		const text = [
			"`../memory/A.md`",
			"`./memory/B.md`",
			"`../../implementations/C.md`",
			"~/.pi/agent/memory/D.md",
			"/memory/E.md",
		].join("\n");
		expect(countBareRefs(text, "memory/")).toBe(2);
		expect(countBareRefs(text, "implementations/")).toBe(1);
	});

	it("round-trips custom budgets through the state TOML keys", async () => {
		const { stateToToml } = await import("./apply.js");
		const parsed = parseState(
			stateToToml({
				version: 1,
				tool: "test",
				created: "2026-01-01T00:00:00+08:00",
				updated: "2026-01-01T00:00:00+08:00",
				profile: "core",
				modules: [],
				lang: "en",
				budgets: {
					agentsMdSoftChars: 9000,
					agentsMdHardChars: 16000,
					memoryFileChars: 50000,
				},
				roots: [],
				managed: [],
				migrations: [],
			}),
		);
		expect(parsed.budgets).toEqual({
			agentsMdSoftChars: 9000,
			agentsMdHardChars: 16000,
			memoryFileChars: 50000,
		});
	});
});
