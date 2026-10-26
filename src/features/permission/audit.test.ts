/**
 * Permission audit payload: the decomposition, the scope/effect of every
 * target, and the machine-readable rule layer must survive into the log.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPermissionAudit, commandDigest } from "./audit.js";
import { DEFAULT_MODES, type PermissionModes } from "./constants.js";
import { canonicalize } from "./paths.js";
import {
	decideProgram,
	decideUnit,
	type PolicyContext,
} from "./policy.js";
import { SessionRules } from "./session-rules.js";
import { parseCommandUnits } from "./units.js";

function project(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-audit-")));
}

function makeContext(
	cwd: string,
	modes: PermissionModes = DEFAULT_MODES,
	rules = new SessionRules(),
): PolicyContext {
	return { modes, roots: [canonicalize(cwd)], rules };
}

function audit(command: string, ctx: PolicyContext, prompt?: readonly string[]) {
	const units = parseCommandUnits(command, ctx.roots[0] ?? "/");
	return buildPermissionAudit({
		cwd: ctx.roots[0] ?? "/",
		modes: ctx.modes,
		roots: ctx.roots,
		units,
		unitDecisions: units.map((unit) => decideUnit(unit, ctx)),
		decision: decideProgram(units, ctx),
		...(prompt === undefined ? {} : { prompt }),
	});
}

describe("permission audit payload", () => {
	it("records the decomposition, target scope and deciding layer", () => {
		const cwd = project();
		const payload = audit("rm -rf /var/pi-perm-outside/x", makeContext(cwd));

		expect(payload.modes).toEqual({
			inRead: "allow",
			inWrite: "allow",
			outRead: "allow",
			outWrite: "ask",
		});
		expect(payload.roots).toEqual([canonicalize(cwd)]);
		expect(payload.units).toEqual([
			expect.objectContaining({
				head: "rm",
				command: "rm",
				args: ["-rf", "/var/pi-perm-outside/x"],
				base: canonicalize(cwd),
				effect: "write",
				opaque: false,
				action: "ask",
				layer: "mode",
				targets: [
					{
						path: "/var/pi-perm-outside/x",
						canonical: canonicalize("/var/pi-perm-outside/x"),
						effect: "write",
						source: "operand",
						scope: "out",
					},
				],
			}),
		]);
		expect(payload.verdict).toMatchObject({
			action: "ask",
			layer: "mode",
			unit: 0,
			target: canonicalize("/var/pi-perm-outside/x"),
			effect: "write",
			scope: "out",
			grantScope: "root",
			grantRoot: canonicalize("/var/pi-perm-outside"),
		});
	});

	it("keeps the secret-table layer for a denied credential read", () => {
		const cwd = project();
		const payload = audit(`cat ${homedir()}/.ssh/id_rsa`, makeContext(cwd));
		expect(payload.verdict).toMatchObject({
			action: "deny",
			layer: "secret",
			scope: "out",
			effect: "read",
		});
		expect(String((payload.verdict as Record<string, unknown>).reason)).toContain(
			"fixed safety table",
		);
	});

	it("marks an opaque command and records a command-scoped grant", () => {
		const cwd = project();
		const command = 'git -C "$DIR" log';
		const ctx = makeContext(cwd);
		const units = parseCommandUnits(command, cwd);
		const payload = audit(command, ctx);

		expect(units[0]?.opaque).toBe(true);
		expect((payload.units as Array<Record<string, unknown>>)[0]).toMatchObject({
			opaque: true,
			action: "ask",
			layer: "opaque",
		});
		expect(payload.verdict).toMatchObject({
			action: "ask",
			layer: "opaque",
			grantScope: "command",
			grantDigest: commandDigest(units),
		});
		expect(
			(payload.verdict as Record<string, unknown>).grantRoot,
		).toBeUndefined();
	});

	it("records an in-project mode allow with its layer", () => {
		const cwd = project();
		const payload = audit(`rm -rf ${cwd}/build`, makeContext(cwd));
		expect(payload.verdict).toMatchObject({
			action: "allow",
			layer: "mode",
			scope: "in",
		});
	});

	it("carries the exact prompt lines when asked", () => {
		const cwd = project();
		const payload = audit("rm -rf /var/pi-perm-outside/x", makeContext(cwd), [
			"Permission required",
			"Command: rm -rf /var/pi-perm-outside/x",
		]);
		expect(payload.prompt).toEqual([
			"Permission required",
			"Command: rm -rf /var/pi-perm-outside/x",
		]);
	});

	it("clips long arguments but keeps the target", () => {
		const cwd = project();
		const longArg = `--flag=${"x".repeat(2000)}`;
		const payload = audit(`rm -rf /var/pi-perm-outside/x ${longArg}`, makeContext(cwd));
		const unit = (payload.units as Array<Record<string, unknown>>)[0];
		const args = unit.args as string[];
		expect(args[2]).toContain("[+");
		expect(unit.targets).toHaveLength(1);
	});
});
