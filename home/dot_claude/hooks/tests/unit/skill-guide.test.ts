#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isSafeSessionId } from "../../lib/session-id.ts";
import {
  SKILL_GUIDE_LOG_MAX_BYTES,
  SKILL_GUIDE_MARKER_TTL_MS,
  SKILL_GUIDE_SKILLS,
  acquireGuideGateSlot,
  appendGuideDecision,
  createGuideMarker,
  evaluateSkillGuide,
  guideMarkerName,
  readGuideDecisions,
  readSkillGuides,
  recordGuideDecisionOnce,
  recordPassedRead,
  resolveSkillGuidePaths,
  scanSkillReads,
  skillReadStatus,
  type DecisionLogFileOps,
  type SkillGuideDecisionInput,
} from "../../lib/skill-guide.ts";
import { readMarker } from "../../lib/session-marker.ts";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const dirs: string[] = [];
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skill-guide-")));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const frontmatter = (body: string) => `---\n${body}\n---\n\n# Guide\n`;

function putSkill(skillsRoot: string, skill: string, body: string): void {
  mkdirSync(join(skillsRoot, skill), { recursive: true });
  writeFileSync(join(skillsRoot, skill, "SKILL.md"), frontmatter(body));
}

function transcript(root: string, lines: string[]): string {
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return path;
}

function skillLoadLine(baseDirectory: string): string {
  return JSON.stringify({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `Base directory for this skill: ${baseDirectory}\n\n# guide`,
        },
      ],
    },
  });
}

function readToolLine(filePath: string): string {
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

function guideEnv(
  body = 'read-before: ["Bash(git commit)"]',
  skill = "commit-standards",
) {
  const root = tempDir();
  const skillsRoot = join(root, "skills");
  const stateDir = join(root, "home", ".claude", "state", "skill-guide");
  mkdirSync(skillsRoot);
  putSkill(skillsRoot, skill, body);
  const transcriptPath = transcript(root, []);
  return {
    root,
    skillsRoot,
    stateDir,
    transcriptPath,
    deps: { skillsRoot, stateDir },
  };
}

function markerKey(stateDir: string, target = "commit-standards") {
  return {
    stateDir,
    sessionId: "session-1",
    target,
  };
}

function decision(
  kind: SkillGuideDecisionInput["kind"] = "deny",
  sessionId = "session-1",
): SkillGuideDecisionInput {
  return {
    sessionId,
    words: ["git", "commit"],
    skills: ["commit-standards"],
    kind,
  };
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

describe("T3: 宣言の読み取り", () => {
  it("reads read-before independently and recognizes repository skills", () => {
    const env = guideEnv();
    deepStrictEqual(readSkillGuides(env.skillsRoot), [
      {
        skill: "commit-standards",
        before: [{ raw: "Bash(git commit)", words: ["git", "commit"] }],
      },
    ]);
    ok(
      existsSync(join(REPO_ROOT, ".skills", "git-safety", "SKILL.md")),
      "the existing trusted repository skill is present",
    );
    deepStrictEqual(SKILL_GUIDE_SKILLS, [
      "commit-standards",
      "git-safety",
      "model-offloading",
    ]);
  });

  it("accepts the allowlisted one-word command", () => {
    const env = guideEnv('read-before: ["Bash(git-worktree-create)"]');
    deepStrictEqual(readSkillGuides(env.skillsRoot)[0]?.before[0]?.words, [
      "git-worktree-create",
    ]);
  });

  it("skips an unallowlisted one-word command", () => {
    const env = guideEnv('read-before: ["Bash(git)"]');
    deepStrictEqual(readSkillGuides(env.skillsRoot), []);
  });

  it("does not require requires-skills to read read-before", () => {
    const env = guideEnv(
      'requires-skills: [tanteki]\nread-before: ["Bash(git commit)"]',
    );
    deepStrictEqual(
      readSkillGuides(env.skillsRoot).map((guide) => guide.skill),
      ["commit-standards"],
    );
  });

  it("does not infer read-before from requires-skills", () => {
    const env = guideEnv("requires-skills: [tanteki]");
    deepStrictEqual(readSkillGuides(env.skillsRoot), []);
  });

  it("skips third-party declarations and names containing a newline", () => {
    const env = guideEnv();
    putSkill(env.skillsRoot, "third-party", 'read-before: ["Bash(git push)"]');
    putSkill(env.skillsRoot, "bad\nname", 'read-before: ["Bash(git push)"]');
    deepStrictEqual(
      readSkillGuides(env.skillsRoot).map((guide) => guide.skill),
      ["commit-standards"],
    );
  });
});

describe("T3: 目印の上限と名前", () => {
  it("creates only two gate slots for one key", () => {
    const root = tempDir();
    const stateDir = join(root, "state");
    const key = { ...markerKey(stateDir), content: "git commit" };
    strictEqual(acquireGuideGateSlot(key).attempt, 1);
    strictEqual(acquireGuideGateSlot(key).attempt, 2);
    strictEqual(acquireGuideGateSlot(key).status, "exhausted");
    strictEqual(statSync(stateDir).mode & 0o777, 0o700);
  });

  it("creates exactly two slots under eight parallel acquisitions", async () => {
    const stateDir = join(tempDir(), "state");
    const key = { ...markerKey(stateDir), content: "git commit" };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve(acquireGuideGateSlot(key)),
      ),
    );
    strictEqual(
      results.filter((result) => result.status === "created").length,
      2,
    );
    strictEqual(
      results.filter((result) => result.status === "failed").length,
      0,
    );
  });

  it("uses safe, distinct names for every marker suffix", () => {
    const suffixes = ["_1", "_2", "_m", "_a", "_i", "_r"] as const;
    const kinds = [
      "gate",
      "gate",
      "missing",
      "after",
      "ignored",
      "read",
    ] as const;
    const names = suffixes.map((suffix, index) =>
      guideMarkerName(
        kinds[index] ?? "gate",
        "session-1",
        "agent/../x",
        "skill",
        suffix,
      ),
    );
    strictEqual(new Set(names).size, names.length);
    for (const name of names) ok(isSafeSessionId(name), name);
  });

  it("sweeps markers older than one day while creating a new marker", () => {
    const stateDir = join(tempDir(), "state");
    mkdirSync(stateDir);
    const stale = join(stateDir, "stale_1");
    writeFileSync(stale, "old");
    const old = new Date(Date.now() - SKILL_GUIDE_MARKER_TTL_MS - 1000);
    utimesSync(stale, old, old);
    strictEqual(
      createGuideMarker({
        ...markerKey(stateDir),
        kind: "after",
        target: "debugging",
      }),
      true,
    );
    strictEqual(existsSync(stale), false);
  });

  it("hashes an unsafe agent id into a marker name inside the state directory", () => {
    const root = tempDir();
    const stateDir = join(root, "state");
    const result = acquireGuideGateSlot({
      ...markerKey(stateDir),
      agentId: "../x",
      content: "git commit",
    });
    strictEqual(result.status, "created");
    deepStrictEqual(readdirSync(root), ["state"]);
    strictEqual(readdirSync(stateDir).length, 1);
  });

  it("keeps skill-requires and skill-guide state directories independent", () => {
    const root = tempDir();
    const gateDir = join(root, "skill-requires-gate");
    const guideDir = join(root, "skill-guide");
    const key = { sessionId: "session-1", target: "commit-standards" };
    strictEqual(
      acquireGuideGateSlot({ ...key, stateDir: gateDir, content: "git commit" })
        .attempt,
      1,
    );
    strictEqual(
      acquireGuideGateSlot({
        ...key,
        stateDir: guideDir,
        content: "git commit",
      }).attempt,
      1,
    );
    strictEqual(readdirSync(gateDir).length, 1);
    strictEqual(readdirSync(guideDir).length, 1);
  });
});

describe("T3: transcript の読取判定", () => {
  it("counts an assistant Read tool_use for the exact distributed SKILL.md", () => {
    const env = guideEnv();
    const path = transcript(env.root, [
      readToolLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
    ]);
    const result = scanSkillReads(path, env.skillsRoot, ["commit-standards"]);
    strictEqual(skillReadStatus(result, "commit-standards").status, "read");
  });

  it("rejects another directory, user text, and a tool_result mention", () => {
    const env = guideEnv();
    const target = join(env.skillsRoot, "commit-standards", "SKILL.md");
    const result = scanSkillReads(
      transcript(env.root, [
        readToolLine("/tmp/x/.claude/skills/commit-standards/SKILL.md"),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_result", content: target }],
          },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: target }] },
        }),
      ]),
      env.skillsRoot,
      ["commit-standards"],
    );
    strictEqual(skillReadStatus(result, "commit-standards").status, "unread");
  });

  it("does not count a Read of another skill", () => {
    const env = guideEnv();
    putSkill(
      env.skillsRoot,
      "git-safety",
      'read-before: ["Bash(git worktree add)"]',
    );
    const result = scanSkillReads(
      transcript(env.root, [
        readToolLine(join(env.skillsRoot, "git-safety", "SKILL.md")),
      ]),
      env.skillsRoot,
      ["commit-standards"],
    );
    strictEqual(skillReadStatus(result, "commit-standards").status, "unread");
  });

  it("returns undetermined when a bounded scan times out before the read line", () => {
    const env = guideEnv();
    const path = transcript(env.root, [
      readToolLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
      "filler".repeat(100),
    ]);
    const result = scanSkillReads(path, env.skillsRoot, ["commit-standards"], {
      chunkBytes: 64,
      deadlineMs: 0,
    });
    strictEqual(
      skillReadStatus(result, "commit-standards").status,
      "undetermined",
    );
    strictEqual(skillReadStatus(result, "commit-standards").kind, "timeout");
  });

  it("does not count a Skill load from a different installation path", () => {
    const env = guideEnv();
    const result = scanSkillReads(
      transcript(env.root, [
        skillLoadLine("/tmp/other/.claude/skills/commit-standards"),
      ]),
      env.skillsRoot,
      ["commit-standards"],
    );
    strictEqual(skillReadStatus(result, "commit-standards").status, "unread");
  });

  it("matches a Skill load through a symlinked skills root", () => {
    const env = guideEnv();
    const link = join(env.root, "skills-link");
    symlinkSync(env.skillsRoot, link, "dir");
    const result = scanSkillReads(
      transcript(env.root, [
        skillLoadLine(join(env.skillsRoot, "commit-standards")),
      ]),
      link,
      ["commit-standards"],
    );
    strictEqual(skillReadStatus(result, "commit-standards").status, "read");
  });

  it("matches a Read path through a symlinked skills root", () => {
    const env = guideEnv();
    const link = join(env.root, "skills-link");
    symlinkSync(env.skillsRoot, link, "dir");
    const result = scanSkillReads(
      transcript(env.root, [
        readToolLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
      ]),
      link,
      ["commit-standards"],
    );
    strictEqual(skillReadStatus(result, "commit-standards").status, "read");
  });

  it("returns no-transcript when transcript_path is absent", () => {
    const env = guideEnv();
    strictEqual(
      skillReadStatus(
        scanSkillReads(undefined, env.skillsRoot, ["commit-standards"]),
        "commit-standards",
      ).kind,
      "no-transcript",
    );
  });
});

describe("T3: 判定・記録", () => {
  it("denies without writing the raw command or session id", () => {
    const env = guideEnv();
    const result = evaluateSkillGuide(
      {
        sessionId: "private-session-123",
        transcriptPath: env.transcriptPath,
        commands: ['git commit -m "secret-token"'],
      },
      env.deps,
    );
    strictEqual(result.status, "deny");
    const stored = readdirSync(env.stateDir)
      .map((name) => readFileSync(join(env.stateDir, name), "utf8"))
      .join("\n");
    ok(!stored.includes("secret-token"));
    ok(!stored.includes("private-session-123"));
    const rows = readGuideDecisions(env.stateDir);
    strictEqual(rows.length, 1);
    deepStrictEqual(rows[0]?.skill, ["commit-standards"]);
    strictEqual(rows[0]?.kind, "deny");
    strictEqual(rows[0]?.agent, "main");
  });

  it("preserves the first operation in _1 when another operation is denied", () => {
    const env = guideEnv(
      'read-before: ["Bash(codex exec)", "Bash(delegation offload)"]',
      "model-offloading",
    );
    for (const command of [
      "codex exec -m m p",
      "delegation offload --brief-file /tmp/b",
    ]) {
      strictEqual(
        evaluateSkillGuide(
          {
            sessionId: "session-1",
            transcriptPath: env.transcriptPath,
            commands: [command],
          },
          env.deps,
        ).status,
        "deny",
      );
    }
    const first = guideMarkerName(
      "gate",
      "session-1",
      undefined,
      "model-offloading",
      "_1",
    );
    strictEqual(readMarker(env.stateDir, first), "codex exec");
    strictEqual(
      readGuideDecisions(env.stateDir).filter((row) => row.kind === "deny")
        .length,
      2,
    );
  });

  it("logs one passed-read row with the first deny's words", () => {
    const env = guideEnv();
    const key = { ...markerKey(env.stateDir), content: "git commit" };
    strictEqual(acquireGuideGateSlot(key).status, "created");
    const readTranscript = transcript(env.root, [
      readToolLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
    ]);
    const read = scanSkillReads(readTranscript, env.skillsRoot, [
      "commit-standards",
    ]);
    strictEqual(skillReadStatus(read, "commit-standards").status, "read");
    strictEqual(recordPassedRead(env.stateDir, markerKey(env.stateDir)), true);
    strictEqual(recordPassedRead(env.stateDir, markerKey(env.stateDir)), false);
    const rows = readGuideDecisions(env.stateDir).filter(
      (row) => row.kind === "passed-read",
    );
    strictEqual(rows.length, 1);
    deepStrictEqual(rows[0]?.words, ["git", "commit"]);
  });

  it("records ignored and missing only once per key", () => {
    const stateDir = join(tempDir(), "state");
    const ignored = {
      sessionId: "session-1",
      words: ["git", "commit"],
      skills: ["commit-standards"],
      kind: "ignored" as const,
    };
    strictEqual(recordGuideDecisionOnce(stateDir, ignored), true);
    strictEqual(recordGuideDecisionOnce(stateDir, ignored), false);
    const missing = { ...ignored, kind: "missing" as const };
    strictEqual(recordGuideDecisionOnce(stateDir, missing), true);
    strictEqual(recordGuideDecisionOnce(stateDir, missing), false);
    deepStrictEqual(
      readGuideDecisions(stateDir)
        .map((row) => row.kind)
        .sort(),
      ["ignored", "missing"],
    );
  });

  it("returns undetermined for a missing transcript without consuming a marker", () => {
    const env = guideEnv();
    const result = evaluateSkillGuide(
      { sessionId: "session-1", commands: ["git commit"] },
      env.deps,
    );
    strictEqual(result.status, "undetermined");
    strictEqual(existsSync(env.stateDir), false);
    ok(eventLogText().includes("[skill-guide] no-transcript"));
  });

  it("falls back to pass-through for an unsafe session id", () => {
    const env = guideEnv();
    const result = evaluateSkillGuide(
      {
        sessionId: "../unsafe",
        transcriptPath: env.transcriptPath,
        commands: ["git commit"],
      },
      env.deps,
    );
    strictEqual(result.status, "undetermined");
    strictEqual(existsSync(env.stateDir), false);
    ok(eventLogText().includes("[skill-guide] unsafe-session"));
  });

  it("falls back when the state directory cannot be created", () => {
    const env = guideEnv();
    const fileParent = join(env.root, "state-parent");
    writeFileSync(fileParent, "file");
    const result = evaluateSkillGuide(
      {
        sessionId: "session-1",
        transcriptPath: env.transcriptPath,
        commands: ["git commit"],
      },
      { ...env.deps, stateDir: join(fileParent, "state") },
    );
    strictEqual(result.status, "allow");
    strictEqual(existsSync(join(fileParent, "state")), false);
    ok(eventLogText().includes("[skill-guide] marker-failed"));
  });

  it("logs timeout when bounded scanning cannot settle the read state", () => {
    const env = guideEnv();
    const path = transcript(env.root, [
      readToolLine(join(env.skillsRoot, "commit-standards", "SKILL.md")),
      "filler".repeat(100),
    ]);
    const result = evaluateSkillGuide(
      {
        sessionId: "session-1",
        transcriptPath: path,
        commands: ["git commit"],
      },
      {
        ...env.deps,
        scan: { chunkBytes: 64, deadlineMs: 0 },
      },
    );
    strictEqual(result.status, "undetermined");
    strictEqual(existsSync(env.stateDir), false);
    ok(eventLogText().includes("[skill-guide] timeout"));
  });

  it("rotates a log larger than one megabyte and appends to the current file", () => {
    const stateDir = join(tempDir(), "state");
    mkdirSync(stateDir);
    writeFileSync(
      join(stateDir, "decisions.jsonl"),
      "x".repeat(SKILL_GUIDE_LOG_MAX_BYTES + 1),
    );
    strictEqual(appendGuideDecision(stateDir, decision()), true);
    const names = readdirSync(stateDir);
    strictEqual(names.includes("decisions.jsonl"), true);
    ok(names.some((name) => /^decisions\..+-1\.jsonl$/.test(name)));
    strictEqual(readGuideDecisions(stateDir).length, 1);
    strictEqual(
      statSync(join(stateDir, "decisions.jsonl")).mode & 0o777,
      0o600,
    );
  });

  it("advances the archive sequence without changing an existing destination", () => {
    const stateDir = join(tempDir(), "state");
    mkdirSync(stateDir);
    const at = new Date("2026-10-30T12:34:56.789Z");
    const timestamp = at.toISOString().replace(/[:.]/g, "-");
    const existing = join(stateDir, `decisions.${timestamp}-1.jsonl`);
    writeFileSync(existing, "keep me");
    writeFileSync(
      join(stateDir, "decisions.jsonl"),
      "x".repeat(SKILL_GUIDE_LOG_MAX_BYTES + 1),
    );
    strictEqual(
      appendGuideDecision(stateDir, decision(), { now: () => at }),
      true,
    );
    strictEqual(readFileSync(existing, "utf8"), "keep me");
    ok(readdirSync(stateDir).includes(`decisions.${timestamp}-2.jsonl`));
  });

  it("stops after unlink failure and deduplicates the remaining hard link", () => {
    const stateDir = join(tempDir(), "state");
    mkdirSync(stateDir);
    const logPath = join(stateDir, "decisions.jsonl");
    strictEqual(appendGuideDecision(stateDir, decision()), true);
    writeFileSync(
      logPath,
      `${readFileSync(logPath, "utf8")}${"x".repeat(SKILL_GUIDE_LOG_MAX_BYTES + 1)}`,
    );
    const fileOps: Partial<DecisionLogFileOps> = {
      unlinkSync: () => {
        throw new Error("injected unlink failure");
      },
    };
    strictEqual(
      appendGuideDecision(stateDir, decision("ignored"), { fileOps }),
      false,
    );
    const archive = readdirSync(stateDir).find(
      (name) => name !== "decisions.jsonl",
    );
    ok(archive);
    const liveStat = statSync(logPath);
    const archiveStat = statSync(join(stateDir, archive));
    strictEqual(liveStat.dev, archiveStat.dev);
    strictEqual(liveStat.ino, archiveStat.ino);
    strictEqual(readGuideDecisions(stateDir).length, 1);
    ok(eventLogText().includes("[skill-guide] decision-log-failed"));
  });

  it("appends eight concurrent rows as valid JSONL", async () => {
    const stateDir = join(tempDir(), "state");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Promise.resolve(
          appendGuideDecision(stateDir, {
            ...decision(),
            words: ["git", "commit", String(index)],
          }),
        ),
      ),
    );
    strictEqual(results.every(Boolean), true);
    const lines = readFileSync(join(stateDir, "decisions.jsonl"), "utf8")
      .trim()
      .split("\n");
    strictEqual(lines.length, 8);
    for (const line of lines) ok(JSON.parse(line));
  });
});

describe("T3: argv と HOME", () => {
  it("uses default paths when an override is relative", () => {
    const home = tempDir();
    deepStrictEqual(
      resolveSkillGuidePaths(["--skills-root", "relative/skills"], home),
      {
        skillsRoot: join(home, ".claude", "skills"),
        stateDir: join(home, ".claude", "state", "skill-guide"),
      },
    );
  });

  it("resolves defaults from the isolated HOME", () => {
    const home = tempDir();
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      deepStrictEqual(
        resolveSkillGuidePaths(["--skills-root", "relative/skills"]),
        {
          skillsRoot: join(home, ".claude", "skills"),
          stateDir: join(home, ".claude", "state", "skill-guide"),
        },
      );
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
  });

  it("accepts only absolute path overrides", () => {
    const home = tempDir();
    deepStrictEqual(
      resolveSkillGuidePaths(
        ["--skills-root", "/tmp/skills", "--state-dir", "/tmp/state"],
        home,
      ),
      { skillsRoot: "/tmp/skills", stateDir: "/tmp/state" },
    );
  });
});
