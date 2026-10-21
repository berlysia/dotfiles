import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildWorkerSpawnSpec,
  jobInputFromHook,
} from "../../lib/agent-learnings/claude/session-context.ts";

describe("jobInputFromHook", () => {
  const base = { session_id: "s", transcript_path: "/t.jsonl", cwd: "/c" };
  it("uses the fixed compact reason for PreCompact", () => {
    deepStrictEqual(
      jobInputFromHook({ ...base, hook_event_name: "PreCompact" }),
      { ...base, reason: "compact" },
    );
  });
  it("keeps the SessionEnd reason", () => {
    deepStrictEqual(
      jobInputFromHook({
        ...base,
        hook_event_name: "SessionEnd",
        reason: "logout",
      }),
      { ...base, reason: "logout" },
    );
  });
});

describe("buildWorkerSpawnSpec", () => {
  it("passes only the allowlisted env, one fixed argument, the worker cwd, detached", () => {
    const spec = buildWorkerSpawnSpec("/h", {
      CLAUDECODE: "1",
      CLAUDE_CODE_PLUGIN_DIRS: "/p",
      PATH: "/bin",
      HOME: "/h",
    });
    strictEqual(spec.command, process.execPath);
    deepStrictEqual(spec.args, ["/h/.claude/scripts/learnings-worker.ts"]);
    deepStrictEqual(spec.env, { PATH: "/bin", HOME: "/h" });
    strictEqual(spec.cwd, "/h/.local/share/agent-learnings/.state/worker-cwd");
    strictEqual(spec.detached, true);
    strictEqual(spec.stdio, "ignore");
  });
});
