#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const preload = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "preload-test-env.mjs",
);

// When the suite runs from a pre-commit hook, git has exported these into the
// environment. A test's `git init` in a temp dir then reinitialises the
// repository being committed. The preload must clear them before any test
// code (and anything it spawns) runs.
test("preload clears repository-local git variables", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      preload,
      "-e",
      "console.log(['GIT_DIR','GIT_INDEX_FILE','GIT_WORK_TREE','GIT_COMMON_DIR'].map((k) => process.env[k] ?? '-').join(' '))",
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_DIR: "/nonexistent/.git",
        GIT_INDEX_FILE: "/nonexistent/.git/index",
        GIT_WORK_TREE: "/nonexistent",
        GIT_COMMON_DIR: "/nonexistent/.git",
      },
    },
  );
  strictEqual(output.trim(), "- - - -");
});
