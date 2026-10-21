// The git shim (support/git-shim.mjs, installed by preload-test-env.mjs when
// CLAUDE_TEST_FORBID_GIT is exactly "1") makes a unit test file fail when it
// starts git. Each case runs a child node with the preload and an env built
// here, never inherited, so the shim of the process running this file cannot
// leak into the child.
import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";

const preload = join(import.meta.dirname, "..", "preload-test-env.mjs");
// Under the shim PATH starts with the shim dir; the preload keeps the PATH it
// found. Run directly with `node --test`, there is no shim and PATH is it.
const basePath =
  process.env.CLAUDE_TEST_ORIGINAL_PATH ?? process.env.PATH ?? "";

const scratch = mkdtempSync(join(tmpdir(), "git-shim-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function writeChild(body: string): string {
  const path = join(scratch, `child-${counter++}.mjs`);
  writeFileSync(path, body);
  return path;
}

function runChild(
  script: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const logs = mkdtempSync(join(scratch, "logs-"));
  const result = spawnSync(process.execPath, ["--import", preload, script], {
    encoding: "utf8",
    env: { PATH: basePath, CLAUDE_LOGS_DIR: logs, ...extraEnv },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const RUN_GIT = `import { execFileSync } from "node:child_process";
try { execFileSync("git", ["--version"], { stdio: "pipe" }); } catch {}
`;

describe("git shim (CLAUDE_TEST_FORBID_GIT=1)", () => {
  it("fails the file and records the arguments and the file path when a child starts git", () => {
    const script = writeChild(RUN_GIT);
    const r = runChild(script, { CLAUDE_TEST_FORBID_GIT: "1" });
    strictEqual(r.status, 1);
    ok(r.stderr.includes("--version"), r.stderr);
    ok(r.stderr.includes(script), r.stderr);
  });

  it("fails the file even when the child swallows the git failure (R6)", () => {
    const script = writeChild(`import { spawnSync } from "node:child_process";
spawnSync("git", ["status"]); // result ignored
`);
    strictEqual(runChild(script, { CLAUDE_TEST_FORBID_GIT: "1" }).status, 1);
  });

  it("passes a file that starts no git", () => {
    const script = writeChild("console.log('ok');\n");
    const r = runChild(script, { CLAUDE_TEST_FORBID_GIT: "1" });
    strictEqual(r.status, 0, r.stderr);
  });

  for (const [label, env] of [
    ["unset", {}],
    ["empty", { CLAUDE_TEST_FORBID_GIT: "" }],
    ["0", { CLAUDE_TEST_FORBID_GIT: "0" }],
  ] as const) {
    it(`places no shim when the variable is ${label}`, () => {
      const script =
        writeChild(`import { execFileSync } from "node:child_process";
console.log(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());
`);
      const r = runChild(script, env);
      strictEqual(r.status, 0, r.stderr);
      const real = spawnSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
        env: { PATH: basePath },
      }).stdout.trim();
      ok(real.length > 0, "git is expected on the original PATH");
      strictEqual(r.stdout.trim(), real);
    });
  }

  it("fails the file when the child deletes the record", () => {
    const script =
      writeChild(`import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.PATH.split(":")[0];
for (const name of readdirSync(dir)) if (name !== "git") unlinkSync(join(dir, name));
`);
    strictEqual(runChild(script, { CLAUDE_TEST_FORBID_GIT: "1" }).status, 1);
  });

  it(
    "fails the file and says why when the shim cannot be placed",
    { skip: process.getuid?.() === 0 && "root can write anywhere" },
    () => {
      const readonly = join(scratch, "readonly-tmp");
      mkdirSync(readonly);
      chmodSync(readonly, 0o500);
      const script = writeChild("console.log('should not matter');\n");
      const r = runChild(script, {
        CLAUDE_TEST_FORBID_GIT: "1",
        TMPDIR: readonly,
      });
      chmodSync(readonly, 0o700);
      strictEqual(r.status, 1);
      ok(
        /shim/i.test(r.stderr) && /EACCES|permission/i.test(r.stderr),
        r.stderr,
      );
    },
  );

  it("keeps the shim dir at 0700 while the child lives and removes it afterwards", () => {
    const script = writeChild(`import { statSync } from "node:fs";
const dir = process.env.PATH.split(":")[0];
console.log(dir);
console.log((statSync(dir).mode & 0o777).toString(8));
`);
    const r = runChild(script, { CLAUDE_TEST_FORBID_GIT: "1" });
    strictEqual(r.status, 0, r.stderr);
    const [dir, mode] = r.stdout.trim().split("\n");
    strictEqual(mode, "700");
    ok(dir !== undefined && dir.length > 0);
    strictEqual(existsSync(dir ?? ""), false);
  });

  it("leaves the original PATH in CLAUDE_TEST_ORIGINAL_PATH", () => {
    const script = writeChild(
      `console.log(process.env.CLAUDE_TEST_ORIGINAL_PATH);\n`,
    );
    const r = runChild(script, { CLAUDE_TEST_FORBID_GIT: "1" });
    strictEqual(r.stdout.trim(), basePath);
    ok(basePath.split(delimiter).length > 0);
  });
});
