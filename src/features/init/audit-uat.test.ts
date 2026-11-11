import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { audit } from "./audit.js";
import { stateToToml } from "./apply.js";
import { detect } from "./detect.js";
import { AUDIT_CODES, CONTRACT_FILE, UAT_CONTRACT_FILE } from "./spec.js";
import { installedProject, remove } from "./test-helpers.js";

const roots: string[] = [];

function installed(extra: Record<string, string> = {}): string {
	const root = installedProject(extra);
	roots.push(root);
	return root;
}

function codes(root: string): string[] {
	return audit(detect(root)).map((finding) => finding.code);
}

function writeLedger(root: string, lines: string[]): void {
	mkdirSync(join(root, ".agents/uat"), { recursive: true });
	writeFileSync(join(root, ".agents/uat/ledger.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

function ledgerEvent(body: Record<string, unknown>): string {
	return JSON.stringify({ v: 1, id: `e-${Math.random().toString(36).slice(2)}`, ts: "2026-11-13T21:00+08:00", ...body });
}

afterEach(() => {
	for (const root of roots.splice(0)) remove(root);
});

describe("UAT audit findings", () => {
	it("reports a missing acceptance ledger as info", () => {
		const root = installed();
		expect(codes(root)).toContain(AUDIT_CODES.uatNotInstalled);
	});

	it("stays quiet once the contract exists", () => {
		const root = installed({ [UAT_CONTRACT_FILE]: "# ledger\n" });
		writeLedger(root, []);
		expect(codes(root)).not.toContain(AUDIT_CODES.uatNotInstalled);
	});

	it("fails on an unparsable ledger line", () => {
		const root = installed({ [UAT_CONTRACT_FILE]: "# ledger\n" });
		writeLedger(root, ["{not json"]);
		const findings = audit(detect(root));
		const finding = findings.find((entry) => entry.code === AUDIT_CODES.uatLedgerBroken);
		expect(finding?.severity).toBe("error");
	});

	it("warns when an item points at a missing record", () => {
		const root = installed({ [UAT_CONTRACT_FILE]: "# ledger\n" });
		writeLedger(root, [
			ledgerEvent({ type: "item", item: "U-1", title: "t", summary: "s", reports: ["gone"] }),
		]);
		const findings = audit(detect(root));
		expect(findings.some((entry) => entry.code === AUDIT_CODES.uatMissingReport)).toBe(true);
	});

	it("warns about a recent non-canonical change record", () => {
		const root = installed();
		writeFileSync(
			join(root, ".agents/implementations/2026-11-13_handwritten.md"),
			"# Handwritten\n\nno time\n",
			"utf8",
		);
		expect(codes(root)).toContain(AUDIT_CODES.recordHeader);
	});

	it("warns when a framework file was edited by hand", () => {
		const root = installed();
		const text = "# my own contract\n";
		writeFileSync(join(root, CONTRACT_FILE), text, "utf8");
		writeFileSync(
			join(root, ".agents/framework/state.toml"),
			stateToToml({
				version: 1,
				tool: "test",
				created: "2026-01-01T00:00:00+08:00",
				updated: "2026-01-01T00:00:00+08:00",
				profile: "core",
				modules: [],
				roots: [],
				managed: [
					{
						path: CONTRACT_FILE,
						sha256: createHash("sha256").update(text).digest("hex"),
						template: "memory-readme",
						templateSha256: createHash("sha256").update("rendered once\n").digest("hex"),
					},
				],
				migrations: [],
			}),
			"utf8",
		);
		expect(codes(root)).toContain(AUDIT_CODES.managedEdited);
	});
});
