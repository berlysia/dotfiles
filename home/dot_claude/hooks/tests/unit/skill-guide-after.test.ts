#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createGuideMarker,
  guideMarkerName,
  type SkillGuideDeadline,
} from "../../lib/skill-guide.ts";
import {
  run,
  REVIEWER_AGENT_TYPES,
} from "../../implementations/skill-guide-after.ts";

const HOOK = join(
  import.meta.dirname,
  "../../implementations/skill-guide-after.ts",
);
const AGENT_DIR = join(import.meta.dirname, "../../../agents");
const dirs: string[] = [];
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skill-guide-after-")));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const AFTER_SKILLS = [
  "debugging",
  "defect-triage",
  "model-offloading",
  "delivery-policy",
  "context-md",
] as const;

function putSkill(skillsRoot: string, name: string): void {
  mkdirSync(join(skillsRoot, name), { recursive: true });
  writeFileSync(
    join(skillsRoot, name, "SKILL.md"),
    `---\nname: ${name}\n---\n\n# ${name}\n`,
  );
}

function makeEnv() {
  const home = tempDir();
  const cwd = join(home, "repo");
  const skillsRoot = join(home, ".claude", "skills");
  const stateDir = join(home, ".claude", "state", "skill-guide");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });
  for (const skill of AFTER_SKILLS) putSkill(skillsRoot, skill);
  const transcriptPath = join(home, "transcript.jsonl");
  writeFileSync(transcriptPath, "");
  return {
    home,
    cwd,
    skillsRoot,
    stateDir,
    transcriptPath,
    deps: { skillsRoot, stateDir, cwd },
  };
}

function eventInput(
  env: ReturnType<typeof makeEnv>,
  event: string,
  fields: Record<string, unknown> = {},
) {
  return {
    hook_event_name: event,
    session_id: "session-1",
    cwd: env.cwd,
    transcript_path: env.transcriptPath,
    ...fields,
  };
}

function additionalContext(output: object | null): string | null {
  if (output === null) return null;
  const root = output as {
    hookSpecificOutput?: { additionalContext?: unknown };
  };
  const value = root.hookSpecificOutput?.additionalContext;
  return typeof value === "string" ? value : null;
}

function readLine(filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read-1",
          name: "Read",
          input: { file_path: filePath },
        },
      ],
    },
  });
}

function makeFakeGit(env: ReturnType<typeof makeEnv>, mode: string): string {
  const binDir = join(env.home, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(env.home, "fake-git-mode"), mode);
  const script = [
    "#!/bin/sh",
    `printf '{"args":"%s","optionalLocks":"%s"}\\n' "$*" "$GIT_OPTIONAL_LOCKS" >> "$HOME/fake-git-calls.jsonl"`,
    'mode=$(cat "$HOME/fake-git-mode")',
    'case " $* " in *" rev-list "*)',
    '  case "$mode" in no-upstream) echo 1 ;; *) echo 0 ;; esac',
    "  exit 0 ;;",
    "esac",
    'case "$mode" in',
    '  no-upstream) printf "# branch.oid hash\\n# branch.head work\\n" ;;',
    '  dirty) printf "1 .M N... 100644 100644 100644 hash hash file\\n" ;;',
    '  ahead) printf "# branch.oid hash\\n# branch.head main\\n# branch.upstream origin/main\\n# branch.ab +1 -0\\n" ;;',
    "  not-worktree) exit 128 ;;",
    "  slow) sleep 2 ;;",
    '  *) printf "# branch.oid hash\\n# branch.head main\\n# branch.ab +0 -0\\n" ;;',
    "esac",
  ].join("\n");
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, `${script}\n`, { mode: 0o755 });
  chmodSync(gitPath, 0o755);
  return binDir;
}

async function withFakeGit<T>(
  env: ReturnType<typeof makeEnv>,
  mode: string,
  work: () => Promise<T>,
): Promise<T> {
  const binDir = makeFakeGit(env, mode);
  const previousHome = process.env["HOME"];
  const previousPath = process.env["PATH"];
  process.env["HOME"] = env.home;
  process.env["PATH"] = `${binDir}:${previousPath ?? ""}`;
  try {
    return await work();
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  }
}

function fakeGitCalls(home: string): Array<{ optionalLocks?: string }> {
  try {
    return readFileSync(join(home, "fake-git-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { optionalLocks?: string });
  } catch {
    return [];
  }
}

function eventLogText(): string {
  const logsDir = process.env["CLAUDE_LOGS_DIR"];
  if (logsDir === undefined) return "";
  try {
    return readFileSync(join(logsDir, "events.jsonl"), "utf8");
  } catch {
    return "";
  }
}

function childEnv(env: ReturnType<typeof makeEnv>): NodeJS.ProcessEnv {
  return {
    PATH: process.env["CLAUDE_TEST_ORIGINAL_PATH"] ?? process.env["PATH"] ?? "",
    HOME: env.home,
    CLAUDE_LOGS_DIR: join(env.home, "logs"),
  };
}

function spawnHook(
  env: ReturnType<typeof makeEnv>,
  input: string,
  args: string[] = [],
) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: "utf8",
    env: childEnv(env),
    timeout: 3000,
  });
}

describe("skill-guide-after.ts", () => {
  it("suggests debugging after a Bash failure once per session", async () => {
    const env = makeEnv();
    const input = eventInput(env, "PostToolUseFailure", { tool_name: "Bash" });
    const first = await run(input, env.deps);
    const context = additionalContext(first);
    ok(context?.includes("debugging"), String(context));
    strictEqual(context?.split("\n").length, 1);
    ok((context?.length ?? 121) <= 120, context ?? "no context");
    strictEqual(await run(input, env.deps), null);
  });

  it("does not print or create a marker for a subagent Bash failure", async () => {
    const env = makeEnv();
    strictEqual(
      await run(
        eventInput(env, "PostToolUseFailure", {
          tool_name: "Bash",
          agent_id: "agent-1",
        }),
        env.deps,
      ),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
  });

  it("suggests defect-triage for a reviewer with an explicit model", async () => {
    const env = makeEnv();
    const context = additionalContext(
      await run(
        eventInput(env, "PostToolUse", {
          tool_name: "Agent",
          tool_input: {
            subagent_type: "logic-validator",
            model: "claude-sonnet",
          },
        }),
        env.deps,
      ),
    );
    ok(context?.includes("defect-triage"), String(context));
    strictEqual(context?.split("\n").length, 1);
  });

  it("suggests model-offloading for an Agent without a model", async () => {
    const env = makeEnv();
    const context = additionalContext(
      await run(
        eventInput(env, "PostToolUse", {
          tool_name: "Agent",
          tool_input: { subagent_type: "Explore" },
        }),
        env.deps,
      ),
    );
    ok(context?.includes("model-offloading"), String(context));
    strictEqual(context?.split("\n").length, 1);
  });

  it("combines reviewer and model guidance into one additionalContext", async () => {
    const env = makeEnv();
    const context = additionalContext(
      await run(
        eventInput(env, "PostToolUse", {
          tool_name: "Agent",
          tool_input: { subagent_type: "logic-validator" },
        }),
        env.deps,
      ),
    );
    ok(context?.includes("defect-triage"), String(context));
    ok(context?.includes("model-offloading"), String(context));
    strictEqual(context?.split("\n").length, 2);
    ok(
      context?.split("\n").every((line) => line.length <= 120),
      context ?? "no context",
    );
  });

  it("does not repeat guidance for a skill already read in the transcript", async () => {
    const env = makeEnv();
    writeFileSync(
      env.transcriptPath,
      `${readLine(join(env.skillsRoot, "debugging", "SKILL.md"))}\n`,
    );
    strictEqual(
      await run(
        eventInput(env, "PostToolUseFailure", { tool_name: "Bash" }),
        env.deps,
      ),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
  });

  it("does not suggest a skill when its transcript scan times out", async () => {
    const env = makeEnv();
    writeFileSync(env.transcriptPath, "unrelated transcript content\n");
    let clockCalls = 0;
    strictEqual(
      await run(eventInput(env, "PostToolUseFailure", { tool_name: "Bash" }), {
        ...env.deps,
        scan: {
          chunkBytes: 4,
          now: () => {
            clockCalls += 1;
            return clockCalls === 1 ? 0 : 1000;
          },
        },
      }),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
  });

  it("suggests context-md when a supported context document exists", async () => {
    const env = makeEnv();
    writeFileSync(join(env.cwd, "CONTEXT.md"), "context\n");
    const input = {
      hook_event_name: "SessionStart",
      session_id: "session-1",
      cwd: env.cwd,
    };
    const context = additionalContext(await run(input, env.deps));
    ok(context?.includes("context-md"), String(context));
    strictEqual(context?.split("\n").length, 1);
  });

  it("does not suggest context-md when none of the context files exists", async () => {
    const env = makeEnv();
    strictEqual(
      await run(
        {
          hook_event_name: "SessionStart",
          session_id: "session-1",
          cwd: env.cwd,
        },
        env.deps,
      ),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
  });

  it("suggests delivery-policy for uncommitted work and sets optional locks off", async () => {
    const env = makeEnv();
    const input = eventInput(env, "Stop", {
      stop_hook_active: false,
    });
    const before = eventLogText();
    const output = await withFakeGit(env, "dirty", () => run(input, env.deps));
    const context = additionalContext(output);
    ok(
      context?.includes("delivery-policy"),
      JSON.stringify({
        context,
        calls: fakeGitCalls(env.home),
        marker: existsSync(
          join(
            env.stateDir,
            guideMarkerName("after", "session-1", undefined, "delivery-policy"),
          ),
        ),
        events: eventLogText().slice(before.length),
      }),
    );
    const calls = fakeGitCalls(env.home);
    strictEqual(calls.length, 1);
    strictEqual(calls[0]?.optionalLocks, "0");
  });

  it("does not run git when stop_hook_active is true", async () => {
    const env = makeEnv();
    strictEqual(
      await run(eventInput(env, "Stop", { stop_hook_active: true }), env.deps),
      null,
    );
    strictEqual(fakeGitCalls(env.home).length, 0);
  });

  it("passes through when the cwd is not a git worktree", async () => {
    const env = makeEnv();
    strictEqual(
      await withFakeGit(env, "not-worktree", () =>
        run(eventInput(env, "Stop", { stop_hook_active: false }), env.deps),
      ),
      null,
    );
  });

  it("does not call git when the Stop scene marker already exists", async () => {
    const env = makeEnv();
    ok(
      createGuideMarker({
        stateDir: env.stateDir,
        sessionId: "session-1",
        target: "delivery-policy",
        kind: "after",
      }),
    );
    strictEqual(
      await withFakeGit(env, "dirty", () =>
        run(eventInput(env, "Stop", { stop_hook_active: false }), env.deps),
      ),
      null,
    );
    strictEqual(fakeGitCalls(env.home).length, 0);
  });

  it("suggests delivery-policy when the branch is one commit ahead", async () => {
    const env = makeEnv();
    const output = await withFakeGit(env, "ahead", () =>
      run(eventInput(env, "Stop", { stop_hook_active: false }), env.deps),
    );
    ok(
      additionalContext(output)?.includes("delivery-policy"),
      JSON.stringify({ output, calls: fakeGitCalls(env.home) }),
    );
  });

  it("suggests delivery-policy for commits on a branch without an upstream", async () => {
    const env = makeEnv();
    const output = await withFakeGit(env, "no-upstream", () =>
      run(eventInput(env, "Stop", { stop_hook_active: false }), env.deps),
    );
    ok(
      additionalContext(output)?.includes("delivery-policy"),
      JSON.stringify({ output, calls: fakeGitCalls(env.home) }),
    );
  });

  it("prints nothing for a clean branch without an upstream and no local commits", async () => {
    const env = makeEnv();
    strictEqual(
      await withFakeGit(env, "clean", () =>
        run(eventInput(env, "Stop", { stop_hook_active: false }), env.deps),
      ),
      null,
    );
    strictEqual(fakeGitCalls(env.home).length, 2);
  });

  it("passes through a Bash failure without transcript_path", async () => {
    const env = makeEnv();
    const input = eventInput(env, "PostToolUseFailure", { tool_name: "Bash" });
    const { transcript_path: _transcriptPath, ...withoutTranscript } = input;
    strictEqual(await run(withoutTranscript, env.deps), null);
    strictEqual(existsSync(env.stateDir), false);
  });

  it("logs marker-failed and prints nothing when the state parent is a file", async () => {
    const env = makeEnv();
    const parentFile = join(env.home, "state-parent-file");
    writeFileSync(parentFile, "file");
    const before = eventLogText();
    strictEqual(
      await run(eventInput(env, "PostToolUseFailure", { tool_name: "Bash" }), {
        ...env.deps,
        stateDir: join(parentFile, "state"),
      }),
      null,
    );
    ok(
      eventLogText().slice(before.length).includes("marker-failed"),
      eventLogText().slice(before.length),
    );
  });

  it("stops without a marker when no shared deadline remains", async () => {
    const env = makeEnv();
    const deadline: SkillGuideDeadline = {
      remaining: () => 0,
      expired: () => true,
    };
    strictEqual(
      await run(eventInput(env, "PostToolUseFailure", { tool_name: "Bash" }), {
        ...env.deps,
        deadline,
      }),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
  });

  it("covers every reviewer name emitted by plan-review-automation", () => {
    strictEqual(REVIEWER_AGENT_TYPES.length, 10);
    for (const name of REVIEWER_AGENT_TYPES) {
      ok(existsSync(join(AGENT_DIR, `${name}.md`)), name);
    }
  });
});

describe("skill-guide-after.ts as a process", () => {
  it("prints additionalContext and exits zero for a Bash failure", () => {
    const env = makeEnv();
    const input = eventInput(env, "PostToolUseFailure", { tool_name: "Bash" });
    const result = spawnHook(env, JSON.stringify(input), [
      "--skills-root",
      env.skillsRoot,
      "--state-dir",
      env.stateDir,
    ]);
    strictEqual(result.error, undefined, result.error?.message);
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes("additionalContext"), result.stdout);
  });

  it("passes invalid, empty, and oversized stdin with exit code zero", () => {
    const env = makeEnv();
    const cases = ["{", "", " ".repeat(1024 * 1024 + 1)];
    for (const input of cases) {
      const result = spawnHook(env, input, [
        "--skills-root",
        env.skillsRoot,
        "--state-dir",
        env.stateDir,
      ]);
      strictEqual(result.error, undefined, result.error?.message);
      strictEqual(result.status, 0, result.stderr);
      strictEqual(result.stdout, "");
    }
  });
});
