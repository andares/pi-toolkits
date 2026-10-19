/**
 * Tests for the ask scratch store: name validation, containment, size caps,
 * symlink refusal, listing, and the cleanup/availability contract.
 */
import {
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createScratchStore,
	nameError,
	SCRATCH_MAX_BYTES,
	sweepScratchDirs,
} from "./scratch.js";

function tempBase(): string {
	return mkdtempSync(join(tmpdir(), "pi-ask-scratch-"));
}

function store(base: string, sessionId = "session-1") {
	return createScratchStore({ baseDir: base, sessionId });
}

describe("nameError", () => {
	it.each(["plan.md", "notes/api.md", "a", "A_1-2.txt", "topic.v2.json"])(
		"accepts %s",
		(name) => {
			expect(nameError(name)).toBeUndefined();
		},
	);

	it.each([
		[""],
		["   "],
		["/etc/passwd"],
		["../x"],
		["notes/../../x"],
		["notes//api.md"],
		["C:\\x"],
		["a\\b"],
		["a/b/c"],
		[".hidden"],
		["notes/"],
		["with space"],
		["semi;colon"],
	])("rejects %s", (name) => {
		expect(nameError(name)).toBeDefined();
	});
});

describe("createScratchStore", () => {
	it("keeps sessions in separate directories under one base", async () => {
		const base = tempBase();
		const a = await store(base, "a");
		const b = await store(base, "b");
		expect(a.root).not.toBe(b.root);
		await a.write("plan.md", "one");
		expect(await b.list()).toEqual([]);
	});

	it("hashes a session id that is not directory-safe", async () => {
		const base = tempBase();
		const s = await store(base, "../../etc");
		expect(s.root.startsWith(base)).toBe(true);
		expect(s.root).not.toContain("..");
	});

	it("writes, reads, appends and reports sizes", async () => {
		const s = await store(tempBase());
		const written = await s.write("plan.md", "one\ntwo\n");
		expect(written.bytes).toBe(8);
		expect(written.lines).toBe(2);
		expect(await s.read("plan.md")).toBe("one\ntwo\n");

		await s.append("plan.md", "three");
		expect(await s.read("plan.md")).toBe("one\ntwo\nthree");
	});

	it("nests one level", async () => {
		const s = await store(tempBase());
		await s.write("notes/api.md", "x");
		expect(await s.list()).toEqual([{ name: "notes/api.md", bytes: 1 }]);
	});

	it("lists notes sorted, skipping directories and dotfiles", async () => {
		const s = await store(tempBase());
		await s.write("b.md", "22");
		await s.write("a.md", "1");
		await s.write("notes/c.md", "333");
		writeFileSync(join(s.root, ".hidden"), "x");
		expect((await s.list()).map((file) => file.name)).toEqual([
			"a.md",
			"b.md",
			"notes/c.md",
		]);
	});

	it("deletes a note, and deleting a missing note is not an error", async () => {
		const s = await store(tempBase());
		await s.write("plan.md", "x");
		await s.remove("plan.md");
		expect(await s.list()).toEqual([]);
		await expect(s.remove("plan.md")).resolves.toBeUndefined();
	});

	it("explains a missing note instead of throwing an fs error", async () => {
		const s = await store(tempBase());
		await expect(s.read("nope.md")).rejects.toThrow(
			'There is no scratch note named "nope.md"',
		);
	});

	it("caps a single note at SCRATCH_MAX_BYTES", async () => {
		const s = await store(tempBase());
		const tooBig = "x".repeat(SCRATCH_MAX_BYTES + 1);
		await expect(s.write("big.md", tooBig)).rejects.toThrow("capped at");
		await s.write("ok.md", "x".repeat(10));
		await expect(
			s.append("ok.md", "x".repeat(SCRATCH_MAX_BYTES)),
		).rejects.toThrow("capped at");
	});

	it("refuses to write through a symlink that already sits in the root", async () => {
		const base = tempBase();
		const s = await store(base);
		const outside = mkdtempSync(join(tmpdir(), "pi-ask-outside-"));
		try {
			symlinkSync(outside, join(s.root, "link"), "dir");
		} catch {
			// Unprivileged Windows cannot create symlinks; nothing to assert there.
			return;
		}
		await expect(s.write("link/x.md", "escape")).rejects.toThrow(
			"symbolic link",
		);
	});

	it("refuses when the base directory is not a directory", async () => {
		const base = tempBase();
		const file = join(base, "not-a-dir");
		writeFileSync(file, "x");
		expect(() => createScratchStore({ baseDir: file, sessionId: "s" })).toThrow();
	});
});

describe("sweepScratchDirs", () => {
	it("removes directories older than the cap and keeps fresh ones", async () => {
		const base = tempBase();
		const oldDir = join(base, "old");
		const freshDir = join(base, "fresh");
		mkdirSync(oldDir);
		mkdirSync(freshDir);
		const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		utimesSync(oldDir, old, old);

		const removed = sweepScratchDirs(base, 7 * 24 * 60 * 60 * 1000);

		expect(removed).toEqual(["old"]);
		expect(readdirSync(base)).toEqual(["fresh"]);
	});

	it("is silent when the base does not exist", async () => {
		expect(sweepScratchDirs(join(tempBase(), "missing"), 1)).toEqual([]);
	});
});
