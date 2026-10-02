#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getProjectRoot } from "../../lib/project-root.ts";
import { shellSingleQuote } from "../../lib/shell-quote.ts";
import { EnvironmentHelper } from "./test-helpers.ts";

describe("getProjectRoot", () => {
  const envHelper = new EnvironmentHelper();
  afterEach(() => envHelper.restore());

  it("prefers CLAUDE_TEST_CWD, then CLAUDE_PROJECT_DIR, then inputCwd, then process.cwd()", () => {
    envHelper.set("CLAUDE_TEST_CWD", "/t");
    envHelper.set("CLAUDE_PROJECT_DIR", "/p");
    assert.equal(getProjectRoot("/i"), "/t");
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    assert.equal(getProjectRoot("/i"), "/p");
    envHelper.set("CLAUDE_PROJECT_DIR", undefined);
    assert.equal(getProjectRoot("/i"), "/i");
    assert.equal(getProjectRoot(), process.cwd());
  });

  it("treats an empty CLAUDE_PROJECT_DIR or inputCwd as unset", () => {
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", "");
    assert.equal(getProjectRoot("/i"), "/i");
    assert.equal(getProjectRoot(""), process.cwd());
  });
});

describe("shellSingleQuote", () => {
  for (const value of [
    "plain",
    "it's",
    'say "hi"',
    "$(touch /tmp/pwned)",
    "`id`",
    "back\\slash",
    "line1\nline2",
    "",
  ]) {
    it(`round-trips ${JSON.stringify(value)} through bash source`, () => {
      const dir = mkdtempSync(join(tmpdir(), "shell-quote-"));
      const envFile = join(dir, "env");
      writeFileSync(envFile, `export V=${shellSingleQuote(value)}\n`);
      const result = spawnSync(
        "bash",
        ["-c", `. "$1"; printf %s "$V"`, "_", envFile],
        {
          encoding: "utf-8",
        },
      );
      assert.equal(result.status, 0);
      assert.equal(result.stdout, value);
    });
  }
});
