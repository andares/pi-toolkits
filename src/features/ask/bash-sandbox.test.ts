/**
 * Boundary tests for the ask-mode read-only bash sandbox.
 */
import { describe, expect, it } from "vitest";
import { classifyBlockedCommand, isReadOnlyCommand } from "./bash-sandbox.js";

describe("isReadOnlyCommand — allowed (read-only)", () => {
	const allowed = [
		"echo hi",
		"echo a && echo b",
		"ls -la",
		"cat package.json",
		"head -20 README.md",
		"git status",
		"git log --oneline -5",
		"git diff --stat",
		"git show HEAD",
		"git branch -a",
		"git remote -v",
		"git show HEAD 2>/dev/null",
		"grep -r foo src",
		"find . -name '*.ts'",
		"cd src && ls",
		"node --version",
		"npm list --depth=0",
		"curl -s https://example.com",
		"curl -o - https://example.com", // stdout, allowed
		"curl --output - https://example.com", // stdout, allowed
		"curl --output=- https://example.com", // stdout, allowed
		"wget -O - https://example.com", // stdout, allowed
		"wget -qO- https://example.com", // stdout, allowed
		"wget -O - --quiet https://example.com", // stdout, allowed
		"wget --output-document=- https://example.com", // stdout, allowed
		"echo 'hello && world'", // quoted operator is data, not control
	];

	it.each(allowed)("allows: %s", (command) => {
		expect(isReadOnlyCommand(command)).toBe(true);
	});
});

describe("isReadOnlyCommand — allowed (relaxed read-only families)", () => {
	const allowed = [
		// git archaeology
		"git blame -L 10,20 src/index.ts",
		"git grep -n registerAsk -- src",
		"git rev-parse HEAD",
		"git rev-list --count HEAD",
		"git describe --tags --abbrev=0",
		"git shortlog -sn",
		"git reflog show",
		"git reflog",
		"git stash list",
		"git stash show -p",
		"git worktree list",
		"git tag -l",
		"git tag --list 'v*'",
		"git cat-file -p HEAD",
		"git merge-base HEAD~5 HEAD",
		"git check-ignore -v node_modules",
		"git config --list",
		// destructive-substring false positives in arguments
		"git log --grep=rm --oneline",
		"git blame src/rm-utils.ts",
		"git log --grep=rm --oneline && ls src",
		// search arguments that merely *mention* a guarded flag are data
		"grep -rn 'find -exec' src",
		"git grep -n 'find -exec' -- .",
		"git log --grep='curl -so x' --oneline",
		"rg 'sed -i' .",
		// package metadata
		"pnpm view vite version",
		"pnpm info react",
		"pnpm search eslint",
		"pip show requests",
		"pip list",
		"pip3 freeze",
		"uv pip list",
		"python3 -m json.tool package.json",
		// guards must not over-block plain readers
		"fd -e ts",
		"sort package.json",
		"curl -so- https://example.com", // clustered short form, stdout
		"git grep --textconv -n foo", // read path, not the -O pager
		"env", // bare env prints the environment
		"env -i",
		"env FOO=bar", // assignment-only form, no command
		"file README.md",
		"sed -n '1p' README.md",
	];

	it.each(allowed)("allows: %s", (command) => {
		expect(isReadOnlyCommand(command)).toBe(true);
	});
});

describe("isReadOnlyCommand — blocked (mutating/destructive)", () => {
	const blocked = [
		"rm -rf /",
		"echo a && rm -rf /",
		"mv a b",
		"cp a b",
		"mkdir -p foo",
		"touch foo",
		"npm install",
		"npm run build",
		"pnpm install",
		"pnpm add left-pad",
		"pip install requests",
		"git commit -m x",
		"git push",
		"git checkout main",
		"git reset --hard",
		"git stash drop",
		"git stash pop",
		"git worktree remove x",
		"git reflog expire --all",
		"git tag v1",
		"git tag -d v1",
		"git branch new-branch",
		"git branch -m old new",
		"git branch -D old",
		"git remote add origin git@example.com:x/y.git",
		"git remote remove origin",
		"cat x > out.txt",
		"echo hi >> log",
		"echo $(rm -rf /)", // command substitution
		"git log --grep=$(rm -rf /)", // substitution hidden in an allowed verb
		"ls | rm -rf /", // pipeline with destructive command
		"git log --grep=rm --oneline && rm -rf /", // second segment is a write
		"find . -name x -exec rm {} \\;", // find stays out of the read-only bypass
		"find . -delete", // -delete is a write
		"ls | find . -delete", // ... and the pre-check sees pipelines too
		"find . -name '*.ts' -exec sh -c 'echo x > /tmp/y' \\;", // -exec runs commands
		"ls | find . -name x -exec echo {} \\;", // exec intent outside the first segment
		"fd . -x rm", // fd -x runs commands: never on the bypass list
		"fd . -x touch y",
		"fd --exec rm {}",
		"sort -o out.txt file", // sort's output flag is a write
		"sort file --output=out.txt",
		"curl -so /tmp/x https://example.com", // clustered short form writes
		"curl -o/tmp/x https://example.com", // attached short form writes
		"curl -sLo /tmp/x https://example.com",
		"curl --remote-name https://example.com",
		"sed -n -i 's/a/b/' f", // -i sneaks past the `sed -n` allowlist
		"tree -o /tmp/x",
		"tree --output=/tmp/x",
		"file -C -m magic",
		"git grep -O 'rm -rf /' pattern", // -O runs a pager command
		"git grep --open-files-in-pager=less pattern",
		"git log --ext-diff -p", // external diff driver
		"env curl -o out.txt https://example.com", // env forwards to a write
		"env -i curl -o out.txt https://example.com",
		"env FOO=1 curl -o out.txt https://example.com",
		"ls && env curl -o out.txt https://example.com",
		"env -S 'sh -c x'",
		"env find . -delete",
		"env sed -i 's/a/b/' f",
		"curl -o file https://example.com",
		"curl -O https://example.com/x",
		"curl --output file https://example.com",
		"wget -O file https://example.com",
		"wget --output-document file https://example.com",
		"wget https://example.com",
		"git diff --output=out.txt", // real write path on a read-only verb
		"git log --output out.txt",
		"git show -o out.txt",
		"dd if=/dev/zero of=/tmp/x bs=1 count=1",
		"echo x | tee file",
		"vim README.md",
		"sudo ls",
		"kill -9 1",
	];

	it.each(blocked)("blocks: %s", (command) => {
		expect(isReadOnlyCommand(command)).toBe(false);
	});
});

describe("classifyBlockedCommand", () => {
	it.each([
		["echo $(id)", "substitution"],
		["cat a > b", "redirect"],
		["git grep -O x", "exec"],
		["env curl -o out.txt https://example.com", "exec"],
		["find . -exec echo {} ;", "exec"],
		["rm -rf /", "write"],
		["find . -delete", "write"],
		["curl -O https://example.com", "write"],
		["wget https://example.com", "download"],
		["git commit -m x", "git"],
		["pnpm install", "install"],
		["vim README.md", "unlisted"],
	] as const)("classifies %s as %s", (command, kind) => {
		expect(classifyBlockedCommand(command)).toBe(kind);
	});
});
