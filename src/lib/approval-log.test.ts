import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clipText,
	createApprovalLog,
	sanitizeToolInput,
} from "./approval-log.js";

function tempDir(prefix = "pi-approval-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function logFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => /^audit-\d{6,}\.jsonl$/.test(name))
		.sort();
}

function linesOf(dir: string, name: string): string[] {
	return readFileSync(join(dir, name), "utf8")
		.split("\n")
		.filter((line) => line !== "");
}

describe("approval log", () => {
	it("writes one JSON object per line and creates the directory lazily", () => {
		const root = tempDir();
		const dir = join(root, "nested", "log");
		const log = createApprovalLog({
			dir,
			mode: "interesting",
			now: () => new Date("2026-01-02T03:04:05.000Z"),
		});

		expect(existsSync(dir)).toBe(false);
		log.append({
			event: "block",
			tool: "bash",
			verdict: { action: "deny", layer: "secret" },
		});
		expect(logFiles(dir)).toEqual(["audit-000001.jsonl"]);

		const lines = linesOf(dir, "audit-000001.jsonl");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		expect(record).toMatchObject({
			v: 1,
			ts: "2026-01-02T03:04:05.000Z",
			event: "block",
			tool: "bash",
			verdict: { action: "deny", layer: "secret" },
		});
		if (process.platform !== "win32") {
			expect(statSync(join(dir, "audit-000001.jsonl")).mode & 0o777).toBe(
				0o600,
			);
		}
	});

	it("rotates at the record cap and removes the oldest file", () => {
		const dir = tempDir();
		const log = createApprovalLog({
			dir,
			mode: "interesting",
			maxRecords: 3,
			maxFiles: 2,
		});
		for (let i = 1; i <= 7; i++) log.append({ event: "ask", n: i });

		expect(logFiles(dir)).toEqual(["audit-000002.jsonl", "audit-000003.jsonl"]);
		expect(linesOf(dir, "audit-000002.jsonl")).toHaveLength(3);
		expect(linesOf(dir, "audit-000003.jsonl")).toHaveLength(1);
		expect(
			linesOf(dir, "audit-000003.jsonl")
				.map((line) => (JSON.parse(line) as { n: number }).n)
				.join(","),
		).toBe("7");
	});

	it("rotates at the byte cap before the record cap", () => {
		const dir = tempDir();
		const log = createApprovalLog({
			dir,
			mode: "interesting",
			maxFileBytes: 300,
			maxRecords: 1000,
		});
		for (let i = 1; i <= 3; i++) {
			log.append({ event: "ask", n: i, payload: "x".repeat(200) });
		}
		const files = logFiles(dir);
		expect(files).toHaveLength(2);
		expect(linesOf(dir, files[0] ?? "")).toHaveLength(2);
		expect(linesOf(dir, files[1] ?? "")).toHaveLength(1);
	});

	it("terminates a crash-truncated tail before appending", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, "audit-000001.jsonl"),
			'{"v":1,"event":"block"}\n{"v":1,"event":"as',
		);
		const log = createApprovalLog({ dir, mode: "interesting" });
		log.append({ event: "ask", n: 2 });

		const lines = linesOf(dir, "audit-000001.jsonl");
		expect(lines).toHaveLength(3);
		expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
		expect(() => JSON.parse(lines[1] ?? "")).toThrow();
		expect(JSON.parse(lines[2] ?? "") as Record<string, unknown>).toMatchObject({
			event: "ask",
			n: 2,
		});
	});

	it("redacts credential-shaped strings anywhere in the record", () => {
		const dir = tempDir();
		const log = createApprovalLog({ dir, mode: "interesting" });
		log.append({
			event: "ask",
			input: {
				command:
					"curl -H 'Authorization: Bearer abcdefgh12345678' https://user:pass@example.com/x?token=supersecretvalue",
			},
			units: [{ raw: "export TOKEN=anothersecretvalue" }],
			reason: "password=hunter2",
		});

		const line = readFileSync(join(dir, "audit-000001.jsonl"), "utf8");
		expect(line).toContain('"redacted":true');
		expect(line).not.toContain("abcdefgh12345678");
		expect(line).not.toContain("supersecretvalue");
		expect(line).not.toContain("anothersecretvalue");
		expect(line).not.toContain("hunter2");
		expect(line).toContain("[redacted]");
	});

	it("drops write/edit bodies but keeps their size", () => {
		expect(sanitizeToolInput("write", { path: "/tmp/a", content: "hello" }))
			.toEqual({ path: "/tmp/a", contentBytes: 5 });
		expect(
			sanitizeToolInput("edit", {
				path: "/tmp/a",
				oldText: "abc",
				newText: "abcdef",
			}),
		).toEqual({ path: "/tmp/a", contentBytes: 6, oldTextBytes: 3 });
	});

	it("clips overlong text with a visible marker", () => {
		const clipped = clipText("x".repeat(5000), 100);
		expect(clipped).toContain("[+4900 chars]");
		expect(clipped.length).toBeLessThan(5000);
	});

	it("caps a pathological record without losing the verdict", () => {
		const dir = tempDir();
		const log = createApprovalLog({
			dir,
			mode: "interesting",
			maxRecordBytes: 600,
		});
		log.append({
			event: "ask",
			verdict: { action: "ask", layer: "mode", target: "/tmp/x" },
			verdictCode: 1,
			units: Array.from({ length: 40 }, (_, index) => ({
				raw: `${index}:${"y".repeat(300)}`,
			})),
			input: { command: "z".repeat(5000) },
		});

		const line = readFileSync(join(dir, "audit-000001.jsonl"), "utf8").trim();
		const record = JSON.parse(line) as Record<string, unknown>;
		expect(record.event).toBe("ask");
		expect(record.verdict).toMatchObject({ action: "ask", layer: "mode" });
		expect(record.units === undefined || record.truncated === true).toBe(true);
		expect(line.length).toBeLessThan(2000);
	});

	it("skips one unserializable record instead of disabling the log", () => {
		const dir = tempDir();
		const warnings: string[] = [];
		const log = createApprovalLog({
			dir,
			mode: "interesting",
			warn: (message) => warnings.push(message),
		});
		// A BigInt inside the envelope cannot be stringified even after every
		// optional field is dropped. It must cost one record, not the process.
		log.append({ event: "ask", verdict: { action: 1n as unknown as number } });
		expect(log.active).toBe(true);
		log.append({ event: "block", n: 2 });

		const lines = linesOf(dir, "audit-000001.jsonl");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}") as Record<string, unknown>).toMatchObject({
			event: "block",
			n: 2,
		});
		expect(warnings).toHaveLength(1);
	});

	it("keeps a record whose envelope survives the dropped detail", () => {
		const dir = tempDir();
		const log = createApprovalLog({ dir, mode: "interesting" });
		// The BigInt sits in a field the last-resort envelope drops, so the
		// decision itself is still recorded (with `truncated`).
		log.append({ event: "ask", extra: 1n as unknown as number, verdict: "ask" });

		const record = JSON.parse(
			linesOf(dir, "audit-000001.jsonl")[0] ?? "{}",
		) as Record<string, unknown>;
		expect(record.event).toBe("ask");
		expect(record.truncated).toBe(true);
	});

	it("fails open and warns once when the directory is unusable", () => {
		const root = tempDir();
		const file = join(root, "not-a-dir");
		writeFileSync(file, "");
		const warnings: string[] = [];
		const log = createApprovalLog({
			dir: join(file, "log"),
			mode: "interesting",
			warn: (message) => warnings.push(message),
		});

		expect(() => log.append({ event: "ask" })).not.toThrow();
		expect(log.active).toBe(false);
		expect(warnings).toHaveLength(1);
		log.append({ event: "ask" });
		expect(warnings).toHaveLength(1);
	});

	it("writes nothing when the mode is off", () => {
		const root = tempDir();
		const dir = join(root, "off");
		const log = createApprovalLog({ dir, mode: "off" });
		log.append({ event: "ask" });
		expect(log.active).toBe(false);
		expect(existsSync(dir)).toBe(false);
	});

	it("keeps two writers within the ring without corrupting lines", () => {
		const dir = tempDir();
		const first = createApprovalLog({
			dir,
			mode: "interesting",
			maxRecords: 3,
			maxFiles: 2,
		});
		const second = createApprovalLog({
			dir,
			mode: "interesting",
			maxRecords: 3,
			maxFiles: 2,
		});
		for (let i = 0; i < 10; i++) {
			(i % 2 === 0 ? first : second).append({ event: "ask", n: i });
		}

		const files = logFiles(dir);
		expect(files.length).toBeLessThanOrEqual(2);
		let total = 0;
		for (const name of files) {
			const lines = linesOf(dir, name);
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
			// Each writer checks the count before appending, so two writers can
			// overshoot the cap by at most one record — not by 2x, which is what a
			// per-process counter would do.
			expect(lines.length).toBeLessThanOrEqual(4);
			total += lines.length;
		}
		expect(total).toBeGreaterThan(0);
		expect(total).toBeLessThanOrEqual(10);
	});
});
