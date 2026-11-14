import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateToToml } from "./apply.js";
import { audit } from "./audit.js";
import { detect } from "./detect.js";
import {
	frameworkReadiness,
	inspectFramework,
	inspectManaged,
	inspectWorkflow,
	renderManaged,
	MANAGED_SPECS,
	workflowBlockText,
} from "./parity.js";
import { AGENTS_FILE, CONTRACT_FILE } from "./spec.js";
import { project, remove } from "./test-helpers.js";
import type { FrameworkState } from "./types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function state(managed: FrameworkState["managed"]): FrameworkState {
	return {
		version: 1,
		tool: "test",
		created: "2026-01-01T00:00:00+08:00",
		updated: "2026-01-01T00:00:00+08:00",
		profile: "core",
		modules: [],
		roots: [],
		managed,
		migrations: [],
	};
}

function writeState(root: string, managed: FrameworkState["managed"]): void {
	mkdirSync(join(root, ".agents/framework"), { recursive: true });
	writeFileSync(
		join(root, ".agents/framework/state.toml"),
		stateToToml(state(managed)),
		"utf8",
	);
}

describe("parity", () => {
	it("distinguishes current, stale, hand-edited, missing and unverifiable files", () => {
		const current = renderManaged(MANAGED_SPECS[0]);

		const staleRoot = project({ [CONTRACT_FILE]: "old contract\n" });
		writeState(staleRoot, [
			{
				path: CONTRACT_FILE,
				sha256: hash("old contract\n"),
				template: "memory-readme",
				templateSha256: hash("old contract\n"),
			},
		]);
		expect(inspectManaged(staleRoot, detect(staleRoot).state).find((entry) => entry.path === CONTRACT_FILE)?.status).toBe(
			"stale",
		);
		remove(staleRoot);

		const editedRoot = project({ [CONTRACT_FILE]: "my edits\n" });
		writeState(editedRoot, [
			{
				path: CONTRACT_FILE,
				sha256: hash("my edits\n"),
				template: "memory-readme",
				templateSha256: hash("what we wrote\n"),
			},
		]);
		expect(inspectManaged(editedRoot, detect(editedRoot).state).find((entry) => entry.path === CONTRACT_FILE)?.status).toBe(
			"hand-edited",
		);
		remove(editedRoot);

		const legacyRoot = project({ [CONTRACT_FILE]: "old contract\n" });
		expect(inspectManaged(legacyRoot, detect(legacyRoot).state).find((entry) => entry.path === CONTRACT_FILE)?.status).toBe(
			"unverifiable",
		);
		remove(legacyRoot);

		const missingRoot = project({});
		expect(inspectManaged(missingRoot).find((entry) => entry.path === CONTRACT_FILE)?.status).toBe(
			"missing",
		);
		remove(missingRoot);

		const currentRoot = project({ [CONTRACT_FILE]: current });
		writeState(currentRoot, [
			{
				path: CONTRACT_FILE,
				sha256: hash(current),
				template: "memory-readme",
				templateSha256: hash(current),
			},
		]);
		expect(inspectManaged(currentRoot, detect(currentRoot).state).find((entry) => entry.path === CONTRACT_FILE)?.status).toBe(
			"current",
		);
		remove(currentRoot);
	});

	it("keeps the readiness predicate tolerant of file content edits", () => {
		const empty = project({});
		expect(frameworkReadiness(empty).ready).toBe(false);
		expect(frameworkReadiness(empty).missing).toContain(AGENTS_FILE);
		remove(empty);

		const ready = project({
			[AGENTS_FILE]: "# demo\n",
			[CONTRACT_FILE]: "# my own contract\n",
			".agents/implementations/2026-01-01_x.md": "# x\n",
			".agents/framework/state.toml": "version = 1\ntool = \"test\"\n",
		});
		expect(frameworkReadiness(ready)).toEqual({ ready: true, missing: [] });
		remove(ready);
	});

	it("rejects paths with the wrong file type", () => {
		const root = project({
			".agents/framework/state.toml": "version = 1\ntool = \"test\"\n",
			".agents/memory/README.md": "# contract\n",
			"AGENTS.md/placeholder.txt": "not a file\n",
			".agents/implementations": "not a directory\n",
		});
		const readiness = frameworkReadiness(root);
		expect(readiness.ready).toBe(false);
		expect(readiness.missing).toEqual(expect.arrayContaining([AGENTS_FILE, ".agents/implementations"]));
		remove(root);
	});

	it("classifies the workflow block without touching it", () => {
		const missing = project({ [AGENTS_FILE]: "# demo\n" });
		expect(inspectWorkflow(missing)).toBe("missing");
		remove(missing);

		const handWritten = project({ [AGENTS_FILE]: "# demo\n\n## Ask workflow\n\nDo it.\n" });
		expect(inspectWorkflow(handWritten)).toBe("hand-written");
		remove(handWritten);

		const malformed = project({
			[AGENTS_FILE]: "# demo\n\n<!-- ask-init:begin workflow v1 -->\n## old\n",
		});
		expect(inspectWorkflow(malformed)).toBe("malformed");
		remove(malformed);

		const current = project({ [AGENTS_FILE]: `# demo\n\n${workflowBlockText()}` });
		expect(inspectWorkflow(current)).toBe("current");
		remove(current);

		const stale = project({
			[AGENTS_FILE]: `# demo\n\n<!-- ask-init:begin workflow v1 -->\n## old\n<!-- ask-init:end workflow -->\n`,
		});
		expect(inspectWorkflow(stale)).toBe("stale");
		remove(stale);
	});

	it("reports required files and surfaces parity findings through audit", () => {
		const root = project({
			[AGENTS_FILE]: "# demo\n",
			[CONTRACT_FILE]: "old contract\n",
			".agents/framework/state.toml": "version = 1\ntool = \"test\"\n",
		});
		try {
			expect(inspectFramework(root, detect(root).state).requiredMissing.length).toBeGreaterThan(0);
			const codes = audit(detect(root)).map((finding) => finding.code);
			expect(codes).toContain("W-FW-02");
			expect(codes).toContain("W-FW-03");
			expect(codes).toContain("W-FW-04");
		} finally {
			remove(root);
		}
	});
});
