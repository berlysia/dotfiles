// Process test: claude-rc-launch hands `claude remote-control` the flags a
// server needs. A stub `claude` on PATH records its argv, so no server starts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCH = join(REPO, "home/dot_local/bin/executable_claude-rc-launch");

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-rc-launch-")));
after(() => rmSync(root, { recursive: true, force: true }));

test("a listed project starts without a pre-created session", () => {
  const argvFile = join(root, "argv");
  const stub = join(root, "claude");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
  chmodSync(stub, 0o755);
  const list = join(root, "projects");
  writeFileSync(list, `demo ${root} same-dir --permission-mode auto\n`);

  const result = spawnSync("bash", [LAUNCH, "demo"], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      PATH: `${root}:${process.env.PATH}`,
      HOME: root,
      CLAUDE_RC_PROJECTS: list,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(argvFile, "utf8").trim().split("\n"), [
    "remote-control",
    "--spawn",
    "same-dir",
    "--remote-control-session-name-prefix",
    "demo",
    "--no-create-session-in-dir",
    "--permission-mode",
    "auto",
  ]);
});
