/**
 * whats-new feature — parser, version ordering, store and startup tests.
 *
 * Everything is deterministic: temp directories for state and fixtures, an
 * injected version, and a fake `pi` that records entries instead of rendering
 * them. The startup cases encode the product rule exactly — the notice fires on
 * the first TUI start after an upgrade and never again for that version.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	parseChangelog,
	readPackageVersion,
	releasesForUpgrade,
	sortReleasesDescending,
} from "./changelog.js";
import { registerWhatsNew, type WhatsNewOptions } from "./index.js";
import {
	buildUpgradeNotice,
	renderReleaseSections,
} from "./notice.js";
import { WhatsNewStore, normalizeState } from "./store.js";
import { compareVersions, parseVersion } from "./version.js";

const CHANGELOG = `# Changelog

Intro prose that is not part of any release.

## Unreleased

- work in progress

## 0.13.1 — 2026-11-13

- fix one
- fix two
  - nested detail is not a notice line
- fix three
- fix four
- fix five
- fix six
- fix seven

## 0.13.0 — 2026-11-12

- plan feature

## 0.12.0 — 2026-11-06

- old feature
`;

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-whats-new-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
	storeFile: string;
	changelogFile: string;
	packageFile: string;
	dir: string;
}

function fixture(options: { version?: string; changelog?: string } = {}): Fixture {
	const dir = tempDir();
	const changelogFile = join(dir, "CHANGELOG.md");
	const packageFile = join(dir, "package.json");
	writeFileSync(changelogFile, options.changelog ?? CHANGELOG, "utf8");
	writeFileSync(packageFile, JSON.stringify({ version: options.version ?? "0.13.1" }), "utf8");
	return { dir, storeFile: join(dir, "state", "whats-new.json"), changelogFile, packageFile };
}

function readState(file: string): { lastSeenVersion?: string } {
	return JSON.parse(readFileSync(file, "utf8")) as { lastSeenVersion?: string };
}

interface Harness {
	start(reason: SessionStartEvent["reason"], ctx: ExtensionContext): void;
	entries: Array<{ type: string; data: unknown }>;
	commands: string[];
}

function harness(options: WhatsNewOptions): Harness {
	const entries: Harness["entries"] = [];
	const commands: string[] = [];
	let startHandler: ((event: SessionStartEvent, ctx: ExtensionContext) => void) | undefined;

	const pi = {
		on(event: string, handler: (event: SessionStartEvent, ctx: ExtensionContext) => void) {
			if (event === "session_start") startHandler = handler;
		},
		registerEntryRenderer() {},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	} as unknown as ExtensionAPI;

	registerWhatsNew(pi, options);
	if (!startHandler) throw new Error("whats-new did not register");

	return {
		entries,
		commands,
		start: (reason, ctx) => startHandler?.({ type: "session_start", reason }, ctx),
	};
}

interface CtxOptions {
	mode?: ExtensionContext["mode"];
	sessionId?: string;
}

function makeCtx(options: CtxOptions = {}): {
	ctx: ExtensionContext;
	notes: Array<{ message: string; kind?: string }>;
} {
	const notes: Array<{ message: string; kind?: string }> = [];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			notify: (message: string, kind?: string) => notes.push({ message, kind }),
		},
		sessionManager: { getSessionId: () => options.sessionId ?? "session-1" },
	} as unknown as ExtensionContext;
	return { ctx, notes };
}

describe("versions", () => {
	it("orders numerically, not lexically", () => {
		expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
		expect(compareVersions("0.13.0", "0.13.1")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
		expect(compareVersions("0.13.1", "0.13.1")).toBe(0);
	});

	it("treats unparseable versions as unknown (zero) and never as an upgrade", () => {
		expect(parseVersion("0.13.1")).toEqual({ major: 0, minor: 13, patch: 1 });
		expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(parseVersion("0.13")).toBeUndefined();
		expect(parseVersion("next")).toBeUndefined();
		expect(compareVersions("next", "0.13.0")).toBe(0);
	});
});

describe("changelog parsing", () => {
	it("reads one section per version and only top-level bullets", () => {
		const releases = parseChangelog(CHANGELOG);
		expect(releases.map((release) => release.version)).toEqual([
			"0.13.1",
			"0.13.0",
			"0.12.0",
		]);
		const latest = releases[0];
		expect(latest.notes).toHaveLength(7);
		expect(latest.notes).not.toContain("nested detail is not a notice line");
	});

	it("ignores Unreleased and text before the first version heading", () => {
		const releases = parseChangelog(CHANGELOG);
		expect(releases.some((release) => release.version === "Unreleased")).toBe(false);
		expect(releases.flatMap((release) => release.notes)).not.toContain(
			"work in progress",
		);
	});

	it("accepts bracketed and dated headings", () => {
		const releases = parseChangelog("## [0.2.0] - 2026-01-02\n\n- note\n");
		expect(releases).toEqual([{ version: "0.2.0", notes: ["note"] }]);
	});

	it("keeps empty sections so the version still shows up", () => {
		expect(parseChangelog("## 0.2.0\n\n## 0.3.0\n- note\n")).toEqual([
			{ version: "0.2.0", notes: [] },
			{ version: "0.3.0", notes: ["note"] },
		]);
	});

	it("filters an upgrade range: from is exclusive, to inclusive, newest first", () => {
		const releases = parseChangelog(CHANGELOG);
		expect(releasesForUpgrade(releases, "0.12.0", "0.13.1").map((r) => r.version)).toEqual([
			"0.13.1",
			"0.13.0",
		]);
		expect(releasesForUpgrade(releases, "0.13.1", "0.13.1")).toEqual([]);
		expect(releasesForUpgrade(releases, "0.13.1", "0.12.0")).toEqual([]);
	});

	it("sorts releases newest first", () => {
		expect(sortReleasesDescending(parseChangelog(CHANGELOG))[0].version).toBe("0.13.1");
	});

	it("reads the version from a package manifest and rejects junk", () => {
		const dir = tempDir();
		const file = join(dir, "package.json");
		writeFileSync(file, JSON.stringify({ version: "0.13.1" }));
		expect(readPackageVersion(file)).toBe("0.13.1");
		writeFileSync(file, JSON.stringify({ version: "not-a-version" }));
		expect(readPackageVersion(file)).toBeUndefined();
		writeFileSync(file, "{ broken");
		expect(readPackageVersion(file)).toBeUndefined();
		expect(readPackageVersion(join(dir, "missing.json"))).toBeUndefined();
	});
});

describe("notice text", () => {
	it("caps notes per version and points at the changelog", () => {
		const releases = parseChangelog(CHANGELOG);
		const lines = renderReleaseSections(releasesForUpgrade(releases, "0.12.0", "0.13.1"), {
			maxNotesPerVersion: 3,
		});
		expect(lines).toContain("0.13.1");
		expect(lines.filter((line) => line.startsWith("  - fix"))).toHaveLength(3);
		expect(lines).toContain("  - (+4 more in CHANGELOG.md)");
	});

	it("caps versions and points at the changelog", () => {
		const releases = ["0.3.0", "0.2.0", "0.1.0"].map((version) => ({
			version,
			notes: ["note"],
		}));
		const lines = renderReleaseSections(releases, { maxVersions: 1 });
		expect(lines).toContain("(+2 older versions — see CHANGELOG.md)");
	});

	it("builds the upgrade title from the two versions", () => {
		const notice = buildUpgradeNotice("0.12.0", "0.13.1", []);
		expect(notice.title).toBe("pi-toolkits updated 0.12.0 → 0.13.1");
		expect(notice.lines).toContain("No release notes are bundled for this version.");
	});

});

describe("state store", () => {
	it("defaults to no recorded version", () => {
		const file = join(tempDir(), "state.json");
		const store = new WhatsNewStore(file);
		expect(store.get()).toEqual({});
	});

	it("round-trips lastSeenVersion", () => {
		const file = join(tempDir(), "nested", "state.json");
		const store = new WhatsNewStore(file);
		store.markSeen("0.13.0");
		expect(readState(file)).toEqual({ lastSeenVersion: "0.13.0" });
	});

	it("normalizes junk files and ignores invalid versions", () => {
		expect(normalizeState(null)).toEqual({});
		expect(normalizeState({ enabled: false, lastSeenVersion: "nope" })).toEqual({});
		const file = join(tempDir(), "state.json");
		writeFileSync(file, "{ broken");
		const store = new WhatsNewStore(file);
		expect(store.get()).toEqual({});
		store.markSeen("bad-version");
		expect(store.get()).toEqual({});
	});

	it("never throws when the state path is unusable", () => {
		const dir = tempDir();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const store = new WhatsNewStore(join(blocker, "state.json"));
		expect(() => store.markSeen("0.13.1")).not.toThrow();
		expect(existsSync(join(blocker, "state.json"))).toBe(false);
	});
});

describe("startup notice", () => {
	it("does not claim a global slash command", () => {
		const app = harness(fixture());
		expect(app.commands).toEqual([]);
	});

	it("stays silent on a fresh install and records the running version", () => {
		const files = fixture();
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		const { ctx } = makeCtx();
		app.start("startup", ctx);
		expect(app.entries).toHaveLength(0);
		expect(readState(files.storeFile).lastSeenVersion).toBe("0.13.1");
	});

	it("announces once after an upgrade, with only the new sections", () => {
		const files = fixture();
		mkdirSync(join(files.dir, "state"), { recursive: true });
		writeFileSync(
			files.storeFile,
			JSON.stringify({ lastSeenVersion: "0.12.0" }),
		);
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		const { ctx } = makeCtx();
		app.start("startup", ctx);

		expect(app.entries).toHaveLength(1);
		const data = app.entries[0].data as { title: string; lines: string[] };
		expect(data.title).toBe("pi-toolkits updated 0.12.0 → 0.13.1");
		expect(data.lines).toContain("0.13.1");
		expect(data.lines).toContain("0.13.0");
		expect(data.lines).not.toContain("0.12.0");
		expect(data.lines).not.toContain("  - old feature");
		expect(readState(files.storeFile).lastSeenVersion).toBe("0.13.1");
	});

	it("never announces the same version twice", () => {
		const files = fixture();
		mkdirSync(join(files.dir, "state"), { recursive: true });
		writeFileSync(
			files.storeFile,
			JSON.stringify({ lastSeenVersion: "0.12.0" }),
		);
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		app.start("startup", makeCtx({ sessionId: "first" }).ctx);
		app.start("startup", makeCtx({ sessionId: "second" }).ctx);
		expect(app.entries).toHaveLength(1);
	});

	it("deduplicates a repeated emission for the same session", () => {
		const files = fixture();
		mkdirSync(join(files.dir, "state"), { recursive: true });
		writeFileSync(
			files.storeFile,
			JSON.stringify({ lastSeenVersion: "0.12.0" }),
		);
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		const { ctx } = makeCtx({ sessionId: "same" });
		app.start("startup", ctx);
		app.start("startup", ctx);
		expect(app.entries).toHaveLength(1);
	});

	it("ignores every reason except a process startup", () => {
		const files = fixture();
		mkdirSync(join(files.dir, "state"), { recursive: true });
		writeFileSync(
			files.storeFile,
			JSON.stringify({ lastSeenVersion: "0.12.0" }),
		);
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		for (const reason of ["reload", "new", "resume", "fork"] as const) {
			app.start(reason, makeCtx({ sessionId: reason }).ctx);
		}
		expect(app.entries).toHaveLength(0);
		expect(readState(files.storeFile).lastSeenVersion).toBe("0.12.0");
	});

	it("stays silent outside the interactive TUI and does not consume the notice", () => {
		const files = fixture();
		mkdirSync(join(files.dir, "state"), { recursive: true });
		writeFileSync(
			files.storeFile,
			JSON.stringify({ lastSeenVersion: "0.12.0" }),
		);
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		for (const mode of ["print", "json", "rpc"] as const) {
			app.start("startup", makeCtx({ mode, sessionId: mode }).ctx);
		}
		expect(app.entries).toHaveLength(0);
		expect(readState(files.storeFile).lastSeenVersion).toBe("0.12.0");
	});


	it("does not announce a downgrade and keeps the recorded version", () => {
		const files = fixture({ version: "0.12.0" });
		mkdirSync(join(files.dir, "state"), { recursive: true });
		writeFileSync(
			files.storeFile,
			JSON.stringify({ lastSeenVersion: "0.13.1" }),
		);
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		app.start("startup", makeCtx().ctx);
		expect(app.entries).toHaveLength(0);
		expect(readState(files.storeFile).lastSeenVersion).toBe("0.13.1");
	});

	it("still reports the upgrade when the changelog has no section for it", () => {
		const files = fixture({ version: "0.14.0" });
		mkdirSync(join(files.dir, "state"), { recursive: true });
		writeFileSync(
			files.storeFile,
			JSON.stringify({ lastSeenVersion: "0.13.1" }),
		);
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: files.packageFile,
		});
		app.start("startup", makeCtx().ctx);
		const data = app.entries[0].data as { lines: string[] };
		expect(data.lines).toContain("No release notes are bundled for this version.");
	});

	it("uses an explicit version without reading package.json", () => {
		const files = fixture();
		const app = harness({
			storeFile: files.storeFile,
			changelogFile: files.changelogFile,
			packageFile: join(files.dir, "missing.json"),
			version: "0.13.0",
		});
		app.start("startup", makeCtx().ctx);
		expect(app.entries).toHaveLength(0);
		expect(readState(files.storeFile).lastSeenVersion).toBe("0.13.0");
	});
});

