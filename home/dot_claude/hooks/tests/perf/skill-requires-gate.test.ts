#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  run,
  type SkillRequiresGateDeps,
} from "../../implementations/skill-requires-gate.ts";
import { scanLoadedSkills } from "../../lib/skill-requires.ts";

const HOOK = join(
  import.meta.dirname,
  "../../implementations/skill-requires-gate.ts",
);
const PR_FM =
  'requires-skills: [tanteki, japanese-tech-writing, koncise]\nrequires-skills-before: ["Bash(gh pr create)"]';
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-requires-perf-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const loadLine = (name: string) =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `Base directory for this skill: /home/user/.claude/skills/${name}\n\n# body`,
        },
      ],
    },
  });

function putSkill(skillsDir: string, name: string, fm: string): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(
    join(skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\n${fm}\n---\n\n# ${name}\n`,
  );
}

function makeDeps(skillCount: number): {
  root: string;
  deps: SkillRequiresGateDeps;
} {
  const root = tempDir();
  const skillsDir = join(root, "skills");
  mkdirSync(skillsDir);
  putSkill(skillsDir, "pr-description", PR_FM);
  for (let i = 0; i < skillCount; i++) {
    putSkill(skillsDir, `plain-${i}`, "description: x");
  }
  return {
    root,
    deps: { stateDir: join(root, "state"), skillsDir, now: () => new Date() },
  };
}

const input = (transcriptPath: string, command: string) => ({
  hook_event_name: "PreToolUse",
  session_id: "perf1",
  transcript_path: transcriptPath,
  tool_name: "Bash",
  tool_input: { command },
});

/** A transcript whose first line is the pr-description load and the rest unrelated lines. */
function bigTranscript(root: string, megabytes: number): string {
  const path = join(root, "big.jsonl");
  const fd = openSync(path, "w");
  try {
    writeSync(fd, `${loadLine("pr-description")}\n`);
    const line = `${JSON.stringify({ type: "assistant", text: "z".repeat(900) })}\n`;
    const block = Buffer.from(line.repeat(1024));
    const blocks = Math.ceil((megabytes * 1024 * 1024) / block.length);
    for (let i = 0; i < blocks; i++) writeSync(fd, block);
  } finally {
    closeSync(fd);
  }
  return path;
}

describe("skill-requires-gate speed", () => {
  it("decides in under 200 ms with 200 skills and a Bash call that matches nothing", async () => {
    const { root, deps } = makeDeps(200);
    const started = performance.now();
    strictEqual(await run(input(join(root, "t.jsonl"), "ls -la"), deps), null);
    const elapsed = performance.now() - started;
    console.error(`[perf] 200 skills, no match: ${elapsed.toFixed(1)} ms`);
    ok(elapsed < 200, `took ${elapsed}ms`);
  });

  it("finishes in under 500 ms including the bun start", () => {
    const { root } = makeDeps(200);
    mkdirSync(join(root, ".claude"), { recursive: true });
    const started = performance.now();
    const result = spawnSync("bun", [HOOK], {
      input: JSON.stringify(input(join(root, "t.jsonl"), "ls -la")),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        SKILL_REQUIRES_GATE_STATE_DIR: join(root, "state"),
      },
    });
    const elapsed = performance.now() - started;
    console.error(
      `[perf] process, 200 skills, no match: ${elapsed.toFixed(1)} ms`,
    );
    strictEqual(result.status, 0, result.stderr);
    ok(elapsed < 500, `took ${elapsed}ms`);
  });

  it("exits 0 within 3 s when stdin never closes", async () => {
    const { root } = makeDeps(1);
    const started = performance.now();
    const child = spawn("bun", [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        SKILL_REQUIRES_GATE_STATE_DIR: join(root, "state"),
      },
    });
    const code = await new Promise<number | null>((resolve) => {
      const guard = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 10_000);
      child.on("exit", (c) => {
        clearTimeout(guard);
        resolve(c);
      });
    });
    const elapsed = performance.now() - started;
    console.error(
      `[perf] stdin left open: exit ${code} after ${elapsed.toFixed(0)} ms`,
    );
    strictEqual(code, 0);
    ok(elapsed < 3000, `took ${elapsed}ms`);
  });
});

describe("skill-requires-gate on a 64 MB transcript", () => {
  it("denies when the deadline is 10 s (the load at the very start is seen)", async () => {
    const { root, deps } = makeDeps(1);
    const path = bigTranscript(root, 64);
    const started = performance.now();
    const output = (await run(input(path, "gh pr create --title x"), {
      ...deps,
      scan: { deadlineMs: 10_000 },
    })) as { hookSpecificOutput?: { permissionDecision?: string } } | null;
    const elapsed = performance.now() - started;
    console.error(`[perf] 64 MB scan to the start: ${elapsed.toFixed(0)} ms`);
    strictEqual(output?.hookSpecificOutput?.permissionDecision, "deny");
    ok(elapsed < 10_000, `took ${elapsed}ms`);
  });

  it("returns in under 2000 ms with the default deadline, deny or timeout pass", async () => {
    const { root, deps } = makeDeps(1);
    const path = bigTranscript(root, 64);
    const started = performance.now();
    const output = await run(input(path, "gh pr create --title x"), deps);
    const elapsed = performance.now() - started;
    ok(output === null || typeof output === "object");
    console.error(
      `[perf] default deadline, ${output === null ? "passed" : "denied"}: ${elapsed.toFixed(0)} ms`,
    );
    ok(elapsed < 2000, `took ${elapsed}ms`);

    const scan = scanLoadedSkills(path, {
      needed: new Set(["pr-description", "tanteki"]),
    });
    console.error(
      `[perf] bytes read within the default deadline: ${scan.bytesRead} (timedOut=${scan.timedOut})`,
    );
  });
});
