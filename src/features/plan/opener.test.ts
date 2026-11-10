import { describe, expect, it } from "vitest";
import { bindHost, isWsl, pickOpener, urlHost } from "./opener.js";

const URL_UNDER_TEST = "http://172.24.47.146:3401/?t=abc";

describe("isWsl", () => {
	it("detects WSL from the environment", () => {
		expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu-24.04" } as NodeJS.ProcessEnv, "")).toBe(true);
		expect(isWsl({ WSL_INTEROP: "/run/WSL/1_interop" } as NodeJS.ProcessEnv, "")).toBe(true);
	});

	it("detects WSL from the kernel string", () => {
		expect(isWsl({} as NodeJS.ProcessEnv, "Linux version 6.18.33.2-microsoft-standard-WSL2")).toBe(true);
		expect(isWsl({} as NodeJS.ProcessEnv, "Linux version 6.8.0-generic")).toBe(false);
	});
});

describe("bindHost / urlHost", () => {
	it("binds everything on WSL, because Windows cannot reach 127.0.0.1 there", () => {
		expect(bindHost(true)).toBe("0.0.0.0");
		expect(bindHost(false)).toBe("127.0.0.1");
	});

	it("never puts 0.0.0.0 in the URL", () => {
		expect(urlHost(false)).toBe("127.0.0.1");
		expect(urlHost(true)).not.toBe("0.0.0.0");
	});
});

describe("pickOpener", () => {
	const has = (...commands: string[]) => (command: string) => commands.includes(command);

	it("prefers wslview on WSL", () => {
		expect(pickOpener(URL_UNDER_TEST, { wsl: true, has: has("wslview", "cmd.exe") })).toEqual({
			command: "wslview",
			args: [URL_UNDER_TEST],
		});
	});

	it("falls back to cmd.exe start with an empty window title and a Windows cwd", () => {
		const plan = pickOpener(URL_UNDER_TEST, { wsl: true, has: has("cmd.exe", "xdg-open") });
		expect(plan).toEqual({
			command: "cmd.exe",
			args: ["/c", "start", "", URL_UNDER_TEST],
			cwd: "/mnt/c",
		});
	});

	it("falls back to powershell Start-Process and escapes single quotes", () => {
		const plan = pickOpener("http://x/?t=it's", { wsl: true, has: has("powershell.exe") });
		expect(plan?.command).toBe("powershell.exe");
		expect(plan?.args.join(" ")).toContain("Start-Process 'http://x/?t=it''s'");
	});

	it("never prefers xdg-open on WSL — it would launch the WSL-internal chrome", () => {
		const plan = pickOpener(URL_UNDER_TEST, { wsl: true, has: has("xdg-open") });
		expect(plan).toEqual({ command: "xdg-open", args: [URL_UNDER_TEST] });
		// …only as the last resort, after every Windows-side opener is missing.
		expect(pickOpener(URL_UNDER_TEST, { wsl: true, has: has("cmd.exe", "xdg-open") })?.command).toBe("cmd.exe");
	});

	it("uses open on macOS and xdg-open elsewhere", () => {
		expect(pickOpener(URL_UNDER_TEST, { wsl: false, has: has(), platform: "darwin" })?.command).toBe("open");
		expect(pickOpener(URL_UNDER_TEST, { wsl: false, has: has("xdg-open"), platform: "linux" })?.command).toBe(
			"xdg-open",
		);
	});

	it("returns undefined when nothing can open it", () => {
		expect(pickOpener(URL_UNDER_TEST, { wsl: false, has: has(), platform: "linux" })).toBeUndefined();
	});
});
