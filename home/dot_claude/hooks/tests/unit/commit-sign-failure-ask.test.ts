#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createHook } from "../../implementations/commit-sign-failure-ask.ts";
import { signFailureMarkerDir } from "../../lib/commit-sign-failure.ts";
import { getHomeDir } from "../../lib/path-utils.ts";
import {
  createPostToolUseContextFor,
  createStopContextFor,
  invokeRun,
  MockHookContext,
} from "../support/test-helpers.ts";

const WRITE_FAIL = "fatal: failed to write commit object";
const COMMIT = "git commit -m x";

let markerDir: string;
let hook: ReturnType<typeof createHook>;

beforeEach(() => {
  markerDir = realpathSync(mkdtempSync(join(tmpdir(), "commit-sign-failure-")));
  hook = createHook(() => markerDir);
});

afterEach(() => {
  rmSync(markerDir, { recursive: true, force: true });
});

function markerPath(sessionId = "s1"): string {
  return join(markerDir, sessionId);
}

function bashCtx(
  command: string,
  stdout: string,
  overrides: { session_id?: string; agent_id?: string } = {},
) {
  return createPostToolUseContextFor(
    hook,
    "Bash",
    { command },
    { stdout, stderr: "" },
    { session_id: "s1", ...overrides },
  );
}

function failureCtx(
  command: string,
  error: string,
  overrides: { session_id?: string; agent_id?: string } = {},
) {
  // PostToolUseFailure has no builder in test-helpers; build the input shape
  // that cc-hooks-ts delivers (error string instead of tool_response).
  const input = {
    hook_event_name: "PostToolUseFailure" as const,
    cwd: "/test",
    session_id: overrides.session_id ?? "s1",
    transcript_path: "/test/transcript",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_1",
    error,
    ...(overrides.agent_id !== undefined
      ? { agent_id: overrides.agent_id }
      : {}),
  };
  return new MockHookContext<{ PostToolUseFailure: true }>(
    input as never,
  ) as unknown as Parameters<typeof hook.run>[0] &
    MockHookContext<{ PostToolUseFailure: true }>;
}

function askCtx(overrides: { session_id?: string; agent_id?: string } = {}) {
  return createPostToolUseContextFor(
    hook,
    "AskUserQuestion",
    { questions: [] },
    {},
    { session_id: "s1", ...overrides },
  );
}

function stopCtx(
  overrides: { session_id?: string; stop_hook_active?: boolean } = {},
) {
  return createStopContextFor(hook, { session_id: "s1", ...overrides });
}

function additionalContextOf(ctx: { jsonCalls: any[] }): string {
  return ctx.jsonCalls.at(-1)?.hookSpecificOutput?.additionalContext ?? "";
}

function plantMarker(sessionId = "s1", detectedAt = new Date().toISOString()) {
  writeFileSync(
    markerPath(sessionId),
    JSON.stringify({ detectedAt, labels: ["x"] }),
  );
}

describe("commit-sign-failure-ask: detection", () => {
  it("PostToolUse(Bash) detection injects main-loop context and writes the marker", async () => {
    const ctx = bashCtx(
      COMMIT,
      `error: gpg failed to sign the data\n${WRITE_FAIL}`,
    );
    await invokeRun(hook, ctx);
    const text = additionalContextOf(ctx);
    ok(text.includes("[commit-sign-failure-ask]"));
    ok(text.includes("AskUserQuestion"));
    ok(existsSync(markerPath()));
  });

  it("PostToolUseFailure(Bash) detection behaves the same", async () => {
    const ctx = failureCtx(
      COMMIT,
      "Exit code 128\nerror: gpg failed to sign the data",
    );
    await invokeRun(hook, ctx);
    ok(additionalContextOf(ctx).includes("AskUserQuestion"));
    strictEqual(
      ctx.jsonCalls.at(-1).hookSpecificOutput.hookEventName,
      "PostToolUseFailure",
    );
    ok(existsSync(markerPath()));
  });

  it("subagent detection injects subagent context and still writes the marker", async () => {
    const ctx = bashCtx(COMMIT, WRITE_FAIL, { agent_id: "a1" });
    await invokeRun(hook, ctx);
    const text = additionalContextOf(ctx);
    ok(text.includes("署名を外して再実行しない"));
    ok(!text.includes("AskUserQuestion"));
    ok(existsSync(markerPath()));
  });

  it("exit-code-0 failure keeps the marker and returns context again", async () => {
    plantMarker();
    const ctx = bashCtx(`${COMMIT}; git log -1`, `${WRITE_FAIL}\nabc x`);
    await invokeRun(hook, ctx);
    ok(additionalContextOf(ctx).includes("[commit-sign-failure-ask]"));
    ok(existsSync(markerPath()));
  });

  it("rejects an unsafe session_id: no marker, context still returned", async () => {
    const ctx = bashCtx(COMMIT, WRITE_FAIL, { session_id: "../x" });
    await invokeRun(hook, ctx);
    ok(additionalContextOf(ctx).includes("[commit-sign-failure-ask]"));
    strictEqual(readdirSync(markerDir).length, 0);
  });

  it("survives an unwritable marker directory", async () => {
    const blocker = join(markerDir, "file");
    writeFileSync(blocker, "");
    const brokenHook = createHook(() => join(blocker, "sub"));
    const ctx = createPostToolUseContextFor(
      brokenHook,
      "Bash",
      { command: COMMIT },
      { stdout: WRITE_FAIL, stderr: "" },
      { session_id: "s1" },
    );
    await invokeRun(brokenHook, ctx);
    ok(additionalContextOf(ctx).includes("[commit-sign-failure-ask]"));
  });
});

describe("commit-sign-failure-ask: Stop", () => {
  it("blocks once with AskUserQuestion reason and clears the marker", async () => {
    plantMarker();
    const ctx = stopCtx({ stop_hook_active: false });
    await invokeRun(hook, ctx);
    const out = ctx.jsonCalls.at(-1);
    strictEqual(out.decision, "block");
    ok(out.reason.includes("AskUserQuestion"));
    ok(!existsSync(markerPath()));

    const second = stopCtx({ stop_hook_active: false });
    await invokeRun(hook, second);
    strictEqual(second.jsonCalls.length, 0);
    second.assertSuccess({});
  });

  it("passes when stop_hook_active is true and keeps the marker", async () => {
    plantMarker();
    const ctx = stopCtx({ stop_hook_active: true });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    ok(existsSync(markerPath()));
  });

  it("passes with no marker", async () => {
    const ctx = stopCtx();
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });

  it("passes and removes a corrupt marker", async () => {
    writeFileSync(markerPath(), "{");
    const ctx = stopCtx();
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    ok(!existsSync(markerPath()));
  });

  it("does not touch another session's marker", async () => {
    plantMarker("s1");
    const ctx = stopCtx({ session_id: "s2" });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    ok(existsSync(markerPath("s1")));
  });

  it("passes and removes a marker older than 24 hours", async () => {
    plantMarker("s1", new Date(Date.now() - 25 * 3600 * 1000).toISOString());
    const ctx = stopCtx();
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    ok(!existsSync(markerPath()));
  });
});

describe("commit-sign-failure-ask: marker clearing", () => {
  it("main-loop AskUserQuestion clears the marker", async () => {
    plantMarker();
    await invokeRun(hook, askCtx());
    ok(!existsSync(markerPath()));
  });

  it("subagent AskUserQuestion keeps the marker", async () => {
    plantMarker();
    await invokeRun(hook, askCtx({ agent_id: "a1" }));
    ok(existsSync(markerPath()));
  });

  it("main-loop successful commit clears the marker", async () => {
    plantMarker();
    await invokeRun(hook, bashCtx(COMMIT, "[master 1a2b3c4] x"));
    ok(!existsSync(markerPath()));
  });

  it("subagent successful commit keeps the marker", async () => {
    plantMarker();
    await invokeRun(
      hook,
      bashCtx(COMMIT, "[master 1a2b3c4] x", { agent_id: "a1" }),
    );
    ok(existsSync(markerPath()));
  });

  it("unrelated main-loop Bash keeps the marker", async () => {
    plantMarker();
    await invokeRun(hook, bashCtx("ls", "a b"));
    ok(existsSync(markerPath()));
  });
});

describe("commit-sign-failure-ask.ts as a process", () => {
  // Unit tests call run() directly, so they pass even when the file has no
  // runHook entrypoint; spawning it is what catches a silently inert hook.
  it("prints additionalContext and writes the marker under $HOME", () => {
    const home = realpathSync(
      mkdtempSync(join(tmpdir(), "commit-sign-failure-home-")),
    );
    try {
      const input = {
        session_id: "proc1",
        transcript_path: join(home, "t.jsonl"),
        cwd: home,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "t1",
        tool_input: { command: `${COMMIT}; echo done` },
        tool_response: {
          stdout: `error: 1Password: x\n\n${WRITE_FAIL}\ndone`,
          stderr: "",
          interrupted: false,
          isImage: false,
        },
      };
      const result = spawnSync(
        "bun",
        [
          join(
            import.meta.dirname,
            "../../implementations/commit-sign-failure-ask.ts",
          ),
        ],
        {
          input: JSON.stringify(input),
          encoding: "utf-8",
          env: { PATH: process.env.PATH ?? "", HOME: home },
        },
      );
      strictEqual(result.status, 0, result.stderr);
      ok(result.stdout.includes("[commit-sign-failure-ask]"), result.stdout);
      ok(
        existsSync(
          join(home, ".claude", "state", "commit-sign-failure", "proc1"),
        ),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("commit-sign-failure-ask.ts: persisted (truncated) output", () => {
  // Claude Code cuts tool_response.stdout to the first 30000 chars when the
  // output is large, merges stderr into it, and puts the full text in the file
  // at persistedOutputPath. A pre-commit run prints far more than that before
  // git's signing error, so the error is only in the persisted file.
  function persistedCtx(command: string, preview: string, persisted?: string) {
    return createPostToolUseContextFor(
      hook,
      "Bash",
      { command },
      {
        stdout: preview,
        stderr: "",
        ...(persisted === undefined ? {} : { persistedOutputPath: persisted }),
      },
      { session_id: "s1" },
    );
  }

  it("detects a failure that is only in the persisted file", async () => {
    const full = join(markerDir, "out.txt");
    writeFileSync(
      full,
      `${"x\n".repeat(20000)}error: 1Password: y\n\n${WRITE_FAIL}\n`,
    );
    const ctx = persistedCtx(`${COMMIT}; git status`, "x\n".repeat(100), full);
    await invokeRun(hook, ctx);
    ok(JSON.stringify(ctx.jsonCalls).includes("[commit-sign-failure-ask]"));
    ok(existsSync(markerPath()));
  });

  it("ignores a persistedOutputPath that cannot be read", async () => {
    const ctx = persistedCtx(
      COMMIT,
      "[master 1a2b3c4] x",
      join(markerDir, "missing.txt"),
    );
    await invokeRun(hook, ctx);
    ok(!JSON.stringify(ctx.jsonCalls).includes("[commit-sign-failure-ask]"));
  });
});

describe("signFailureMarkerDir", () => {
  it("is the dir the hook writes to, shared with ask-preflight", () => {
    strictEqual(
      signFailureMarkerDir(),
      join(getHomeDir(), ".claude", "state", "commit-sign-failure"),
    );
  });
});
