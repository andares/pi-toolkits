/**
 * plan opener — get the review into the operator's *Windows* browser.
 *
 * Measured on this machine (WSL2, NAT, no `localhostForwarding`):
 *   - Windows cannot reach a server bound to 127.0.0.1 inside WSL, and cannot
 *     reach `localhost:<port>` either — only `<wsl-ip>:<port>` works;
 *   - `xdg-open` resolves to `/usr/bin/google-chrome`, i.e. a browser *inside*
 *     WSL, which is exactly the failure this module exists to avoid.
 *
 * So: on WSL bind 0.0.0.0 and print the eth0 address, then hand the URL to a
 * Windows-side opener (`wslview`, `cmd.exe /c start`, `powershell Start-Process`)
 * before ever considering `xdg-open`.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

export interface OpenerPlan {
	command: string;
	args: string[];
	/** cwd for the child — cmd.exe warns when it starts in a UNC (\\wsl.localhost) path. */
	cwd?: string;
}

export interface OpenerOptions {
	/** Whether we are inside WSL. */
	wsl: boolean;
	/** Which helpers exist on PATH. */
	has: (command: string) => boolean;
	platform?: NodeJS.Platform;
}

export function isWsl(env: NodeJS.ProcessEnv = process.env, procVersion?: string): boolean {
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	const version =
		procVersion ??
		(() => {
			try {
				return readFileSync("/proc/version", "utf8");
			} catch {
				return "";
			}
		})();
	return /microsoft/i.test(version);
}

/** First non-internal IPv4 address — the address Windows must use under NAT. */
export function primaryIPv4(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return undefined;
}

/** Address the review server binds to. */
export function bindHost(wsl: boolean): string {
	return wsl ? "0.0.0.0" : "127.0.0.1";
}

/** Host to put in the printed URL (what the browser will connect to). */
export function urlHost(wsl: boolean): string {
	if (!wsl) return "127.0.0.1";
	return primaryIPv4() ?? "127.0.0.1";
}

/**
 * Pick the command that opens `url`, preferring the Windows side on WSL.
 * Returns undefined when nothing suitable exists (the caller just prints the URL).
 */
export function pickOpener(url: string, options: OpenerOptions): OpenerPlan | undefined {
	const { wsl, has } = options;
	if (wsl) {
		if (has("wslview")) return { command: "wslview", args: [url] };
		if (has("cmd.exe")) {
			// `start "" <url>`: the empty title is mandatory, otherwise the URL
			// itself is taken for the window title. cwd must be a Windows path.
			return { command: "cmd.exe", args: ["/c", "start", "", url], cwd: "/mnt/c" };
		}
		if (has("powershell.exe")) {
			return {
				command: "powershell.exe",
				args: ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`],
			};
		}
	}
	if (options.platform === "darwin") return { command: "open", args: [url] };
	if (has("xdg-open")) return { command: "xdg-open", args: [url] };
	return undefined;
}

/** Whether a command is on PATH (no shell, no side effects). */
export function commandExists(command: string): boolean {
	const probe = process.platform === "win32" ? ["where", command] : ["sh", "-c", `command -v ${command}`];
	const result = spawnSync(probe[0], probe.slice(1), { stdio: "ignore" });
	return result.status === 0;
}

/** Open the URL. Returns the plan used, or undefined when the caller must print it. */
export function openInBrowser(url: string): OpenerPlan | undefined {
	const wsl = isWsl();
	const plan = pickOpener(url, { wsl, has: commandExists });
	if (!plan) return undefined;
	try {
		const child = spawn(plan.command, plan.args, {
			cwd: plan.cwd,
			detached: true,
			stdio: "ignore",
		});
		// commandExists() is only a probe: the executable can still disappear or
		// fail before spawn. Without a listener that asynchronous `error` event is
		// unhandled and can take down the pi process; the printed URL is the
		// recovery path either way.
		child.once("error", () => {});
		child.unref();
		return plan;
	} catch {
		return undefined;
	}
}
