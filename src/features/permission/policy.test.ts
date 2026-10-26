/**
 * Policy decisions: defaults, fixed safety tables, session grants, severity
 * folding, and model-facing denial text.
 */
import { homedir } from "node:os";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODES, temporaryRoots, type PermissionModes } from "./constants.js";
import { canonicalize } from "./paths.js";
import {
	decideProgram,
	decisionEffect,
	decisionGrantRoot,
	formatDenial,
	type PolicyContext,
} from "./policy.js";
import { SessionRules } from "./session-rules.js";
import { parseCommandUnits } from "./units.js";

function project(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-policy-")));
}

function makeContext(
	cwd: string,
	modes: PermissionModes = DEFAULT_MODES,
	rules = new SessionRules(),
): PolicyContext {
	return { modes, roots: [canonicalize(cwd)], rules };
}

function decide(command: string, ctx: PolicyContext) {
	return decideProgram(parseCommandUnits(command, ctx.roots[0] ?? "/"), ctx);
}

describe("four-mode policy", () => {
	it("allows in-project reads and writes by default", () => {
		const cwd = project();
		const ctx = makeContext(cwd);
		expect(decide(`rm -rf ${cwd}/build`, ctx).action).toBe("allow");
		expect(decide(`cat ${cwd}/notes.txt`, ctx).action).toBe("allow");
	});

	it("asks for an outside write and allows an outside read by default", () => {
		const cwd = project();
		const ctx = makeContext(cwd);
		expect(decide("rm -rf /var/pi-perm-outside", ctx).action).toBe("ask");
		expect(decide("cat /etc/hostname", ctx).action).toBe("allow");
	});

	it("honours a deny mode for outside writes", () => {
		const cwd = project();
		const ctx = makeContext(cwd, { ...DEFAULT_MODES, outWrite: "deny" });
		const decision = decide("rm -rf /var/pi-perm-outside", ctx);
		expect(decision.action).toBe("deny");
		expect(decision.reason).toContain("outside-project write");
	});

	it("honours ask for in-project writes", () => {
		const cwd = project();
		const ctx = makeContext(cwd, { ...DEFAULT_MODES, inWrite: "ask" });
		expect(decide(`rm ${cwd}/x`, ctx).action).toBe("ask");
	});
});

describe("temporary write zone", () => {
	it("allows a temp write when the mode would otherwise ask", () => {
		const cwd = project();
		const ctx = makeContext(cwd);
		for (const root of temporaryRoots()) {
			const decision = decide(`echo hi > ${join(root, "pi-perm-temp.txt")}`, ctx);
			expect(decision.action).toBe("allow");
			expect(decision.layer).toBe("temp");
		}
	});

	it("still honours an explicit outside-write deny", () => {
		const cwd = project();
		const ctx = makeContext(cwd, { ...DEFAULT_MODES, outWrite: "deny" });
		const decision = decide(`echo hi > ${join(tmpdir(), "pi-perm-temp.txt")}`, ctx);
		expect(decision.action).toBe("deny");
		expect(decision.layer).toBe("mode");
	});

	it("still asks before deleting a temp root itself", () => {
		const cwd = project();
		const decision = decide(`rm -rf ${tmpdir()}`, makeContext(cwd));
		expect(decision.action).toBe("ask");
		expect(decision.layer).toBe("danger");
	});

	it("keeps the secrets table ahead of the temp zone", () => {
		const cwd = project();
		const decision = decide(
			`echo x > ${join(tmpdir(), ".env")}`,
			makeContext(cwd),
		);
		expect(decision.action).toBe("deny");
		expect(decision.layer).toBe("secret");
	});
});

describe("fixed safety table", () => {
	it("denies credential paths in every mode, even when reads are allowed", () => {
		const cwd = project();
		const ctx = makeContext(cwd);
		const ssh = decide(`cat ${homedir()}/.ssh/id_rsa`, ctx);
		expect(ssh.action).toBe("deny");
		expect(ssh.reason).toContain("credentials");
	});

	it("denies .env files but not their templates", () => {
		const cwd = project();
		writeFileSync(join(cwd, ".env"), "SECRET=1");
		const ctx = makeContext(cwd);
		expect(decide(`cat ${cwd}/.env`, ctx).action).toBe("deny");
		expect(decide(`cat ${cwd}/.env.example`, ctx).action).toBe("allow");
	});

	it("does not let a session allow override the secrets table", () => {
		const cwd = project();
		const rules = new SessionRules();
		rules.allow({ effect: "read", root: join(homedir(), ".ssh") });
		const ctx = makeContext(cwd, DEFAULT_MODES, rules);
		expect(decide(`cat ${homedir()}/.ssh/id_rsa`, ctx).action).toBe("deny");
	});

	it("denies a privileged read of a credential instead of asking", () => {
		const cwd = project();
		expect(decide(`sudo cat ${homedir()}/.ssh/id_rsa`, makeContext(cwd)).action).toBe(
			"deny",
		);
	});

	it("asks for destructive commands even inside the project", () => {
		const cwd = project();
		const ctx = makeContext(cwd);
		const decision = decide("rm -rf .", ctx);
		expect(decision.action).toBe("ask");
		expect(decision.reason).toContain("recursive delete");
	});

	it("asks for a forced push and a privileged command", () => {
		const cwd = project();
		const ctx = makeContext(cwd);
		expect(decide("git push --force", ctx).action).toBe("ask");
		expect(decide("sudo rm x", ctx).action).toBe("ask");
	});
});

describe("session grants", () => {
	it("allows a write under a granted directory", () => {
		const cwd = project();
		const rules = new SessionRules();
		rules.allow({ effect: "write", root: "/var/pi-perm-granted" });
		expect(
			decide("rm -rf /var/pi-perm-granted/x", makeContext(cwd, DEFAULT_MODES, rules)).action,
		).toBe("allow");
	});

	it("does not let a read grant cover a write", () => {
		const cwd = project();
		const rules = new SessionRules();
		rules.allow({ effect: "read", root: "/var/pi-perm-granted" });
		expect(
			decide("rm -rf /var/pi-perm-granted/x", makeContext(cwd, DEFAULT_MODES, rules)).action,
		).toBe("ask");
	});

	it("denies before allowing, even when the mode allows", () => {
		const cwd = project();
		const rules = new SessionRules();
		rules.deny({ effect: "read", root: "/var/pi-perm-granted" });
		const decision = decide("cat /var/pi-perm-granted/x", makeContext(cwd, DEFAULT_MODES, rules));
		expect(decision.action).toBe("deny");
		expect(decision.reason).toContain("denied for this session");
	});

	it("clears grants", () => {
		const rules = new SessionRules();
		rules.allow({ effect: "write", root: "/tmp/x" });
		rules.deny({ effect: "read", root: "/tmp/y" });
		expect(rules.counts()).toEqual({ allow: 1, deny: 1 });
		rules.clear();
		expect(rules.counts()).toEqual({ allow: 0, deny: 0 });
	});
});

describe("severity folding", () => {
	it("takes the strictest unit of a compound command", () => {
		const cwd = project();
		const ctx = makeContext(cwd, { ...DEFAULT_MODES, outWrite: "deny" });
		const decision = decide(`cd ${cwd} && rm -rf /var/pi-perm-outside`, ctx);
		expect(decision.action).toBe("deny");
	});

	it("does not let an allowed first segment mask a later ask", () => {
		const cwd = project();
		const decision = decide("echo hi && rm -rf /var/pi-perm-outside", makeContext(cwd));
		expect(decision.action).toBe("ask");
	});
});

describe("fail closed", () => {
	it("asks for an opaque unit regardless of mode", () => {
		const cwd = project();
		const ctx = makeContext(cwd, {
			inRead: "allow",
			inWrite: "allow",
			outRead: "allow",
			outWrite: "allow",
		});
		const decision = decide('cd "$DIR" && rm x', ctx);
		expect(decision.action).toBe("ask");
	});
});

describe("decision helpers", () => {
	it("derives the grant root and effect", () => {
		const cwd = project();
		writeFileSync(join(cwd, "notes.txt"), "x");
		const decision = decide(`rm ${cwd}/notes.txt`, makeContext(cwd));
		expect(decisionGrantRoot(decision, () => cwd)).toBe(cwd);
		expect(decisionEffect(decision)).toBe("write");
	});

	it("formats a denial for the model", () => {
		const cwd = project();
		const decision = decide(
			"cat ~/.ssh/id_rsa",
			makeContext(cwd),
		);
		const text = formatDenial(decision);
		expect(text).toContain("Permission denied");
		expect(text).toContain("/ask-perm");
		expect(text).toContain("Do not retry");
	});
});

describe("session grants versus the danger table", () => {
	it("lets a session allow cover a destructive command", () => {
		const cwd = project();
		const rules = new SessionRules();
		expect(decide("rm -rf .", makeContext(cwd, DEFAULT_MODES, rules)).action).toBe(
			"ask",
		);
		rules.allow({ effect: "write", root: canonicalize(cwd) });
		expect(decide("rm -rf .", makeContext(cwd, DEFAULT_MODES, rules)).action).toBe(
			"allow",
		);
	});

	it("turns a session deny on a dangerous command into a denial", () => {
		const cwd = project();
		const rules = new SessionRules();
		rules.deny({ effect: "write", root: canonicalize(cwd) });
		expect(decide("git push --force", makeContext(cwd, DEFAULT_MODES, rules)).action).toBe(
			"deny",
		);
	});

	it("covers a repeat of the exact opaque command", () => {
		const cwd = project();
		const rules = new SessionRules();
		const units = parseCommandUnits('cd "$DIR" && rm x', cwd);
		const key = units.map((unit) => unit.raw).join(" ; ");
		rules.allowCommand(key);
		expect(decideProgram(units, makeContext(cwd, DEFAULT_MODES, rules)).action).toBe(
			"allow",
		);
	});
});
