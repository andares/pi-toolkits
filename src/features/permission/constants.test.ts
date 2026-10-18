/**
 * Fixed safety tables: credential paths are denied in every mode, destructive
 * commands always ask.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dangerReason, secretReason } from "./constants.js";

const HOME = homedir();

describe("secrets table", () => {
	it("covers the credential directories exactly", () => {
		expect(secretReason(join(HOME, ".ssh", "id_rsa"))).toBe("credentials");
		expect(secretReason(join(HOME, ".ssh"))).toBe("credentials");
		expect(secretReason(join(HOME, ".gnupg", "private-keys-v1.d"))).toBe("credentials");
		expect(secretReason(join(HOME, ".aws", "credentials"))).toBe("credentials");
	});

	it("does not over-match a sibling prefix", () => {
		expect(secretReason(join(HOME, ".ssh-easy", "x"))).toBeUndefined();
		expect(secretReason(join(HOME, ".ssh_evil", "x"))).toBeUndefined();
		expect(secretReason(join(HOME, ".awsconfig", "x"))).toBeUndefined();
	});

	it("covers pi auth files but nothing else under the agent dir", () => {
		expect(secretReason(join(HOME, ".pi", "agent", "auth.json"))).toBe("pi credentials");
		expect(secretReason(join(HOME, ".pi", "agent", "auth-foo.json"))).toBe("pi credentials");
		expect(secretReason(join(HOME, ".pi", "agent", "settings.json"))).toBeUndefined();
		expect(secretReason(join(HOME, ".pi", "agent", "xauth", "auth.json"))).toBeUndefined();
	});

	it("covers .env files but not the templates", () => {
		expect(secretReason("/proj/.env")).toBe("environment file");
		expect(secretReason("/proj/.env.local")).toBe("environment file");
		expect(secretReason("/proj/.env.example")).toBeUndefined();
	});
});

describe("danger table", () => {
	it("catches the destructive core", () => {
		expect(dangerReason("rm", ["-rf", "/"], ["/"], "/proj")).toContain("recursive delete");
		expect(dangerReason("rm", ["-rf", HOME], [HOME], "/proj")).toContain("recursive delete");
		expect(dangerReason("rm", ["-rf", "/proj"], ["/proj"], "/proj")).toContain("recursive delete");
		expect(dangerReason("git", ["push", "--force"], [], "/proj")).toBe("forced git push");
		expect(dangerReason("git", ["push", "-f"], [], "/proj")).toBe("forced git push");
		expect(dangerReason("git", ["reset", "--hard"], [], "/proj")).toBe("git reset --hard");
		expect(dangerReason("git", ["clean", "-fd"], [], "/proj")).toBe("git clean -f");
		expect(dangerReason("npm", ["publish"], [], "/proj")).toBe("package publish");
		expect(dangerReason("dd", ["of=/dev/sda"], ["/dev/sda"], "/proj")).toBe("raw device write");
		expect(dangerReason("sudo", ["rm", "x"], ["/proj/x"], "/proj")).toBe("privileged command");
	});

	it("does not flag ordinary commands", () => {
		expect(dangerReason("rm", ["-rf", "/proj/build"], ["/proj/build"], "/proj")).toBeUndefined();
		expect(dangerReason("git", ["push"], [], "/proj")).toBeUndefined();
		expect(dangerReason("git", ["log"], [], "/proj")).toBeUndefined();
		expect(dangerReason("npm", ["view", "react"], [], "/proj")).toBeUndefined();
	});
});
