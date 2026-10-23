#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  run,
  type SkillRequiresGateDeps,
} from "../../implementations/skill-requires-gate.ts";

const HOOK = join(
  import.meta.dirname,
  "../../implementations/skill-requires-gate.ts",
);
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-requires-gate-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const PR_FM =
  'requires-skills: [tanteki, japanese-tech-writing, koncise]\nrequires-skills-before: ["Bash(gh pr create)", "Bash(gh pr edit)"]';
const ELI_FM =
  'requires-skills: [stop-describing-ui]\nrequires-skills-before: ["Write(**/*.html)"]';

function putSkill(skillsDir: string, name: string, fm: string): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(
    join(skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\n${fm}\n---\n\n# ${name}\n`,
  );
}

interface Env {
  root: string;
  skillsDir: string;
  stateDir: string;
  deps: SkillRequiresGateDeps;
}

function makeEnv(declare = true): Env {
  const root = tempDir();
  const skillsDir = join(root, "skills");
  const stateDir = join(root, "state");
  mkdirSync(skillsDir);
  if (declare) {
    putSkill(skillsDir, "pr-description", PR_FM);
    putSkill(skillsDir, "visual-eli", ELI_FM);
  }
  return {
    root,
    skillsDir,
    stateDir,
    deps: { stateDir, skillsDir, now: () => new Date() },
  };
}

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

function transcript(env: Env, names: string[]): string {
  const path = join(env.root, `t-${names.join("-") || "none"}.jsonl`);
  writeFileSync(path, `${names.map(loadLine).join("\n")}\n`);
  return path;
}

const bashInput = (
  transcriptPath: string,
  command: string,
  extra: Record<string, unknown> = {},
) => ({
  hook_event_name: "PreToolUse",
  session_id: "sess1",
  transcript_path: transcriptPath,
  tool_name: "Bash",
  tool_input: { command },
  ...extra,
});

const PR_CREATE = "gh pr create --title x --body-file b.md";
const ALL = ["pr-description", "tanteki", "japanese-tech-writing", "koncise"];

const decisions = (env: Env): Record<string, unknown>[] => {
  const path = join(env.stateDir, "decisions.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const markerNames = (env: Env): string[] =>
  existsSync(env.stateDir)
    ? readdirSync(env.stateDir).filter((n) => n !== "decisions.log")
    : [];

const reasonOf = (output: object | null): string => {
  const hook = (
    output as { hookSpecificOutput?: Record<string, string> } | null
  )?.hookSpecificOutput;
  strictEqual(hook?.["permissionDecision"], "deny");
  return hook?.["permissionDecisionReason"] ?? "";
};

describe("skill-requires-gate run()", () => {
  it("denies once with the missing names, then passes and records the later pass", async () => {
    const env = makeEnv();
    const t = transcript(env, ["pr-description"]);
    const reason = reasonOf(await run(bashInput(t, PR_CREATE), env.deps));
    for (const name of ["tanteki", "japanese-tech-writing", "koncise"]) {
      ok(reason.includes(name), reason);
    }
    ok(reason.includes("省く理由を応答に 1 行書いてから"));
    ok(reason.includes("2 回目は止めない"));
    strictEqual(decisions(env).length, 1);

    strictEqual(await run(bashInput(t, PR_CREATE), env.deps), null);
    const rows = decisions(env);
    strictEqual(rows.length, 2);
    strictEqual(rows[1]?.["kind"], "passed");
    deepStrictEqual(rows[1]?.["missing"], [
      "tanteki",
      "japanese-tech-writing",
      "koncise",
    ]);

    strictEqual(await run(bashInput(t, PR_CREATE), env.deps), null);
    strictEqual(decisions(env).length, 2);
  });

  it("records the later pass with no missing names when all were loaded after the deny", async () => {
    const env = makeEnv();
    reasonOf(
      await run(
        bashInput(transcript(env, ["pr-description"]), PR_CREATE),
        env.deps,
      ),
    );
    strictEqual(
      await run(bashInput(transcript(env, ALL), PR_CREATE), env.deps),
      null,
    );
    const rows = decisions(env);
    strictEqual(rows[1]?.["kind"], "passed");
    deepStrictEqual(rows[1]?.["missing"], []);
  });

  it("passes without a marker when everything is loaded", async () => {
    const env = makeEnv();
    strictEqual(
      await run(bashInput(transcript(env, ALL), PR_CREATE), env.deps),
      null,
    );
    strictEqual(markerNames(env).length, 0);
  });

  it("names only what is missing", async () => {
    const env = makeEnv();
    const reason = reasonOf(
      await run(
        bashInput(transcript(env, ["pr-description", "tanteki"]), PR_CREATE),
        env.deps,
      ),
    );
    const missingPart = reason.split("\n")[0] ?? "";
    ok(
      missingPart.includes("japanese-tech-writing") &&
        missingPart.includes("koncise"),
    );
    ok(!missingPart.includes("tanteki,") && !/: .*tanteki/.test(missingPart));
  });

  it("does not check when the declaring skill itself was not loaded, then checks once it is", async () => {
    const env = makeEnv();
    strictEqual(
      await run(bashInput(transcript(env, []), PR_CREATE), env.deps),
      null,
    );
    strictEqual(markerNames(env).length, 0);
    reasonOf(
      await run(
        bashInput(transcript(env, ["pr-description"]), PR_CREATE),
        env.deps,
      ),
    );
  });

  it("passes operations that match no pattern", async () => {
    const env = makeEnv();
    const t = transcript(env, ["pr-description"]);
    strictEqual(await run(bashInput(t, "gh pr view 1"), env.deps), null);
    strictEqual(
      await run(bashInput(t, 'git commit -m "gh pr create"'), env.deps),
      null,
    );
    strictEqual(markerNames(env).length, 0);
  });

  it("gates Write by extension", async () => {
    const env = makeEnv();
    const t = transcript(env, ["visual-eli"]);
    const write = (file: string) => ({
      hook_event_name: "PreToolUse",
      session_id: "sess1",
      transcript_path: t,
      tool_name: "Write",
      tool_input: { file_path: file, content: "x" },
    });
    strictEqual(await run(write("/x/page.md"), env.deps), null);
    ok(
      reasonOf(await run(write("/x/page.html"), env.deps)).includes(
        "stop-describing-ui",
      ),
    );
  });

  it("with two matching declarations, denies for the one without a marker only", async () => {
    const env = makeEnv();
    putSkill(
      env.skillsDir,
      "other-skill",
      'requires-skills: [koncise]\nrequires-skills-before: ["Bash(gh pr create)"]',
    );
    const t = transcript(env, ["pr-description", "other-skill"]);
    // First: both denied, marking both.
    const first = reasonOf(await run(bashInput(t, PR_CREATE), env.deps));
    ok(first.includes("pr-description") && first.includes("other-skill"));

    const env2 = makeEnv();
    putSkill(
      env2.skillsDir,
      "other-skill",
      'requires-skills: [koncise]\nrequires-skills-before: ["Bash(gh pr create)"]',
    );
    // Marker present for pr-description only: loading other-skill later denies for it alone.
    reasonOf(
      await run(
        bashInput(transcript(env2, ["pr-description"]), PR_CREATE),
        env2.deps,
      ),
    );
    const t2 = transcript(env2, ["pr-description", "other-skill"]);
    const reason = reasonOf(await run(bashInput(t2, PR_CREATE), env2.deps));
    ok(reason.includes("other-skill"));
    ok(!reason.includes("pr-description"), reason);
    strictEqual(
      decisions(env2).filter((r) => r["kind"] === "passed").length,
      0,
    );
  });

  it("passes on a deadline of 0 ms and records the timeout once", async () => {
    const env = makeEnv();
    env.deps.scan = { deadlineMs: 0, chunkBytes: 2048 };
    const path = join(env.root, "t-long.jsonl");
    writeFileSync(
      path,
      `${["y".repeat(10_000), loadLine("pr-description")].join("\n")}\n`,
    );
    strictEqual(await run(bashInput(path, PR_CREATE), env.deps), null);
    const rows = decisions(env);
    strictEqual(rows.length, 1);
    strictEqual(rows[0]?.["kind"], "timeout");
    strictEqual(await run(bashInput(path, PR_CREATE), env.deps), null);
    strictEqual(decisions(env).length, 1);
  });

  it("keeps sessions independent", async () => {
    const env = makeEnv();
    const t = transcript(env, ["pr-description"]);
    reasonOf(await run(bashInput(t, PR_CREATE, { session_id: "a" }), env.deps));
    reasonOf(await run(bashInput(t, PR_CREATE, { session_id: "b" }), env.deps));
    strictEqual(
      await run(bashInput(t, PR_CREATE, { session_id: "a" }), env.deps),
      null,
    );
  });

  it("passes subagent calls", async () => {
    const env = makeEnv();
    const t = transcript(env, ["pr-description"]);
    strictEqual(
      await run(bashInput(t, PR_CREATE, { agent_id: "x" }), env.deps),
      null,
    );
  });

  it("passes for broken inputs and environments", async () => {
    const env = makeEnv();
    const t = transcript(env, ["pr-description"]);
    for (const input of [
      null,
      "text",
      [],
      bashInput(t, PR_CREATE, { session_id: "../x" }),
      bashInput(t, PR_CREATE, { session_id: 3 }),
      { ...bashInput(t, PR_CREATE), tool_input: undefined },
      { ...bashInput(t, PR_CREATE), tool_input: {} },
      bashInput(join(env.root, "missing.jsonl"), PR_CREATE),
      bashInput("relative.jsonl", PR_CREATE),
      { ...bashInput(t, PR_CREATE), hook_event_name: "PostToolUse" },
      { ...bashInput(t, PR_CREATE), tool_name: "Edit" },
    ]) {
      strictEqual(await run(input, env.deps), null);
    }
    strictEqual(
      await run(bashInput(t, PR_CREATE), {
        ...env.deps,
        skillsDir: join(env.root, "no-skills"),
      }),
      null,
    );
    // A state dir that cannot be created: fail open, no deny.
    const blocked = join(env.root, "blocked");
    writeFileSync(blocked, "file");
    strictEqual(
      await run(bashInput(t, PR_CREATE), {
        ...env.deps,
        stateDir: join(blocked, "sub"),
      }),
      null,
    );
  });

  it("skips broken, symlinked and late-frontmatter skills and keeps the others", async () => {
    const env = makeEnv();
    putSkill(env.skillsDir, "broken", "requires-skills: [a");
    mkdirSync(join(env.skillsDir, "linked"));
    writeFileSync(join(env.root, "real.md"), `---\n${PR_FM}\n---\n`);
    symlinkSync(
      join(env.root, "real.md"),
      join(env.skillsDir, "linked", "SKILL.md"),
    );
    mkdirSync(join(env.skillsDir, "late"));
    writeFileSync(
      join(env.skillsDir, "late", "SKILL.md"),
      `---\nname: late\n${"#".repeat(9000)}\n${PR_FM}\n---\n`,
    );
    const t = transcript(env, ["pr-description", "linked", "late", "broken"]);
    const reason = reasonOf(await run(bashInput(t, PR_CREATE), env.deps));
    ok(reason.includes("pr-description"));
    ok(!reason.includes("「linked」") && !reason.includes("「late」"));
  });
});

const spawnEnv = (env: Env) => ({
  PATH: process.env.PATH ?? "",
  HOME: env.root,
  SKILL_REQUIRES_GATE_STATE_DIR: env.stateDir,
});

describe("skill-requires-gate.ts as a process", () => {
  it("prints a deny through the real entrypoint", () => {
    const env = makeEnv(false);
    mkdirSync(join(env.root, ".claude", "skills"), { recursive: true });
    putSkill(join(env.root, ".claude", "skills"), "pr-description", PR_FM);
    const t = transcript(env, ["pr-description"]);
    const result = spawnSync("bun", [HOOK], {
      input: JSON.stringify(bashInput(t, PR_CREATE)),
      encoding: "utf8",
      env: spawnEnv(env),
    });
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes('"permissionDecision":"deny"'), result.stdout);
  });
});
