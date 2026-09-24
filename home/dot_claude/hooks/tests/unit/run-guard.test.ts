#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, "..", "..", "executable_run-guard.sh");
const throwingHook = join(here, "..", "__fixtures__", "throwing-guard-hook.ts");

// Every temp dir is removed by the absolute path mkdtempSync returned.
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-guard-test-"));
  tempDirs.push(dir);
  return dir;
}

/** A directory holding a fake `bun` executable with the given sh body. */
function fakeBunDir(body: string): string {
  const dir = makeTempDir();
  const bin = join(dir, "bun");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

function runWrapper(
  implPath: string,
  env: Record<string, string>,
  input = '{"tool_name":"Bash"}',
) {
  return spawnSync("sh", [wrapper, implPath], {
    input,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
}

describe("run-guard.sh", () => {
  it("blocks with exit 2 when bun cannot be found", () => {
    const emptyHome = makeTempDir();
    const result = runWrapper(throwingHook, {
      PATH: "/usr/bin:/bin",
      HOME: emptyHome,
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("bun"), result.stderr);
  });

  it("blocks with exit 2 and drops stdout when the hook exits 1", () => {
    const dir = fakeBunDir("echo partial\nexit 1");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("exit code 1"), result.stderr);
    strictEqual(result.stdout, "");
  });

  it("passes stdout and exit 0 through", () => {
    const dir = fakeBunDir(`cat >/dev/null\necho '{"ok":true}'`);
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
    });
    strictEqual(result.status, 0);
    strictEqual(result.stdout.trim(), '{"ok":true}');
  });

  it("passes exit 2 through", () => {
    const dir = fakeBunDir("exit 2");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
    });
    strictEqual(result.status, 2);
  });

  it("forwards stdin byte for byte", () => {
    const dir = fakeBunDir("cat");
    const payload = `{"command":"echo \\"a b\\" '$HOME' \`x\`\\nnext"}`;
    const result = runWrapper(
      throwingHook,
      { PATH: `${dir}:/usr/bin:/bin`, HOME: makeTempDir() },
      payload,
    );
    strictEqual(result.status, 0);
    strictEqual(result.stdout.trim(), payload);
  });

  it("blocks with exit 2 when the hook exceeds the timeout", () => {
    const dir = fakeBunDir("exec sleep 30");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      RUN_GUARD_TIMEOUT: "1",
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("timed out"), result.stderr);
  });

  it("blocks with exit 2 through the settings command form when the wrapper itself is missing", () => {
    // Mirrors the command in .settings.hooks.json.tmpl: `sh <wrapper> <hook> || exit 2`.
    const missing = join(makeTempDir(), "run-guard.sh");
    const result = spawnSync(
      "sh",
      ["-c", `sh ${missing} ${throwingHook} || exit 2`],
      {
        input: "{}",
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    strictEqual(result.status, 2);
  });

  it("blocks with exit 2 when a real cc-hooks-ts hook throws", (t) => {
    const probe = spawnSync("sh", ["-c", "command -v bun"], {
      encoding: "utf8",
      env: process.env,
    });
    if (probe.status !== 0) {
      t.skip("bun is not on PATH");
      return;
    }
    const result = runWrapper(throwingHook, {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("exit code 1"), result.stderr);
  });
});
