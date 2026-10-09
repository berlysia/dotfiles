#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEPLOYED_AT_ERE,
  DEPLOYED_AT_FILE,
  EXPERIMENT_DIR_FROM_HOME,
  GUARD_COMMAND_FRAGMENT,
} from "../../lib/auto-mode-experiment.ts";

const SCRIPT = fileURLToPath(
  new URL(
    "../../../../.chezmoitemplates/sync-experiment-deployed-at.sh",
    import.meta.url,
  ),
);
const hooksWith = (command: string): string =>
  JSON.stringify({
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
  });
const GUARD = hooksWith(
  `sh '/h/hook-timer.sh' 'PreToolUse' 0 'sh /h/run-guard.sh /h/.claude/hooks/${GUARD_COMMAND_FRAGMENT} || exit 2' || exit 2`,
);
const NO_GUARD = hooksWith(
  "sh '/h/hook-timer.sh' 'PreToolUse' 0 'bun /h/.claude/hooks/implementations/auto-approve.ts'",
);

function run(home: string, hooksJson: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; sync_experiment_deployed_at "$2"; echo done',
      "bash",
      SCRIPT,
      hooksJson,
    ],
    {
      env: { PATH: process.env["PATH"] ?? "", HOME: home },
      encoding: "utf8",
    },
  );
}
function withHome(fn: (home: string, dir: string, file: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "sync-deployed-at-test-"));
  const dir = join(home, EXPERIMENT_DIR_FROM_HOME);
  try {
    fn(home, dir, join(dir, DEPLOYED_AT_FILE));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("sync_experiment_deployed_at", () => {
  it("creates deployed-at (dir 0700) when the guard is registered", () =>
    withHome((home, dir, file) => {
      const result = run(home, GUARD);
      strictEqual(result.stdout.trim(), "done", result.stderr);
      ok(new RegExp(DEPLOYED_AT_ERE).test(readFileSync(file, "utf8").trim()));
      strictEqual(statSync(dir).mode & 0o777, 0o700);
    }));

  it("leaves a valid deployed-at untouched", () =>
    withHome((home, dir, file) => {
      mkdirSync(dir, { recursive: true });
      // The second value is not a real date, but it has the right form and sorts
      // before now; the TypeScript reader accepts it too (auto-mode-experiment.test.ts).
      for (const body of ["2026-10-01T01:00:00Z\n", "2026-02-31T00:00:00Z\n"]) {
        writeFileSync(file, body);
        run(home, GUARD);
        strictEqual(readFileSync(file, "utf8"), body);
      }
    }));

  it("keeps a valid first line whatever follows it, as the reader does", () =>
    withHome((home, dir, file) => {
      mkdirSync(dir, { recursive: true });
      for (const body of [
        `2026-10-01T01:00:00Z\n${"x".repeat(70_000)}`,
        "2026-10-01T01:00:00Z",
        "2026-10-01T01:00:00Z\0\n",
      ]) {
        writeFileSync(file, body);
        strictEqual(run(home, GUARD).stdout.trim(), "done");
        strictEqual(readFileSync(file, "utf8"), body);
      }
    }));

  it("rewrites a malformed or future deployed-at", () =>
    withHome((home, dir, file) => {
      mkdirSync(dir, { recursive: true });
      for (const body of [
        "garbage\n",
        "2999-01-01T00:00:00Z\n",
        "",
        `2026-10-10T01:00:00Z${"x".repeat(100)}\n`,
      ]) {
        writeFileSync(file, body);
        strictEqual(run(home, GUARD).stdout.trim(), "done");
        const now = readFileSync(file, "utf8").trim();
        ok(new RegExp(DEPLOYED_AT_ERE).test(now));
        ok(now < "2999");
      }
    }));

  it("removes deployed-at when the guard is not registered", () =>
    withHome((home, dir, file) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, "2026-10-10T01:00:00Z\n");
      strictEqual(run(home, NO_GUARD).stdout.trim(), "done");
      strictEqual(existsSync(file), false);
    }));

  it("does nothing but warn when deployed-at or the directory is a symlink", () =>
    withHome((home, dir, file) => {
      mkdirSync(dir, { recursive: true });
      const target = join(home, "elsewhere");
      writeFileSync(target, "keep\n");
      symlinkSync(target, file);
      for (const hooks of [GUARD, NO_GUARD]) {
        const result = run(home, hooks);
        strictEqual(result.stdout.trim(), "done");
        ok(result.stderr.includes("WARNING"));
        strictEqual(readFileSync(target, "utf8"), "keep\n");
        ok(lstatSync(file).isSymbolicLink());
      }
    }));

  it("never fails the caller, even with hooks that are not JSON", () =>
    withHome((home) => {
      const result = run(home, "{not json");
      strictEqual(result.status, 0);
      strictEqual(result.stdout.trim(), "done");
      ok(result.stderr.includes("WARNING"));
    }));

  it("holds the same literals as the TypeScript module", () => {
    const text = readFileSync(SCRIPT, "utf8");
    ok(text.includes(`"$HOME/${EXPERIMENT_DIR_FROM_HOME}"`));
    ok(text.includes(`"$dir/${DEPLOYED_AT_FILE}"`));
    ok(text.includes(`"${GUARD_COMMAND_FRAGMENT}"`));
    ok(text.includes(`'${DEPLOYED_AT_ERE}'`));
  });
});
