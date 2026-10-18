/**
 * Mode defaults, argument parsing, and formatting.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MODES, IN_VALUES, OUT_VALUES } from "./constants.js";
import { formatModes, parsePermissionArgs, shortMode } from "./modes.js";

describe("modes", () => {
	it("ships the documented defaults", () => {
		expect(DEFAULT_MODES).toEqual({
			inRead: "allow",
			inWrite: "allow",
			outRead: "allow",
			outWrite: "ask",
		});
		expect(IN_VALUES).toEqual(["allow", "ask"]);
		expect(OUT_VALUES).toEqual(["allow", "ask", "deny"]);
	});

	it("merges missing arguments from the defaults", () => {
		expect(parsePermissionArgs("ask")).toEqual({
			modes: { inRead: "ask", inWrite: "allow", outRead: "allow", outWrite: "ask" },
		});
		expect(parsePermissionArgs("ask ask")).toEqual({
			modes: { inRead: "ask", inWrite: "ask", outRead: "allow", outWrite: "ask" },
		});
		expect(parsePermissionArgs("ask allow deny deny")).toEqual({
			modes: { inRead: "ask", inWrite: "allow", outRead: "deny", outWrite: "deny" },
		});
	});

	it("uses the current defaults, not the previous mode, for omitted arguments", () => {
		const parsed = parsePermissionArgs("allow");
		expect("modes" in parsed ? parsed.modes : undefined).toEqual(DEFAULT_MODES);
	});

	it("rejects deny for in-project modes", () => {
		expect(parsePermissionArgs("deny")).toEqual({
			error: expect.stringContaining("in-read"),
		});
	});

	it("rejects unknown values and too many arguments", () => {
		expect(parsePermissionArgs("maybe")).toEqual({
			error: expect.stringContaining("in-read"),
		});
		expect(parsePermissionArgs("allow allow allow nope")).toEqual({
			error: expect.stringContaining("out-write"),
		});
		expect(parsePermissionArgs("allow allow allow ask extra")).toEqual({
			error: expect.stringContaining("at most 4"),
		});
		expect(parsePermissionArgs("")).toEqual({
			error: expect.stringContaining("at least one"),
		});
	});

	it("formats the four modes and their short letters", () => {
		expect(formatModes(DEFAULT_MODES)).toBe("in allow/allow, out allow/ask");
		expect([shortMode("allow"), shortMode("ask"), shortMode("deny")]).toEqual([
			"A",
			"a",
			"D",
		]);
	});
});
