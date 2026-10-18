/**
 * Path canonicalization, containment, grant scoping, and add-dir state.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canonicalize,
	expandHome,
	grantRoot,
	insideAnyRoot,
	isWithin,
	readAddedDirectories,
	sessionRoots,
} from "./paths.js";

function tempProject(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-paths-")));
}

describe("expandHome", () => {
	it("expands only a leading ~", () => {
		expect(expandHome("~")).toBe(homedir());
		expect(expandHome("~/x")).toBe(join(homedir(), "x"));
		expect(expandHome("~user/x")).toBe("~user/x");
		expect(expandHome("/abs/~/x")).toBe("/abs/~/x");
	});
});

describe("containment", () => {
	it("matches the root and its contents but not a sibling prefix", () => {
		expect(isWithin("/a/b", "/a/b")).toBe(true);
		expect(isWithin("/a/b", "/a/b/c")).toBe(true);
		expect(isWithin("/a/b", "/a/bc")).toBe(false);
		expect(isWithin("/a/b", "/a")).toBe(false);
	});

	it("resolves missing suffixes through the nearest existing ancestor", () => {
		const root = tempProject();
		expect(canonicalize(join(root, "missing", "deep", "file"))).toBe(
			join(realpathSync(root), "missing", "deep", "file"),
		);
	});

	it("resolves symlinks, so a link cannot walk out of the root", () => {
		const root = tempProject();
		const outside = tempProject();
		writeFileSync(join(outside, "secret"), "x");
		symlinkSync(outside, join(root, "link"));
		const resolved = canonicalize(join(root, "link", "secret"));
		expect(isWithin(root, resolved)).toBe(false);
	});

	it("deduplicates and canonicalizes the session roots", () => {
		const root = tempProject();
		const outside = tempProject();
		const roots = sessionRoots(root, [root, outside, outside]);
		expect(roots).toHaveLength(2);
		expect(insideAnyRoot(roots, join(outside, "x"))).toBe(true);
		expect(insideAnyRoot(roots, "/definitely/not/here")).toBe(false);
	});
});

describe("grantRoot", () => {
	it("uses the directory itself for a directory", () => {
		const root = tempProject();
		const dir = join(root, "build");
		mkdirSync(dir);
		expect(grantRoot(dir)).toBe(dir);
	});

	it("uses the parent for an existing file", () => {
		const root = tempProject();
		const file = join(root, "notes.txt");
		writeFileSync(file, "x");
		expect(grantRoot(file)).toBe(root);
	});

	it("uses the parent for a path that does not exist yet", () => {
		const root = tempProject();
		expect(grantRoot(join(root, "build"))).toBe(root);
	});
});

describe("readAddedDirectories", () => {
	it("takes the last add-dir:state entry and ignores other entries", () => {
		const entries = [
			{ type: "message" },
			{ type: "custom", customType: "other", data: { dirs: [{ absolutePath: "/no" }] } },
			{
				type: "custom",
				customType: "add-dir:state",
				data: { dirs: [{ absolutePath: "/a" }, { absolutePath: "/b" }] },
			},
			{
				type: "custom",
				customType: "add-dir:state",
				data: { dirs: [{ absolutePath: "/c" }] },
			},
		];
		expect(readAddedDirectories(entries)).toEqual(["/c"]);
	});

	it("returns nothing without pi-add-dir state or with a malformed payload", () => {
		expect(readAddedDirectories([{ type: "message" }])).toEqual([]);
		expect(
			readAddedDirectories([{ type: "custom", customType: "add-dir:state", data: {} }]),
		).toEqual([]);
	});
});
