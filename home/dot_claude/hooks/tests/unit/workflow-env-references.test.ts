#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Bash-side references to values the SessionStart hook no longer exports
 * (spec K4). A leftover one silently brings back #197: a model following the
 * text writes to, or passes, the previous session's dir.
 */
const FORBIDDEN =
  /\$\{?(DOCUMENT_WORKFLOW_DIR|CLAUDE_SESSION_ID)\b|env\.CLAUDE_SESSION_ID\b/;

/**
 * Hook-process reads of a startup pin (`DOCUMENT_WORKFLOW_DIR=… claude`), which
 * K4 keeps: the guard's interpreter scratch roots name it in their docstrings.
 */
const ALLOWED: Record<string, number> = {
  "home/dot_claude/hooks/implementations/document-workflow-guard.ts": 2,
};

function listFiles(dir: string, keep: (rel: string) => boolean): string[] {
  return readdirSync(join(REPO_ROOT, dir), {
    recursive: true,
    encoding: "utf-8",
  })
    .map((entry) => join(dir, entry))
    .filter((rel) => !rel.includes("node_modules") && keep(rel));
}

function scannedFiles(): string[] {
  return [
    ...listFiles("home/dot_claude/rules", (rel) => rel.endsWith(".md")),
    "home/dot_claude/CLAUDE.md",
    "CLAUDE.md",
    ...listFiles(".skills", (rel) => rel.endsWith(".md")),
    ...listFiles(
      "home/dot_claude/hooks",
      (rel) =>
        rel.endsWith(".ts") &&
        !rel.endsWith(".test.ts") &&
        !rel.includes("/tests/"),
    ),
  ];
}

describe("no Bash-side reference to the workflow dir or session id env (spec K4)", () => {
  it("scans a non-trivial set of files", () => {
    assert.ok(
      scannedFiles().length > 50,
      `only ${scannedFiles().length} files scanned`,
    );
  });

  it("finds the forbidden forms only where a hook reads a startup pin", () => {
    const hits: string[] = [];
    const counts: Record<string, number> = {};
    for (const rel of scannedFiles()) {
      readFileSync(join(REPO_ROOT, rel), "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (!FORBIDDEN.test(line)) return;
          counts[rel] = (counts[rel] ?? 0) + 1;
          if ((counts[rel] ?? 0) > (ALLOWED[rel] ?? 0))
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(
      hits,
      [],
      `replace with \`workflow-cli dir\` / $CLAUDE_CODE_SESSION_ID:\n${hits.join("\n")}`,
    );
  });
});
