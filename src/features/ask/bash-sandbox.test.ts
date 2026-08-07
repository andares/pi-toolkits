/**
 * Boundary tests for the ask-mode read-only bash sandbox.
 */
import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "./bash-sandbox.js";

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
    "grep -r foo src",
    "find . -name '*.ts'",
    "cd src && ls",
    "node --version",
    "npm list --depth=0",
    "curl -s https://example.com",
    "curl -o - https://example.com", // stdout, allowed
    "wget -O - https://example.com", // stdout, allowed
    "echo 'hello && world'", // quoted operator is data, not control
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
    "git commit -m x",
    "git push",
    "git checkout main",
    "cat x > out.txt",
    "echo hi >> log",
    "echo $(rm -rf /)", // command substitution
    "ls | rm -rf /", // pipeline with destructive command
    "curl -o file https://example.com",
    "curl -O https://example.com/x",
    "curl --output file https://example.com",
    "wget -O file https://example.com",
    "wget --output-document file https://example.com",
    "wget -qO- https://example.com", // sandbox rejects (only wget -O - is safe); fine, be strict
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
