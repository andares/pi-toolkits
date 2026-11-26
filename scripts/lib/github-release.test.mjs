/**
 * Release plumbing tests — the parts that hung.
 *
 * v1.2.1 (2026-11-26) ended with `pnpm release` printing the tail self-check
 * header and then nothing for ~47 minutes, because `git ls-remote` was waiting
 * on a dead ssh connection: `spawnSync` had no timeout, ssh has none of its own,
 * and a blocked event loop means no JS watchdog can fire either. These tests pin
 * the three things that make that impossible now:
 *
 *   - every spawn is bounded (timeout + SIGKILL), ssh included;
 *   - a killed child is reported as `unknown`, never as `absent` — only one of
 *     those is a fact, and the difference decides what the operator does next;
 *   - curl cannot sit on a stalled connection either.
 */
import { describe, expect, it } from "vitest";
import {
	CURL_TIMEOUT_MS,
	GIT_TIMEOUT_MS,
	boundedSshCommand,
	githubApi,
	releaseTailGap,
} from "./github-release.mjs";

const LOCAL_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

/** Fake `git`: answers by subcommand, records what it was asked to do. */
function fakeGit({ revParse = LOCAL_SHA, lsRemote = LOCAL_SHA, timeoutOn = "" } = {}) {
	const calls = [];
	const spawn = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		const sub = args[0];
		if (timeoutOn === sub) {
			return { status: null, signal: "SIGKILL", stdout: "", stderr: "" };
		}
		const stdout =
			sub === "rev-parse"
				? `${revParse}\n`
				: lsRemote
					? `${lsRemote}\trefs/tags/v1\n`
					: "";
		return { status: 0, stdout, stderr: "" };
	};
	return { spawn, calls };
}

describe("boundedSshCommand", () => {
	it("adds the deadlines when nothing is configured", () => {
		const command = boundedSshCommand(undefined);
		expect(command).toContain("ConnectTimeout=10");
		expect(command).toContain("ServerAliveInterval=5");
		expect(command).toContain("BatchMode=yes");
	});

	it("keeps the operator's own flags", () => {
		const command = boundedSshCommand("ssh -i ~/.ssh/release_key");
		expect(command.startsWith("ssh -i ~/.ssh/release_key")).toBe(true);
		expect(command).toContain("ServerAliveCountMax=3");
	});

	it("does not stack deadlines onto a command that already has them", () => {
		const already = "ssh -o ServerAliveInterval=5 -o ConnectTimeout=2";
		expect(boundedSshCommand(already)).toBe(already);
	});
});

describe("gitToolkit bounds (through releaseTailGap)", () => {
	it("passes a timeout, a kill signal and a bounded ssh command to git", async () => {
		const { spawn, calls } = fakeGit();
		const res = await releaseTailGap({ cwd: "/tmp", tag: "v1", spawn });

		expect(res.state).toBe("ok");
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.opts.timeout).toBe(GIT_TIMEOUT_MS);
			expect(call.opts.killSignal).toBe("SIGKILL");
			expect(call.opts.env.GIT_SSH_COMMAND).toContain("ServerAliveInterval=5");
		}
	});

	it("reports a killed ls-remote as unknown, not as an absent ref", async () => {
		const { spawn } = fakeGit({ timeoutOn: "ls-remote" });
		const res = await releaseTailGap({ cwd: "/tmp", tag: "v1", spawn });

		expect(res.state).toBe("unknown");
		expect(res.localSha).toBe(LOCAL_SHA);
	});

	it("reports a killed rev-parse as unknown, not as a missing local tag", async () => {
		const { spawn } = fakeGit({ timeoutOn: "rev-parse" });
		const res = await releaseTailGap({ cwd: "/tmp", tag: "v1", spawn });

		expect(res.state).toBe("unknown");
	});

	it("still distinguishes a real mismatch and a real absent ref", async () => {
		const mismatch = await releaseTailGap({
			cwd: "/tmp",
			tag: "v1",
			spawn: fakeGit({ lsRemote: OTHER_SHA }).spawn,
		});
		expect(mismatch.state).toBe("mismatch");

		const absent = await releaseTailGap({
			cwd: "/tmp",
			tag: "v1",
			spawn: fakeGit({ lsRemote: "" }).spawn,
		});
		expect(absent.state).toBe("absent");
	});
});

describe("githubApi curl bounds", () => {
	it("carries connect and total timeouts and a kill switch", () => {
		let captured;
		const spawn = (cmd, args, opts) => {
			captured = { cmd, args, opts };
			return { status: 0, stdout: '{"ok":true}\n200', stderr: "" };
		};
		const res = githubApi({
			repo: "andares/pi-toolkits",
			path: "/releases/tags/v1",
			spawn,
		});

		expect(res.code).toBe(200);
		expect(captured.args).toContain("--max-time");
		expect(captured.args[captured.args.indexOf("--max-time") + 1]).toBe(
			String(Math.round(CURL_TIMEOUT_MS / 1000)),
		);
		expect(captured.args).toContain("--connect-timeout");
		expect(captured.opts.timeout).toBeGreaterThan(CURL_TIMEOUT_MS);
		expect(captured.opts.killSignal).toBe("SIGKILL");
	});
});
