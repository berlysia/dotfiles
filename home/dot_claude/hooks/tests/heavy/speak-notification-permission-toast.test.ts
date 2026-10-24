// Lives in heavy/ because the hook starts git (hooks/lib/git-context.ts).
// Launches the hook as a process so the wiring of the permission_prompt toast
// gate (env vars -> skip or send) is exercised, not only the pure predicate.
// HOME points at a temp dir so voice.log lands there; a fake `bash` on PATH
// swallows the wsl-notify-send launch so no real toast appears.
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

const HOOK = join(
  import.meta.dirname,
  "..",
  "..",
  "implementations",
  "speak-notification.ts",
);
const SKIP_LOG =
  "System notification skipped: permission_prompt is shown by Windows Terminal (OSC 777)";
const SENT_LOG = "System notification sent";
const SECRET = "SECRET-BODY-MARKER";

let dir: string;

function readVoiceLog(): string {
  const path = join(dir, ".claude", "log", "voice-synthesis.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function runHook(
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    for (const name of ["WT_SESSION", "TMUX", "TERM_PROGRAM"]) {
      delete baseEnv[name];
    }
    const child = spawn(
      process.execPath,
      [
        "--import",
        join(import.meta.dirname, "..", "preload-test-env.mjs"),
        HOOK,
      ],
      {
        stdio: ["pipe", "ignore", "ignore"],
        cwd: dir,
        env: {
          ...baseEnv,
          HOME: dir,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          CLAUDE_VOICE_ENABLED: "false",
          ...env,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    child.stdin.end(JSON.stringify(input));
  });
}

const permissionPrompt = {
  hook_event_name: "Notification",
  session_id: "toast-test",
  transcript_path: "/test/transcript",
  cwd: "/test",
  notification_type: "permission_prompt",
  message: `Claude needs your permission ${SECRET}`,
};

describe("speak-notification permission_prompt toast wiring", () => {
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "permtoast-")));
    mkdirSync(join(dir, "bin"));
    const fakeBash = join(dir, "bin", "bash");
    writeFileSync(fakeBash, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBash, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("wsl + WT_SESSION: logs the skip line and no body or sent line", async () => {
    const code = await runHook(permissionPrompt, {
      WSL_DISTRO_NAME: "Ubuntu",
      WT_SESSION: "abc",
    });
    strictEqual(code, 0);
    const log = readVoiceLog();
    ok(log.includes(SKIP_LOG), log);
    ok(!log.includes(SENT_LOG), log);
    ok(!log.includes(SECRET), log);
  });

  it("wsl without WT_SESSION: the hook still sends the toast", async () => {
    const code = await runHook(permissionPrompt, {
      WSL_DISTRO_NAME: "Ubuntu",
    });
    strictEqual(code, 0);
    ok(readVoiceLog().includes(SENT_LOG), readVoiceLog());
  });

  it("StopFailure under Windows Terminal: the hook still sends the toast", async () => {
    const code = await runHook(
      {
        hook_event_name: "StopFailure",
        session_id: "toast-test",
        transcript_path: "/test/transcript",
        cwd: "/test",
        error: "rate_limit",
      },
      { WSL_DISTRO_NAME: "Ubuntu", WT_SESSION: "abc" },
    );
    strictEqual(code, 0);
    ok(readVoiceLog().includes(SENT_LOG), readVoiceLog());
  });
});
