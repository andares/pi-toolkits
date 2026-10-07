/**
 * autostart feature tests.
 *
 * Pure-logic coverage for parseAutostartConfig / commandNameOf, plus an
 * integration pass over registerAutostart with a minimal mock of the pi
 * extension surface (on/getCommands/sendUserMessage) and ExtensionContext
 * (cwd/isProjectTrusted/ui.notify), using a temp directory for the config
 * file.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AUTOSTART_CONFIG_PATH,
	AutostartParseError,
	commandNameOf,
	parseAutostartConfig,
	RUNNABLE_REASONS,
} from "./autostart.js";
import { registerAutostart } from "./index.js";

describe("parseAutostartConfig", () => {
	it("parses a full config into the ordered command list", () => {
		const text = [
			"# project autostart",
			"version = 1",
			"",
			"[command]",
			'run = ["/add-dir ../shop-frontend", "/add-dir ../shop-api"]',
		].join("\n");
		expect(parseAutostartConfig(text)).toEqual([
			"/add-dir ../shop-frontend",
			"/add-dir ../shop-api",
		]);
	});

	it("accepts a config without version (defaults to 1)", () => {
		expect(parseAutostartConfig('[command]\nrun = ["/ask on"]')).toEqual([
			"/ask on",
		]);
	});

	it("returns empty for a config without [command] or run", () => {
		expect(parseAutostartConfig("version = 1")).toEqual([]);
		expect(parseAutostartConfig("[command]\n")).toEqual([]);
	});

	it("drops blank entries", () => {
		expect(
			parseAutostartConfig('[command]\nrun = ["/ask on", "  "]'),
		).toEqual(["/ask on"]);
	});

	it("rejects [[command]] array tables instead of ignoring them", () => {
		expect(() =>
			parseAutostartConfig('[[command]]\nrun = ["/ask on"]'),
		).toThrow(AutostartParseError);
	});

	it("normalizes whitespace out of commands", () => {
		expect(
			parseAutostartConfig('[command]\nrun = ["  /add-dir ../x  "]'),
		).toEqual(["/add-dir ../x"]);
	});

	it("rejects version != 1", () => {
		expect(() =>
			parseAutostartConfig("version = 2\n[command]\nrun = []"),
		).toThrow(AutostartParseError);
	});

	it("rejects invalid TOML", () => {
		expect(() => parseAutostartConfig("[command\nrun = [")).toThrow(
			AutostartParseError,
		);
	});

	it("rejects [command].run that is not a string array", () => {
		expect(() => parseAutostartConfig('[command]\nrun = "/ask on"')).toThrow(
			AutostartParseError,
		);
		expect(() => parseAutostartConfig("[command]\nrun = [1, 2]")).toThrow(
			AutostartParseError,
		);
	});
});

describe("commandNameOf", () => {
	it("extracts the command name from a slash command with args", () => {
		expect(commandNameOf("/add-dir ../shop-frontend")).toBe("add-dir");
	});
	it("tolerates missing slash, extra whitespace, and bare command", () => {
		expect(commandNameOf("add-dir ../x")).toBe("add-dir");
		expect(commandNameOf("  /add-dir   ../x  ")).toBe("add-dir");
		expect(commandNameOf("/ask")).toBe("ask");
	});
	it("returns empty for blank input", () => {
		expect(commandNameOf("   ")).toBe("");
	});
});

describe("RUNNABLE_REASONS", () => {
	it("replays startup/new/fork and not resume/reload", () => {
		expect(RUNNABLE_REASONS.has("startup")).toBe(true);
		expect(RUNNABLE_REASONS.has("new")).toBe(true);
		expect(RUNNABLE_REASONS.has("fork")).toBe(true);
		expect(RUNNABLE_REASONS.has("resume")).toBe(false);
		expect(RUNNABLE_REASONS.has("reload")).toBe(false);
	});
});

/* ------------------------------------------------------------------ */
/* registerAutostart integration (mocked pi surface)                   */
/* ------------------------------------------------------------------ */

type SessionStartHandler = (
	event: { reason: string },
	ctx: {
		cwd: string;
		isProjectTrusted: () => boolean;
		ui: { notify: (message: string, type?: string) => void };
	},
) => Promise<void>;

interface Harness {
	cwd: string;
	handler: SessionStartHandler;
	sent: Array<{ command: string; options?: { expandPromptTemplates?: boolean } }>;
	notifications: Array<{ message: string; type?: string }>;
	commands: Array<{ name: string; source: string }>;
	failCommands: Set<string>;
	setTrusted(trusted: boolean): void;
	start(reason: string): Promise<void>;
}

async function makeHarness(
	config: string | null,
	configAsDir = false,
): Promise<Harness> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-autostart-test-"));
	if (configAsDir) {
		// EISDIR setup: the config path exists but is a directory.
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await mkdir(join(cwd, AUTOSTART_CONFIG_PATH));
	} else if (config !== null) {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, AUTOSTART_CONFIG_PATH), config, "utf8");
	}
	let trusted = true;
	let handler: SessionStartHandler = async () => {};
	const sent: Harness["sent"] = [];
	const notifications: Harness["notifications"] = [];
	const commands: Harness["commands"] = [
		{ name: "add-dir", source: "extension" },
		{ name: "ask", source: "extension" },
	];
	const failCommands = new Set<string>();
	const pi = {
		on: (event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		},
		getCommands: () => commands,
		sendUserMessage: (
			command: string,
			options?: { expandPromptTemplates?: boolean },
		) => {
			sent.push({ command, options }); // records attempts, including failures
			if (failCommands.has(command)) {
				return Promise.reject(new Error("boom"));
			}
		},
	} as unknown as ExtensionAPI;
	registerAutostart(pi);
	return {
		handler,
		sent,
		notifications,
		commands,
		failCommands,
		setTrusted(value: boolean) {
			trusted = value;
		},
		async start(reason: string) {
			await handler({ reason }, {
				cwd,
				isProjectTrusted: () => trusted,
				ui: {
					notify: (message: string, type?: string) => {
						notifications.push({ message, type });
					},
				},
			});
		},
		cwd,
	};
}

let current: Harness | undefined;

afterEach(async () => {
	if (current) {
		await rm(current.cwd, { recursive: true, force: true });
		current = undefined;
	}
});

async function harness(
	config: string | null,
	configAsDir = false,
): Promise<Harness> {
	const h = await makeHarness(config, configAsDir);
	current = h;
	return h;
}

describe("registerAutostart", () => {
	const fullConfig =
		'version = 1\n[command]\nrun = ["/add-dir ../frontend", "/add-dir ../api"]';

	it("dispatches configured commands with expandPromptTemplates on startup", async () => {
		const h = await harness(fullConfig);
		await h.start("startup");
		expect(h.sent).toEqual([
			{ command: "/add-dir ../frontend", options: { expandPromptTemplates: true } },
			{ command: "/add-dir ../api", options: { expandPromptTemplates: true } },
		]);
		expect(h.notifications).toEqual([]);
	});

	it("reports parse errors and dispatches nothing", async () => {
		const h = await harness("/[command]\nrun = [");
		await h.start("startup");
		expect(h.sent).toEqual([]);
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0]?.type).toBe("error");
	});

	it("replays on new and fork", async () => {
		const h = await harness('[command]\nrun = ["/ask on"]');
		await h.start("new");
		await h.start("fork");
		expect(h.sent).toEqual([
			{ command: "/ask on", options: { expandPromptTemplates: true } },
			{ command: "/ask on", options: { expandPromptTemplates: true } },
		]);
		expect(h.notifications).toEqual([]);
	});

	it("does nothing on resume or reload", async () => {
		const h = await harness(fullConfig);
		await h.start("resume");
		await h.start("reload");
		expect(h.sent).toEqual([]);
		expect(h.notifications).toEqual([]);
	});

	it("silently skips when no config file exists", async () => {
		const h = await harness(null);
		await h.start("startup");
		expect(h.sent).toEqual([]);
		expect(h.notifications).toEqual([]);
	});

	it("skips everything when the project is not trusted", async () => {
		const h = await harness(fullConfig);
		h.setTrusted(false);
		await h.start("startup");
		expect(h.sent).toEqual([]);
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0]?.type).toBe("warning");
	});

	it("skips unregistered commands instead of sending them to the model", async () => {
		const h = await harness(
			'[command]\nrun = ["/add-dir ../x", "/not-a-command y"]',
		);
		await h.start("startup");
		expect(h.sent).toEqual([
			{ command: "/add-dir ../x", options: { expandPromptTemplates: true } },
		]);
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0]?.type).toBe("warning");
	});

	it("skips commands only registered as skill or prompt sources", async () => {
		const h = await harness('[command]\nrun = ["/add-dir ../x"]');
		h.commands.length = 0;
		h.commands.push({ name: "add-dir", source: "skill" });
		await h.start("startup");
		expect(h.sent).toEqual([]);
		expect(h.notifications).toHaveLength(1);
	});

	it("warns when the config path cannot be read for a reason other than ENOENT", async () => {
		const h = await harness(null, true); // .pi/autostart.toml is a directory → EISDIR
		await h.start("startup");
		expect(h.sent).toEqual([]);
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0]?.type).toBe("warning");
	});

	it("keeps dispatching after one command fails", async () => {
		const h = await harness(fullConfig);
		h.failCommands.add("/add-dir ../frontend");
		await h.start("startup");
		expect(h.sent.map((entry) => entry.command)).toEqual([
			"/add-dir ../frontend",
			"/add-dir ../api",
		]);
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0]?.type).toBe("error");
	});
});
