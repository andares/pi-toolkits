/**
 * Bash decomposition: segments, wrappers, substitution, cd folding, redirects,
 * read/write classification, and the fail-closed cases.
 */
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseCommandUnits, stripHeredocs, type CommandUnit } from "./units.js";

const CWD = "/proj";
const HOME = homedir();

function summary(command: string) {
	return parseCommandUnits(command, CWD).map((unit) => ({
		command: unit.command,
		head: unit.headWord,
		effect: unit.effect,
		opaque: unit.opaque,
		base: unit.base,
		targets: unit.targets.map((target) => `${target.effect}:${target.path}`),
	}));
}

function first(command: string): CommandUnit {
	return parseCommandUnits(command, CWD)[0];
}

describe("segments and cd folding", () => {
	it("splits on && and folds cd into the following command", () => {
		const units = summary("cd /tmp && rm x");
		expect(units).toHaveLength(2);
		expect(units[0]).toMatchObject({ command: "cd", base: CWD, targets: ["read:/tmp"] });
		expect(units[1]).toMatchObject({ command: "rm", base: "/tmp", targets: ["write:/tmp/x"] });
	});

	it("splits pipelines and keeps quoted operators as data", () => {
		expect(summary("cat a | grep x")).toHaveLength(2);
		expect(summary('echo "a && b"')).toHaveLength(1);
	});

	it("strips leading VAR=value assignments", () => {
		expect(first("FOO=bar rm x").command).toBe("rm");
		expect(first("FOO=bar rm x").headWord).toBe("rm");
	});

	it("returns no units for an empty command", () => {
		expect(parseCommandUnits("   ", CWD)).toEqual([]);
	});
});

describe("wrappers and nested execution", () => {
	it("peels sudo and keeps the wrapper visible", () => {
		const unit = first("sudo -u root rm -rf /");
		expect(unit).toMatchObject({ command: "rm", headWord: "sudo" });
		expect(unit.targets).toEqual([{ path: "/", effect: "write", source: "operand" }]);
	});

	it("peels xargs and env", () => {
		expect(first("xargs -I{} rm {}").command).toBe("rm");
		expect(first("env FOO=bar rm x").command).toBe("rm");
	});

	it("recurses into bash -c payloads", () => {
		const unit = first("bash -c 'rm -rf /tmp/x'");
		expect(unit).toMatchObject({ command: "rm", opaque: false });
		expect(unit.targets[0]?.path).toBe("/tmp/x");
	});

	it("finds a substitution inside a quoted word", () => {
		const units = summary('echo "x$(rm y)"');
		expect(units[0]).toMatchObject({ command: "rm", targets: ["write:/proj/y"] });
		expect(units[1]?.command).toBe("echo");
	});

	it("recurses into command substitution", () => {
		const units = summary("echo $(rm -rf /tmp/x)");
		expect(units[0]).toMatchObject({
			command: "rm",
			effect: "write",
			targets: ["write:/tmp/x"],
		});
		expect(units[1]).toMatchObject({ command: "echo", effect: "read" });
	});

	it("recurses into find -exec", () => {
		const units = summary("find . -name x -exec rm {} \\;");
		expect(units.map((unit) => unit.command)).toContain("rm");
	});
});

describe("redirects and heredocs", () => {
it("classifies redirect targets and ignores /dev/null", () => {
expect(summary("ls 2>/dev/null")[0]?.targets).toEqual([]);
expect(summary("echo hi > /tmp/x")[0]?.targets).toEqual(["write:/tmp/x"]);
expect(summary("cat < input > output")[0]?.targets).toEqual([
"read:/proj/input",
"write:/proj/output",
]);
});

it("ignores a device sink as a plain operand, not just a redirect", () => {
expect(summary("curl -s -o /dev/null https://example.com")[0]?.targets).toEqual([]);
expect(summary("sort -o /dev/null input")[0]?.targets).toEqual([]);
// A command that mutates the node itself still surfaces the target.
expect(summary("rm /dev/null")[0]?.targets).toEqual(["write:/dev/null"]);
});

	it("treats a redirect to a credential path as a write to it", () => {
		expect(summary("echo a > ~/.ssh/authorized_keys")[0]?.targets).toEqual([
			`write:${HOME}/.ssh/authorized_keys`,
		]);
	});

	it("keeps the redirect target as the target, not the command name", () => {
		expect(summary("ls > out.txt")[0]?.targets).toEqual(["write:/proj/out.txt"]);
		expect(summary("ls >> out.txt")[0]?.targets).toEqual(["write:/proj/out.txt"]);
		expect(summary("ls 2> err.txt")[0]?.targets).toEqual(["write:/proj/err.txt"]);
	});

	it("strips heredoc bodies and keeps the redirect", () => {
		const unit = first("cat > f <<EOF\nhello\nEOF");
		expect(unit).toMatchObject({ command: "cat", effect: "write" });
		expect(unit.targets).toEqual([{ path: "/proj/f", effect: "write", source: "redirect" }]);
	});

	it("marks an unterminated heredoc opaque", () => {
		expect(stripHeredocs("cat <<EOF\nunterminated")).toBeUndefined();
		expect(first("cat <<EOF\nunterminated").opaque).toBe(true);
	});
});

describe("read/write classification", () => {
	it("knows read and write commands", () => {
		expect(first("git log").effect).toBe("read");
		expect(first("git push").effect).toBe("write");
		expect(first("pnpm view react").effect).toBe("read");
		expect(first("pnpm install").effect).toBe("write");
		expect(first("cat notes.txt").effect).toBe("read");
	});

	it("withdraws a read claim for write-capable options", () => {
		const sed = first("sed -i s/a/b/ f.txt");
		expect(sed.effect).toBe("write");
		expect(sed.targets).toEqual([
			{ path: "/proj/f.txt", effect: "write", source: "operand" },
		]);
		expect(first("sort -o out.txt f").targets).toEqual([
			{ path: "/proj/out.txt", effect: "write", source: "operand" },
		]);
	});

	it("treats unknown commands as writes", () => {
		expect(first("frobnicate x").effect).toBe("write");
	});
});

describe("paths", () => {
	it("treats rm/mv/cp operands as targets even when bare", () => {
		expect(summary("rm notes.txt")[0]?.targets).toEqual(["write:/proj/notes.txt"]);
		expect(summary("cp a b")[0]?.targets).toEqual(["write:/proj/a", "write:/proj/b"]);
	});

	it("resolves git -C against the -C directory, not the base", () => {
		expect(summary("git -C ../other log")[0]?.targets).toEqual([
			"read:/other",
		]);
		expect(summary("git -C /tmp log")[0]?.targets).toEqual(["read:/tmp"]);
		expect(summary("git -C \"$DIR\" log")[0]?.opaque).toBe(true);
	});

	it("collapses a glob to the directory it expands in", () => {
		expect(summary("rm -rf *")[0]?.targets).toEqual([`write:${CWD}`]);
	});

	it("does not treat URLs as paths", () => {
		expect(summary("curl -o /tmp/x https://example.com/a")[0]?.targets).toEqual([
			"write:/tmp/x",
		]);
	});

	it("does not treat echo/printf arguments as paths", () => {
		const echo = first('echo "  $f  改动 $tot 行 / 忽略空白后 $w 行"');
		expect(echo.opaque).toBe(false);
		expect(echo.targets).toEqual([]);
		const printf = first('printf "%s\\n" "$value"');
		expect(printf.opaque).toBe(false);
		expect(printf.targets).toEqual([]);
	});

	it("expands ~ while parsing", () => {
		expect(summary("tee ~/x")[0]?.targets).toEqual([`write:${HOME}/x`]);
	});
});

describe("fail closed", () => {
	it("marks an unresolved variable in a path position opaque", () => {
		expect(summary("cat $UNKNOWN/x")).toEqual([
			expect.objectContaining({ opaque: true, targets: [] }),
		]);
	});

	it("marks a non-literal cd and its following relative command opaque", () => {
		const units = summary('cd "$DIR" && rm x');
		expect(units[0]?.opaque).toBe(true);
		expect(units[1]?.opaque).toBe(true);
		expect(units[1]?.base).toBeNull();
	});

	it("ignores comments, including apostrophes inside them", () => {
		expect(first("echo hi # it's fine").opaque).toBe(false);
		expect(first("echo hi # a 'quote").opaque).toBe(false);
		expect(first("echo hi # x '").targets).toEqual([]);
	});

	it("marks unbalanced quoting opaque", () => {
		expect(first('echo "unclosed').opaque).toBe(true);
	});

	it("marks a non-literal shell payload opaque", () => {
		expect(first('bash -c "$CMD"').opaque).toBe(true);
	});
});
