/**
 * Fixed safety tables: credential paths are denied in every mode, destructive
 * commands always ask.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./paths.js";
import {
	dangerReason,
	isTemporaryPath,
	secretReason,
	temporaryRoots,
} from "./constants.js";

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

describe("temporary write zone", () => {
	it("covers the OS temp root and the common volatile directories", () => {
		expect(temporaryRoots()).toContain(canonicalize(tmpdir()));
		expect(temporaryRoots()).toContain(canonicalize("/var/tmp"));
		expect(temporaryRoots()).toContain(canonicalize("/dev/shm"));
		expect(isTemporaryPath(join(tmpdir(), "pi", "x"))).toBe(true);
		expect(isTemporaryPath(join("/var/tmp", "x"))).toBe(true);
		expect(isTemporaryPath(join("/dev/shm", "x"))).toBe(true);
	});

	it("does not over-match a sibling prefix or an ordinary path", () => {
		expect(isTemporaryPath(`${tmpdir()}-evil/x`)).toBe(false);
		expect(isTemporaryPath("/var/tmp-evil/x")).toBe(false);
		expect(isTemporaryPath("/proj/x")).toBe(false);
	});
});

describe("danger table", () => {
	it("catches the destructive core", () => {
		expect(dangerReason("rm", ["-rf", "/"], ["/"], "/proj")).toContain("recursive delete");
		expect(dangerReason("rm", ["-rf", HOME], [HOME], "/proj")).toContain("recursive delete");
		expect(dangerReason("rm", ["-rf", "/proj"], ["/proj"], "/proj")).toContain("recursive delete");
		expect(dangerReason("rm", ["-rf", tmpdir()], [tmpdir()], "/proj")).toContain("recursive delete");
		expect(dangerReason("rm", ["-rf", "/var/tmp"], ["/var/tmp"], "/proj")).toContain("recursive delete");
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
		expect(dangerReason("rm", ["-rf", join(tmpdir(), "x")], [join(tmpdir(), "x")], "/proj")).toBeUndefined();
		expect(dangerReason("git", ["push"], [], "/proj")).toBeUndefined();
		expect(dangerReason("git", ["log"], [], "/proj")).toBeUndefined();
		expect(dangerReason("npm", ["view", "react"], [], "/proj")).toBeUndefined();
	});
});
