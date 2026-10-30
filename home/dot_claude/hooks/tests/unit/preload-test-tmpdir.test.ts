import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

const PRELOAD = join(import.meta.dirname, "..", "preload-test-env.mjs");

const FIXTURE_BODY = `
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("leaves a directory behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "leaked-"));
  writeFileSync(join(dir, "file"), "x");
  appendFileSync(process.env.PRELOAD_TEST_RECORD, dir + "\\n");
  if (process.env.PRELOAD_TEST_FAIL === "1") throw new Error("fails on purpose");
});
`;

describe("preload-test-env: per-file TMPDIR", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function runSuite(fail: boolean) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "preload-run-")));
    roots.push(root);
    const sandbox = realpathSync(mkdtempSync(join(root, "tmp-")));
    const fixtures = realpathSync(mkdtempSync(join(root, "fixtures-")));
    const record = join(root, "record");
    const files = ["a.test.mjs", "b.test.mjs"].map((name) => {
      const file = join(fixtures, name);
      writeFileSync(file, FIXTURE_BODY);
      return file;
    });

    // The outer run's markers would make the child reuse the outer directory.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of [
      "CLAUDE_TEST_FILE_TMPDIR",
      "CLAUDE_LOGS_DIR",
      "CLAUDE_TEST_FORBID_GIT",
      "NODE_TEST_CONTEXT",
    ]) {
      delete env[name];
    }
    const result = spawnSync(
      process.execPath,
      ["--import", PRELOAD, "--test", ...files],
      {
        encoding: "utf8",
        env: {
          ...env,
          TMPDIR: sandbox,
          PRELOAD_TEST_RECORD: record,
          PRELOAD_TEST_FAIL: fail ? "1" : "0",
        },
      },
    );
    return { result, sandbox, record };
  }

  function recordedDirs(record: string): string[] {
    return readFileSync(record, "utf8").trim().split("\n");
  }

  it("removes what the test files left once the run ends", () => {
    const { result, sandbox, record } = runSuite(false);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const dirs = recordedDirs(record);
    assert.equal(dirs.length, 2);
    assert.ok(
      dirs.every((dir) => dir.startsWith(`${sandbox}/`)),
      `expected under ${sandbox}: ${dirs.join(", ")}`,
    );
    assert.deepEqual(readdirSync(sandbox), []);
  });

  it("gives each test file its own directory", () => {
    const { record } = runSuite(false);
    const [first, second] = recordedDirs(record);
    assert.notEqual(dirname(first ?? ""), dirname(second ?? ""));
  });

  it("removes the directory when a test fails, and keeps the failure", () => {
    const { result, sandbox } = runSuite(true);
    assert.notEqual(result.status, 0);
    assert.deepEqual(readdirSync(sandbox), []);
  });
});
