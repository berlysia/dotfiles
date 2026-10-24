// sendSystemNotification must have launched the notifier before it resolves.
// The failure only shows when the parent exits right after the call returns
// (cc-hooks-ts runHook calls process.exit(0) right after run), so each case
// runs the call in a child process that exits immediately.
import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "__fixtures__",
  "send-system-notification-child.ts",
);
const FAILURE_LOG = "Failed to send system notification";

let dir: string;
let binDir: string;

function writeFake(name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function markerPath(): string {
  return join(dir, "marker");
}

function readLog(): string {
  const path = join(dir, "voice.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function runChild(
  env: Record<string, string>,
  pathOverride?: string,
): Promise<{ code: number | null; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        "--import",
        join(import.meta.dirname, "..", "preload-test-env.mjs"),
        FIXTURE,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          FIXTURE_DIR: dir,
          PATH: pathOverride ?? `${binDir}:${process.env.PATH}`,
          ...env,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      resolve({ code, elapsedMs: Date.now() - started }),
    );
  });
}

describe("sendSystemNotification launch", () => {
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sysnotify-")));
    binDir = join(dir, "bin");
    mkdirSync(binDir);
  });

  afterEach(() => {
    const pidFile = join(dir, "sleep.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("linux: launches notify-send before the parent exits", async () => {
    writeFake("notify-send", `echo "$@" > "${markerPath()}"`);
    const { code } = await runChild({ FIXTURE_PLATFORM: "linux" });
    strictEqual(code, 0);
    ok(readFileSync(markerPath(), "utf8").includes("hello"));
  });

  it("wsl: launches the bash launcher with nohup before the parent exits", async () => {
    writeFake("bash", `echo "$@" > "${markerPath()}"`);
    const { code } = await runChild({ FIXTURE_PLATFORM: "wsl" });
    strictEqual(code, 0);
    const marker = readFileSync(markerPath(), "utf8");
    ok(marker.includes("-c"));
    ok(marker.includes("nohup"));
  });

  it("notify-send exiting 1 is logged and does not throw", async () => {
    writeFake("notify-send", "exit 1");
    const { code } = await runChild({ FIXTURE_PLATFORM: "linux" });
    strictEqual(code, 0);
    ok(readLog().includes(FAILURE_LOG));
  });

  it("missing notify-send is logged and does not throw", async () => {
    // binDir exists but is empty; node is invoked by absolute path.
    const { code } = await runChild({ FIXTURE_PLATFORM: "linux" }, binDir);
    strictEqual(code, 0);
    ok(readLog().includes(FAILURE_LOG));
  });

  it("a notify-send that hangs is abandoned after the cap", async () => {
    writeFake(
      "notify-send",
      `echo $$ > "${join(dir, "sleep.pid")}"\nexec sleep 6`,
    );
    const { code, elapsedMs } = await runChild({ FIXTURE_PLATFORM: "linux" });
    strictEqual(code, 0);
    ok(elapsedMs < 5000, `child took ${elapsedMs}ms`);
    ok(readLog().includes(FAILURE_LOG));
  });

  it("systemNotifications=false launches nothing", async () => {
    writeFake("notify-send", `echo "$@" > "${markerPath()}"`);
    const { code } = await runChild({
      FIXTURE_PLATFORM: "linux",
      FIXTURE_SYSTEM_NOTIFICATIONS: "false",
    });
    strictEqual(code, 0);
    strictEqual(existsSync(markerPath()), false);
  });
});
