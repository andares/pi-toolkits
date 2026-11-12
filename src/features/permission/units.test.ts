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

/**
 * Regressions from the 2026-10-26 → 2026-11-12 approval log (491 records,
 * 61 asks; replaying the commands against the parser showed 52 would still
 * ask). Each case below is one of the false-positive classes that log exposed.
 */
describe("approval-log regressions", () => {
	it("keeps a trailing `$` inside a quoted pattern literal", () => {
		const unit = first('grep -n "</div>\\s*$" src/a.vue');
		expect(unit).toMatchObject({ command: "grep", effect: "read", opaque: false });
		expect(unit.targets.map((target) => target.path)).toEqual(["/proj/src/a.vue"]);
	});

	it("keeps `$` before `|` and `)` inside a quoted pattern literal", () => {
		for (const command of [
			'grep -E "\\.php$"',
			'grep -cE "<STable($|[^A-Za-z])" f',
			'grep -n "label:\\|action\\|$" f',
		]) {
			expect(first(command).opaque).toBe(false);
		}
	});

	it("treats a backtick inside single quotes as pattern text", () => {
		// Shell: the backtick is literal inside '…'; the old scanner saw an
		// unterminated command substitution and failed the whole command closed.
		const unit = first("grep -rn ':title=\"x`' src/views");
		expect(unit.opaque).toBe(false);
		expect(unit.note).toBeUndefined();
	});

	it("splits commands separated by a newline (missing writes were possible)", () => {
		const units = summary("ls\nrm -rf /tmp/x");
		expect(units.map((unit) => unit.command)).toEqual(["ls", "rm"]);
		expect(units[1]?.targets).toEqual(["write:/tmp/x"]);
	});

	it("joins a backslash-newline as a line continuation", () => {
		const units = summary("echo a \\\nb");
		expect(units).toHaveLength(1);
		expect(units[0]?.command).toBe("echo");
	});

	it("gives a bare assignment no unit", () => {
		expect(parseCommandUnits("f=2026-10-29.jsonl", CWD)).toEqual([]);
	});

	it("leaves ordinary assignments unresolved without control-flow analysis", () => {
		const units = summary('f=notes.md; grep -n x "src/$f"');
		expect(units).toHaveLength(1);
		expect(units[0]).toMatchObject({ command: "grep", effect: "write", opaque: true });
		expect(units[0]?.targets).toEqual([]);
	});

	it("does not substitute a non-literal assignment", () => {
		const units = summary('f=$(date); sed -n 1p "d/$f"');
		expect(units.find((unit) => unit.command === "sed")?.opaque).toBe(true);
	});

	it("expands a literal for-loop over real paths", () => {
		const units = summary('for f in a b; do grep -n x "src/$f.vue"; done');
		expect(units.map((unit) => unit.command)).toEqual(["grep", "grep"]);
		expect(units.map((unit) => unit.targets)).toEqual([
			["read:/proj/src/a.vue"],
			["read:/proj/src/b.vue"],
		]);
	});

	it("expands a literal loop for cd-like flags (`git -C`)", () => {
		const units = summary('for d in /a /b; do git -C "$d" status; done');
		expect(units).toHaveLength(2);
		expect(units[0]).toMatchObject({ command: "git", base: "/a", opaque: false });
		expect(units[1]).toMatchObject({ command: "git", base: "/b", opaque: false });
	});

	it("leaves a loop over a substitution unexpanded (fail closed)", () => {
		const units = summary('for f in $(ls); do sed -n 1p "d/$f"; done');
		const sed = units.find((unit) => unit.command === "sed");
		expect(sed?.opaque).toBe(true);
	});

	it("treats a plain `env` as a read, not an opaque wrapper", () => {
		const units = summary('env | grep -i "^PI_"');
		expect(units.map((unit) => [unit.command, unit.effect, unit.opaque])).toEqual([
			["env", "read", false],
			["grep", "read", false],
		]);
	});

	it("does not treat curl data flags as path operands", () => {
		const unit = first("curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:5173/");
		expect(unit.opaque).toBe(false);
		expect(unit.targets).toEqual([]);
	});

	it("keeps an unresolved input redirect fail-closed", () => {
		const unit = first('wc -l < "$f"');
		expect(unit).toMatchObject({ command: "wc", effect: "write", opaque: true });
		expect(unit.note).toBe("unresolved redirect target");
	});

	it("still fails closed on an unresolved output redirect", () => {
		expect(first('echo x > "$f"').opaque).toBe(true);
	});

	it("classifies container inspection subcommands as reads", () => {
		expect(first("docker compose ps --format '{{.Name}}'").effect).toBe("read");
		expect(first("docker ps -a").effect).toBe("read");
		expect(first("docker compose exec worker php -l x").effect).toBe("write");
		expect(first("docker run --rm alpine sh").effect).toBe("write");
	});

	it("does not let a previous assignment shadow a literal loop variable", () => {
		const units = summary('f=/proj; for f in /etc; do rm "$f/x"; done');
		expect(units).toHaveLength(1);
		expect(units[0]?.targets).toEqual(["write:/etc/x"]);
	});

	it("uses the inner binding for nested loops with the same variable", () => {
		const units = summary('for f in /proj; do for f in /etc; do rm "$f/x"; done; done');
		expect(units).toHaveLength(1);
		expect(units[0]?.targets).toEqual(["write:/etc/x"]);
	});

	it("stops loop expansion after the variable is reassigned", () => {
		const unit = first('for f in /proj; do f=/etc; rm "$f/x"; done');
		expect(unit).toMatchObject({ command: "rm", opaque: true });
	});

	it("stops loop expansion after a builtin can mutate the variable", () => {
		const unit = summary('for f in /proj; do read f; rm "$f/x"; done')
			.find((entry) => entry.command === "rm");
		expect(unit).toMatchObject({ command: "rm", opaque: true });
	});

	it("does not treat a conditional assignment as having executed", () => {
		const unit = summary('false && d=/proj; rm "$d/x"')
			.find((entry) => entry.command === "rm");
		expect(unit).toMatchObject({ command: "rm", opaque: true });
	});

	it("does not reuse a literal assignment after `read` changes it", () => {
		const unit = summary('d=/proj; read d; rm "$d/x"')
			.find((entry) => entry.command === "rm");
		expect(unit).toMatchObject({ command: "rm", opaque: true });
	});

	it("keeps container output options as writes", () => {
		const unit = first("docker compose config --output /tmp/compose.yml");
		expect(unit.effect).toBe("write");
		expect(unit.targets).toContainEqual({
			path: "/tmp/compose.yml",
			effect: "write",
			source: "operand",
		});
	});
});
