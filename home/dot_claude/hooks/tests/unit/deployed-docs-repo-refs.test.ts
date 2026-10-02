#!/usr/bin/env node --test

import { ok } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Docs under home/dot_claude/ and .skills/ are deployed to ~/.claude/ and read
// from every project. A reference to a file that exists only in this dotfiles
// repository (an ADR, a source path) cannot be followed there, so the needed
// content must live in a deployed doc instead.
//
// Limit: a bare `lib/foo.ts` is not detected, because hooks/README.md uses it
// as a valid path relative to its own deployed directory. Such references are
// checked by hand.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");

const REPO_ONLY_PATTERNS: readonly RegExp[] = [
  /ADR-[0-9]{4}/,
  /docs\/decisions\/[0-9]{4}/,
  /home\/dot_claude\//,
  /home\/\.chezmoi/,
  /\.skills\//,
];

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // Edits the auto-approve layers in the dotfiles source; source paths are its subject.
  ".skills/update-auto-approve/SKILL.md",
  // Promotes insights into dotfiles source files (.skills/, home/dot_claude/rules/).
  ".skills/insight-digest/SKILL.md",
]);

function listDeployedDocs(): string[] {
  const output = execFileSync(
    "git",
    // --others includes new docs that are not committed yet.
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "home/dot_claude",
      ".skills",
    ],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  return output
    .split("\n")
    .filter((path) => path.length > 0)
    .filter((path) => !path.includes("/node_modules/"))
    .filter((path) => !path.startsWith("home/dot_claude/hooks/tests/"))
    .filter(
      (path) =>
        path.endsWith(".md") ||
        (path.startsWith("home/dot_claude/templates/") &&
          path.endsWith(".tmpl")),
    );
}

test("deployed docs do not reference files that exist only in the dotfiles repo", () => {
  const docs = listDeployedDocs();
  ok(docs.length > 0, "expected to find deployed docs");

  const hits: string[] = [];
  for (const path of docs) {
    if (ALLOWED_FILES.has(path)) continue;
    const lines = readFileSync(join(repoRoot, path), "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (REPO_ONLY_PATTERNS.some((pattern) => pattern.test(line))) {
        hits.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  ok(
    hits.length === 0,
    `repo-only references in deployed docs:\n${hits.join("\n")}`,
  );
});
