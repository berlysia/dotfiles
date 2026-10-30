#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  readGuideDecisions,
  guideMarkerName,
  type SkillGuideDeps,
} from "../../lib/skill-guide.ts";
import { readMarker } from "../../lib/session-marker.ts";
import { run } from "../../implementations/skill-guide-gate.ts";

const HOOK = join(
  import.meta.dirname,
  "../../implementations/skill-guide-gate.ts",
);
const dirs: string[] = [];
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skill-guide-gate-")));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const DECLARATIONS = {
  "commit-standards": ["Bash(git commit)"],
  "git-safety": ["Bash(git-worktree-create)", "Bash(git worktree add)"],
  "model-offloading": ["Bash(delegation offload)", "Bash(codex exec)"],
} as const;

function putSkill(
  skillsRoot: string,
  name: string,
  patterns: readonly string[],
): void {
  mkdirSync(join(skillsRoot, name), { recursive: true });
  writeFileSync(
    join(skillsRoot, name, "SKILL.md"),
    `---\nname: ${name}\nread-before: ${JSON.stringify(patterns)}\n---\n\n# ${name}\n`,
  );
}

function makeEnv(): {
  home: string;
  skillsRoot: string;
  stateDir: string;
  transcriptPath: string;
  deps: SkillGuideDeps;
} {
  const home = tempDir();
  const skillsRoot = join(home, ".claude", "skills");
  const stateDir = join(home, ".claude", "state", "skill-guide");
  mkdirSync(skillsRoot, { recursive: true });
  for (const [name, patterns] of Object.entries(DECLARATIONS)) {
    putSkill(skillsRoot, name, patterns);
  }
  const transcriptPath = join(home, "transcript.jsonl");
  writeFileSync(transcriptPath, "");
  return {
    home,
    skillsRoot,
    stateDir,
    transcriptPath,
    deps: { skillsRoot, stateDir },
  };
}

function writeTranscript(path: string, lines: string[]): void {
  writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
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

function bashInput(
  env: ReturnType<typeof makeEnv>,
  command: string,
  options: {
    sessionId?: string;
    agentId?: string;
    transcriptPath?: string;
    includeTranscript?: boolean;
  } = {},
) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    ...(options.sessionId !== undefined
      ? { session_id: options.sessionId }
      : { session_id: "session-1" }),
    ...(options.includeTranscript === false
      ? {}
      : {
          transcript_path: options.transcriptPath ?? env.transcriptPath,
        }),
    ...(options.agentId !== undefined ? { agent_id: options.agentId } : {}),
    tool_input: { command },
  };
}

function markerContent(
  stateDir: string,
  skill: string,
  sessionId = "session-1",
): string | null {
  const name = guideMarkerName("gate", sessionId, undefined, skill, "_1");
  return readMarker(stateDir, name);
}

function eventLogText(): string {
  const logDir = process.env["CLAUDE_LOGS_DIR"];
  if (logDir === undefined) return "";
  try {
    return readFileSync(join(logDir, "events.jsonl"), "utf8");
  } catch {
    return "";
  }
}

function childEnv(env: ReturnType<typeof makeEnv>): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: env.home,
    CLAUDE_LOGS_DIR: process.env["CLAUDE_LOGS_DIR"] ?? join(env.home, "logs"),
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

describe("skill-guide-gate.ts", () => {
  it("denies an unread commit and keeps the reason within 120 characters", async () => {
    const env = makeEnv();
    const output = await run(bashInput(env, "git commit -m x"), env.deps);
    ok(output);
    const reason = (
      output as {
        hookSpecificOutput: { permissionDecisionReason: string };
      }
    ).hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("commit-standards"));
    ok(reason.includes("git commit"));
    ok(reason.length <= 120, reason);
  });

  it("denies each of the five declared operations with its skill name", async () => {
    const cases = [
      ["git commit -m x", "commit-standards", "git commit"],
      ["git-worktree-create foo", "git-safety", "git-worktree-create"],
      ["git worktree add ../x", "git-safety", "git worktree add"],
      [
        "delegation offload --brief-file /tmp/b",
        "model-offloading",
        "delegation offload",
      ],
      ["codex exec -m m p", "model-offloading", "codex exec"],
    ] as const;
    for (const [command, skill, words] of cases) {
      const env = makeEnv();
      const output = await run(bashInput(env, command), env.deps);
      ok(output, command);
      const reason = (
        output as {
          hookSpecificOutput: { permissionDecisionReason: string };
        }
      ).hookSpecificOutput.permissionDecisionReason;
      ok(reason.includes(skill), reason);
      ok(reason.includes(words), reason);
      ok(reason.length <= 120, reason);
    }
  });

  it("uses two deny slots, then records ignored once", async () => {
    const env = makeEnv();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const output = await run(bashInput(env, "git commit -m x"), env.deps);
      if (attempt <= 2) ok(output);
      else strictEqual(output, null);
    }
    const rows = readGuideDecisions(env.stateDir);
    strictEqual(rows.filter((row) => row.kind === "deny").length, 2);
    strictEqual(rows.filter((row) => row.kind === "ignored").length, 1);
  });

  it("passes after the exact distributed SKILL.md is read", async () => {
    const env = makeEnv();
    ok(await run(bashInput(env, "git commit -m x"), env.deps));
    writeTranscript(env.transcriptPath, [
      readLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
    ]);
    strictEqual(await run(bashInput(env, "git commit -m x"), env.deps), null);
    deepStrictEqual(
      readGuideDecisions(env.stateDir)
        .filter((row) => row.kind === "passed-read")
        .map((row) => row.skill),
      [["commit-standards"]],
    );
  });

  it("records a skill that disappears after its declaration is read only once", async () => {
    const env = makeEnv();
    const skillFile = join(env.skillsRoot, "commit-standards", "SKILL.md");
    let removed = false;
    const deps: SkillGuideDeps = {
      ...env.deps,
      scan: {
        now: () => {
          if (!removed) {
            unlinkSync(skillFile);
            removed = true;
          }
          return performance.now();
        },
      },
    };
    strictEqual(await run(bashInput(env, "git commit -m x"), deps), null);
    strictEqual(await run(bashInput(env, "git commit -m x"), deps), null);
    strictEqual(
      readGuideDecisions(env.stateDir).filter((row) => row.kind === "missing")
        .length,
      1,
    );
    strictEqual(markerContent(env.stateDir, "commit-standards"), null);
  });

  it("denies both matching skills once for a compound Bash input", async () => {
    const env = makeEnv();
    const output = await run(
      bashInput(env, "git commit -m x; git worktree add ../x"),
      env.deps,
    );
    ok(output);
    const reason = (
      output as {
        hookSpecificOutput: { permissionDecisionReason: string };
      }
    ).hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("commit-standards"), reason);
    ok(reason.includes("git-safety"), reason);
    ok(reason.length <= 120, reason);
    strictEqual(markerContent(env.stateDir, "commit-standards"), "git commit");
    strictEqual(markerContent(env.stateDir, "git-safety"), "git worktree add");
    const rows = readGuideDecisions(env.stateDir).filter(
      (row) => row.kind === "deny",
    );
    strictEqual(rows.length, 1);
    deepStrictEqual(rows[0]?.skill, ["commit-standards", "git-safety"]);
  });

  it("passes and logs marker-failed when the state path cannot be created", async () => {
    const env = makeEnv();
    const parentFile = join(env.home, "blocked-state-parent");
    writeFileSync(parentFile, "file");
    const before = eventLogText();
    strictEqual(
      await run(bashInput(env, "git commit -m x"), {
        ...env.deps,
        stateDir: join(parentFile, "state"),
      }),
      null,
    );
    strictEqual(existsSync(join(parentFile, "state")), false);
    ok(
      eventLogText()
        .slice(before.length)
        .includes("[skill-guide] marker-failed"),
    );
  });

  it("passes without consuming a marker when the read scan is bounded", async () => {
    const env = makeEnv();
    writeTranscript(env.transcriptPath, [
      readLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
      "filler".repeat(100),
    ]);
    const before = eventLogText();
    strictEqual(
      await run(bashInput(env, "git commit -m x"), {
        ...env.deps,
        scan: { chunkBytes: 64, maxScanBytes: 64, deadlineMs: 100 },
      }),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
    ok(eventLogText().slice(before.length).includes("[skill-guide] timeout"));
  });

  it("passes three times when transcript_path is absent", async () => {
    const env = makeEnv();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      strictEqual(
        await run(
          bashInput(env, "git commit -m x", { includeTranscript: false }),
          env.deps,
        ),
        null,
      );
    }
    strictEqual(existsSync(env.stateDir), false);
  });

  it("passes for an unreadable transcript and a malformed row beside a valid read", async () => {
    const env = makeEnv();
    strictEqual(
      await run(
        bashInput(env, "git commit -m x", {
          transcriptPath: join(env.home, "missing-transcript.jsonl"),
        }),
        env.deps,
      ),
      null,
    );
    writeTranscript(env.transcriptPath, [
      readLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
      "{broken JSON",
      JSON.stringify({ type: "user", message: { role: "user", content: [] } }),
    ]);
    strictEqual(await run(bashInput(env, "git commit -m x"), env.deps), null);
    strictEqual(existsSync(env.stateDir), false);
  });

  it("ignores declarations from skills outside the trusted list", async () => {
    const env = makeEnv();
    putSkill(env.skillsRoot, "third-party", ["Bash(git push)"]);
    strictEqual(await run(bashInput(env, "git push"), env.deps), null);
    strictEqual(existsSync(env.stateDir), false);
  });

  it("passes agent_id inputs without creating markers", async () => {
    const env = makeEnv();
    strictEqual(
      await run(
        bashInput(env, "git commit -m x", { agentId: "agent-1" }),
        env.deps,
      ),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
  });

  it("ignores git status and non-Bash hooks", async () => {
    const env = makeEnv();
    strictEqual(await run(bashInput(env, "git status"), env.deps), null);
    strictEqual(
      await run(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "SKILL.md" },
        },
        env.deps,
      ),
      null,
    );
    strictEqual(existsSync(env.stateDir), false);
  });
});

describe("skill-guide-gate.ts as a process", () => {
  it("prints a deny through the real entrypoint and accepts path overrides", () => {
    const env = makeEnv();
    const result = spawnHook(
      env,
      JSON.stringify(bashInput(env, "git commit -m x")),
      ["--skills-root", env.skillsRoot, "--state-dir", env.stateDir],
    );
    strictEqual(result.error, undefined, result.error?.message);
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes('"permissionDecision":"deny"'), result.stdout);
  });

  it("passes malformed, empty, oversized and unreadable inputs with exit code 0", () => {
    const env = makeEnv();
    const malformedTranscript = join(env.home, "malformed.jsonl");
    writeTranscript(malformedTranscript, [
      readLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
      "{broken JSON",
      JSON.stringify({ type: "user", message: { role: "user", content: [] } }),
    ]);
    const cases = [
      ["invalid JSON", "{"],
      ["empty stdin", ""],
      ["oversized stdin", " ".repeat(1024 * 1024 + 1)],
      [
        "no transcript_path",
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          session_id: "session-1",
          tool_input: { command: "git commit -m x" },
        }),
      ],
      [
        "missing transcript file",
        JSON.stringify(
          bashInput(env, "git commit -m x", {
            transcriptPath: join(env.home, "does-not-exist.jsonl"),
          }),
        ),
      ],
      [
        "malformed transcript row",
        JSON.stringify(
          bashInput(env, "git commit -m x", {
            transcriptPath: malformedTranscript,
          }),
        ),
      ],
    ] as const;
    const failures: string[] = [];
    for (const [label, input] of cases) {
      const result = spawnHook(env, input, [
        "--skills-root",
        env.skillsRoot,
        "--state-dir",
        env.stateDir,
      ]);
      if (result.error !== undefined) {
        failures.push(`${label}: ${result.error.message}`);
      } else if (result.status !== 0 || result.stdout !== "") {
        failures.push(
          `${label}: status=${String(result.status)} stdout=${result.stdout} stderr=${result.stderr}`,
        );
      }
    }
    strictEqual(failures.length, 0, failures.join("\n"));
  });
});
