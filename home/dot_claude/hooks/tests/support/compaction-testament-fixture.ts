// Shared by unit/compaction-testament.test.ts and heavy/compaction-testament.test.ts.
// Functions and constants only: each test file owns its EnvironmentHelper, its
// temp-dir list and its beforeEach/afterEach registrations. Nothing here starts
// git; setupHookEnv() takes a callback for the files that need a repository.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHook } from "../../implementations/compaction-testament.ts";
import {
  parseState,
  type TestamentState,
} from "../../lib/compaction-testament.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  createPostToolUseContextFor,
  invokeRun,
  type EnvironmentHelper,
} from "./test-helpers.ts";

export const PATIENT_TIMEOUT_MS = 10_000;
export const hook = createHook(() => ({ gitTimeoutMs: PATIENT_TIMEOUT_MS }));

export const INITIAL: TestamentState = {
  version: 1,
  stage: 0,
  stopBlocked: false,
  usageMissStreak: 0,
  degradedNotified: false,
};

export const assistantLine = (
  usage: { i: number; c: number; r: number },
  over: Record<string, unknown> = {},
  msgOver: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: {
      model: "m",
      usage: {
        input_tokens: usage.i,
        cache_creation_input_tokens: usage.c,
        cache_read_input_tokens: usage.r,
      },
      ...msgOver,
    },
    ...over,
  });

export const HOOK_FIXTURE_TOKENS = 94048;
export const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

export type HookEnv = { repo: string; wfDir: string; tdir: string };

/** The describe's beforeEach body: isolate env, and track the temp dir it makes. */
export function installHookEnv(
  envHelper: EnvironmentHelper,
  dirs: string[],
): void {
  envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  envHelper.set("CLAUDE_CODE_AUTO_COMPACT_WINDOW", undefined);
  // A developer-level global excludes file may already ignore `.tmp`, which
  // would make the "not ignored" fixtures unreproducible.
  envHelper.set("GIT_CONFIG_GLOBAL", "/dev/null");
  envHelper.set("GIT_CONFIG_NOSYSTEM", "1");
  // Keep the hook away from the real ~/.claude/settings.json.
  const cfg = mkdtempSync(join(tmpdir(), "ct-cfg-"));
  dirs.push(cfg);
  envHelper.set("XDG_CONFIG_HOME", join(cfg, "xdg"));
  envHelper.set("CLAUDE_CONFIG_DIR", cfg);
}

/** The describe's afterEach body. */
export function restoreHookEnv(
  envHelper: EnvironmentHelper,
  dirs: string[],
): void {
  envHelper.restore();
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, ".tmp", "sessions", "test-ses"), 0o700);
    } catch {
      // not every dir has a workflow dir
    }
    rmSync(d, { recursive: true, force: true });
  }
}

/**
 * Makes the repo / transcript dirs and the workflow dir. `prepareRepo` runs
 * after the repo dir exists and before the workflow dir is created.
 */
export function setupHookEnv(
  envHelper: EnvironmentHelper,
  dirs: string[],
  prepareRepo?: (repo: string) => void,
): HookEnv {
  const repo = mkdtempSync(join(tmpdir(), "ct-repo-"));
  const tdir = mkdtempSync(join(tmpdir(), "ct-tr-"));
  dirs.push(repo, tdir);
  prepareRepo?.(repo);
  const wfDir = join(repo, deriveDefaultWorkflowDir("test-session"));
  mkdirSync(wfDir, { recursive: true });
  envHelper.set("CLAUDE_TEST_CWD", repo);
  return { repo, wfDir, tdir };
}

// A Bash `cd` moves the session cwd that every later hook receives, so the
// workflow dir must not be derived from it. The drift target is the workflow
// dir itself, as observed on a real device.
export function anchorHookOnProjectDir(
  envHelper: EnvironmentHelper,
  env: HookEnv,
): void {
  envHelper.set("CLAUDE_TEST_CWD", undefined);
  envHelper.set("CLAUDE_PROJECT_DIR", env.repo);
}

export const transcriptAt = (env: HookEnv, tokens: number | null): string => {
  const path = join(env.tdir, "t.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      isSidechain: false,
      message: {
        role: "user",
        content: "SECRET-UTTERANCE sk-ant-" + "a".repeat(30),
      },
    }),
  ];
  if (tokens !== null) lines.push(assistantLine({ i: 1, c: 0, r: tokens - 1 }));
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
};

export const writeState = (env: HookEnv, over: Partial<TestamentState>): void =>
  writeFileSync(
    join(env.wfDir, "testament-state.json"),
    JSON.stringify({ ...INITIAL, ...over }),
  );
export const readStateFile = (env: HookEnv): TestamentState =>
  parseState(
    existsSync(join(env.wfDir, "testament-state.json"))
      ? readFileSync(join(env.wfDir, "testament-state.json"), "utf8")
      : null,
  );
export const recordPath = (env: HookEnv): string =>
  join(env.wfDir, "testament-written.json");
export const writeTestament = (
  env: HookEnv,
  body: string,
  tokens: number | null,
  recordedSha: string = sha256Hex(body),
): void => {
  writeFileSync(join(env.wfDir, "testament.md"), body);
  writeFileSync(
    recordPath(env),
    JSON.stringify({ version: 1, sha256: recordedSha, tokens }),
  );
};

export const post = async (
  env: HookEnv,
  transcript: string,
  tool: "Write" | "Bash" = "Bash",
  toolInput: Record<string, unknown> = { command: "true" },
  over: { agent_id?: string } = {},
) => {
  const ctx = createPostToolUseContextFor(
    hook,
    tool,
    toolInput as never,
    {},
    { cwd: env.repo, ...over },
  );
  (ctx.input as { transcript_path: string }).transcript_path = transcript;
  const result = await invokeRun(hook, ctx);
  return {
    ctx,
    result: result as { payload?: { event: string; output: any } },
  };
};
export const writeTestamentInput = {
  file_path: ".tmp/sessions/test-ses/testament.md",
  content: "ignored",
};
export const additionalContextOf = (ctx: { jsonCalls: any[] }): string =>
  ctx.jsonCalls.at(-1)?.hookSpecificOutput?.additionalContext ?? "";
