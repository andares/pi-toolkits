import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit, countFindings, latestCoverageReport, renderFindings } from "./audit.js";
import { detect } from "./detect.js";
import { AUDIT_CODES, REPORTS_DIR } from "./spec.js";
import { gitProject, installedProject, project, remove } from "./test-helpers.js";

function codes(root: string): string[] {
	return audit(detect(root)).map((finding) => finding.code);
}

const CLEAN: Record<string, string> = {
	"AGENTS.md": [
		"# demo — project guide",
		"",
		"> Memory contract (agent-framework v1).",
		"",
		"## Plan and memory index",
		"",
		"| File | Owns |",
		"| --- | --- |",
		"| `specs/PLAN.md` | route |",
		"| `.agents/memory/FINISHED.md` | closed work |",
		"| `.agents/memory/README.md` | contract |",
		"| `.agents/memory/FUTURE.md` | deferred |",
		"| `.agents/memory/ARCHITECTURE.md` | decisions |",
		"",
	].join("\n"),
	"specs/PLAN.md": "# Plan\n\n## Route\n\n- next\n",
	".agents/memory/README.md": "# Agent memory framework v1\n",
	".agents/memory/FINISHED.md":
		"# Finished\n\n## Summary\n\n- init — `.agents/implementations/2026-01-01_init.md`\n",
	".agents/memory/FUTURE.md": "# Future\n\n- eval idea, 触发条件: a real need appears\n",
	".agents/memory/ARCHITECTURE.md": "# Architecture\n\n## Layering\n\n- one layer\n",
	".agents/implementations/2026-01-01_init.md": "# init\n\n完成时间：2026-01-01 00:00:00\n",
	".agents/framework/state.toml": 'version = 1\ntool = "test"\ncreated = "2026-01-01T00:00:00+08:00"\nupdated = "2026-01-01T00:00:00+08:00"\nprofile = "core"\nmodules = []\nlang = "en"\n',
};

describe("audit", () => {
	it("passes a clean installed project", () => {
		const root = project(CLEAN);
		try {
			const findings = audit(detect(root));
			expect(countFindings(findings).errors).toBe(0);
			expect(countFindings(findings).warnings).toBe(0);
		} finally {
			remove(root);
		}
	});

	it("says so when the framework is not installed", () => {
		const root = project({ "README.md": "# demo\n" });
		try {
			expect(codes(root)).toContain(AUDIT_CODES.notInstalled);
		} finally {
			remove(root);
		}
	});

	it("reports bare legacy references", () => {
		const root = project({ ...CLEAN, "src/a.ts": "// see memory/DESIGN.md\n" });
		try {
			expect(codes(root)).toContain(AUDIT_CODES.pathBareRef);
		} finally {
			remove(root);
		}
	});

	it("reports agent-only directories, retired todos and empty root files", () => {
		const root = project({
			...CLEAN,
			"memory/PLAN.md": "# old\n",
			"todos/2026-01-01-x.md": "# x\n",
			"crash-dump": "",
		});
		try {
			const all = codes(root);
			expect(all).toContain(AUDIT_CODES.rootAgentDir);
			expect(all).toContain(AUDIT_CODES.todosRemain);
			expect(all).toContain(AUDIT_CODES.rootEmptyFile);
		} finally {
			remove(root);
		}
	});

	it("reports a missing contract", () => {
		const root = project({
			...CLEAN,
			".agents/memory/README.md": "",
		});
		try {
			// An empty file still counts as present; remove it instead.
			remove(join(root, ".agents/memory/README.md"));
			expect(codes(root)).toContain(AUDIT_CODES.contractMissing);
		} finally {
			remove(root);
		}
	});

	it("reports a missing plan/memory index", () => {
		const root = project({
			...CLEAN,
			"AGENTS.md": "# demo\n\nNo index here.\n",
		});
		try {
			expect(codes(root)).toContain(AUDIT_CODES.indexMismatch);
		} finally {
			remove(root);
		}
	});

	it("reports a broken internal link", () => {
		const root = project({
			...CLEAN,
			"AGENTS.md": `${CLEAN["AGENTS.md"]}\nSee \`specs/missing.md\`.\n`,
		});
		try {
			expect(codes(root)).toContain(AUDIT_CODES.brokenLink);
		} finally {
			remove(root);
		}
	});

	it("reports duplicated sections and appendices that are not last", () => {
		const root = project({
			...CLEAN,
			"AGENTS.md": [
				"# demo",
				"",
				"## Plan and memory index",
				"",
				"`specs/PLAN.md` `.agents/memory/FINISHED.md` `.agents/memory/README.md`",
				"",
				"## 6. 架构决定",
				"",
				"- a",
				"",
				"## 附录 A",
				"",
				"- old",
				"",
				"## 2026-10-11 追加",
				"",
				"- later",
				"",
			].join("\n"),
			".agents/memory/ARCHITECTURE.md": "# Architecture\n\n## 6. 架构决定\n\n- b\n",
		});
		try {
			const all = codes(root);
			expect(all).toContain(AUDIT_CODES.duplicateFact);
			expect(all).toContain(AUDIT_CODES.appendixOrder);
		} finally {
			remove(root);
		}
	});

	it("reports AGENTS.md over the hard budget with the largest sections", () => {
		const bulk = Array.from(
			{ length: 420 },
			(_, index) => `- 规则 ${index}：这是一段用来撑大文件的中文说明，内容并不重要但字数很多。`,
		).join("\n");
		const root = project({
			...CLEAN,
			"AGENTS.md": `# demo\n\n## Plan and memory index\n\n\`specs/PLAN.md\` \`.agents/memory/README.md\`\n\n## 规则\n\n${bulk}\n`,
		});
		try {
			const finding = audit(detect(root)).find(
				(item) => item.code === AUDIT_CODES.budgetAgents,
			);
			expect(finding?.severity).toBe("warning");
			expect(finding?.message).toMatch(/规则 \(/);
		} finally {
			remove(root);
		}
	});

	it("reports open coverage rows from the newest report", () => {
		const root = project(CLEAN);
		try {
			mkdirSync(join(root, REPORTS_DIR), { recursive: true });
			writeFileSync(
				join(root, REPORTS_DIR, "coverage-2026-01-01.md"),
				["| Source | Section | Status | Destination | Reason |", "| --- | --- | --- | --- | --- |", "| AGENTS.md | 定位 | OPEN | | |"].join("\n"),
				"utf8",
			);
			expect(latestCoverageReport(root)).toBe(`${REPORTS_DIR}/coverage-2026-01-01.md`);
			expect(codes(root)).toContain(AUDIT_CODES.coverageOpen);
		} finally {
			remove(root);
		}
	});

	it("reports memory that git ignores", () => {
		const root = gitProject({
			...CLEAN,
			".gitignore": ".agents/memory/\n",
		});
		try {
			expect(codes(root)).toContain(AUDIT_CODES.stateUntracked);
		} finally {
			remove(root);
		}
	});

	it("does not report tracked memory as untracked", () => {
		const root = gitProject(CLEAN);
		try {
			writeFileSync(join(root, ".agents/memory/TEMP.md"), "# new\n", "utf8");
			expect(codes(root)).not.toContain(AUDIT_CODES.stateUntracked);
		} finally {
			remove(root);
		}
	});

	it("reports scaffold leftovers and renders grouped findings", () => {
		const root = project({
			...CLEAN,
			"AGENTS.md": `${CLEAN["AGENTS.md"]}\n<!-- TODO(ask-init): fill this -->\n`,
			"src/a.ts": "// memory/X.md\n",
		});
		try {
			const findings = audit(detect(root));
			expect(findings.map((item) => item.code)).toContain(AUDIT_CODES.scaffoldLeftover);
			const text = renderFindings(findings, { root, frameworkVersion: 1 });
			expect(text).toMatch(/errors/);
			expect(text).toContain(AUDIT_CODES.pathBareRef);
		} finally {
			remove(root);
		}
	});

	it("reports a newer state version as an error", () => {
		const root = installedProject({
			".agents/framework/state.toml": 'version = 99\ntool = "future"\n',
		});
		try {
			const finding = audit(detect(root)).find(
				(item) => item.code === AUDIT_CODES.stateVersion,
			);
			expect(finding?.severity).toBe("error");
		} finally {
			remove(root);
		}
	});
});


describe("review regressions", () => {
	it("treats not-yet-committed memory as a warning, not an error", () => {
		const root = gitProject({ "README.md": "# demo\n" });
		try {
			mkdirSync(join(root, ".agents/memory"), { recursive: true });
			writeFileSync(
				join(root, ".agents/memory/FINISHED.md"),
				"# Finished\n\n## Summary\n\n_None._\n",
				"utf8",
			);
			const findings = audit(detect(root));
			const finding = findings.find((item) => item.code === AUDIT_CODES.stateUncommitted);
			expect(finding?.severity).toBe("warning");
			expect(findings.map((item) => item.code)).not.toContain(AUDIT_CODES.stateUntracked);
		} finally {
			remove(root);
		}
	});

	it("does not demand evidence for a placeholder FINISHED section", () => {
		const root = project({
			...CLEAN,
			".agents/memory/FINISHED.md": "# Finished\n\n## Summary\n\n_Nothing closed yet._\n",
		});
		try {
			expect(codes(root)).not.toContain(AUDIT_CODES.finishedNoEvidence);
		} finally {
			remove(root);
		}
	});

	it("still flags a real finished entry without an evidence pointer", () => {
		const root = project({
			...CLEAN,
			".agents/memory/FINISHED.md": "# Finished\n\n## M1\n\n- shipped the importer\n",
		});
		try {
			expect(codes(root)).toContain(AUDIT_CODES.finishedNoEvidence);
		} finally {
			remove(root);
		}
	});
});
