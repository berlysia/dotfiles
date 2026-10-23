#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
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
import { prepareDenyInput } from "../../lib/deny-input.ts";
import {
  extractApmSkillNames,
  matchesDeclaration,
  parseSkillDeclaration,
  readDeclarations,
  scanLoadedSkills,
  type SkillDeclaration,
} from "../../lib/skill-requires.ts";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const FIXTURE = join(
  import.meta.dirname,
  "../fixtures/skill-load-transcript.jsonl",
);
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-requires-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const frontmatter = (body: string) => `---\nname: x\n${body}\n---\n\n# x\n`;

function parsed(text: string): SkillDeclaration {
  const result = parseSkillDeclaration("pr-description", text);
  if (!result.ok) throw new Error(result.reason);
  return result.declaration;
}

const loadLine = (name: string, body = "# body") =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `Base directory for this skill: /home/user/.claude/skills/${name}\n\n${body}`,
        },
      ],
    },
  });

function writeTranscript(lines: string[]): string {
  const path = join(tempDir(), "t.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("parseSkillDeclaration", () => {
  it("reads the one-line form", () => {
    const d = parsed(
      frontmatter(
        'requires-skills: [tanteki, koncise]\nrequires-skills-before: ["Bash(gh pr create)"]',
      ),
    );
    deepStrictEqual(d.requires, ["tanteki", "koncise"]);
    deepStrictEqual(d.before, [
      { kind: "bash", words: ["gh", "pr", "create"] },
    ]);
  });

  it("reads the multi-line form to the same result", () => {
    const d = parsed(
      frontmatter(
        'requires-skills:\n  - tanteki\n  - koncise\nrequires-skills-before:\n  - "Bash(gh pr create)"',
      ),
    );
    deepStrictEqual(d.requires, ["tanteki", "koncise"]);
    strictEqual(d.before.length, 1);
  });

  const bad: [string, string, RegExp][] = [
    ["one key only", frontmatter("requires-skills: [tanteki]"), /only one/],
    ["no frontmatter", "# x\n", /frontmatter/],
    [
      "unclosed frontmatter",
      '---\nrequires-skills: [a]\nrequires-skills-before: ["Bash(gh pr)"]\n',
      /frontmatter/,
    ],
    [
      "path-like name",
      frontmatter(
        'requires-skills: [../x]\nrequires-skills-before: ["Bash(gh pr)"]',
      ),
      /invalid skill name/,
    ],
    [
      "uppercase name",
      frontmatter(
        'requires-skills: [Tanteki]\nrequires-skills-before: ["Bash(gh pr)"]',
      ),
      /invalid skill name/,
    ],
    [
      "11 names",
      frontmatter(
        `requires-skills: [${Array.from({ length: 11 }, (_, i) => `s${i}`).join(", ")}]\nrequires-skills-before: ["Bash(gh pr)"]`,
      ),
      /more than 10/,
    ],
    [
      "one-word Bash pattern",
      frontmatter(
        'requires-skills: [a]\nrequires-skills-before: ["Bash(git)"]',
      ),
      /unreadable pattern/,
    ],
    [
      "6 patterns",
      frontmatter(
        `requires-skills: [a]\nrequires-skills-before: [${Array.from({ length: 6 }, (_, i) => `"Bash(gh p${i})"`).join(", ")}]`,
      ),
      /more than 5/,
    ],
  ];
  for (const [label, text, reason] of bad) {
    it(`returns no declaration for: ${label}`, () => {
      const result = parseSkillDeclaration("pr-description", text);
      strictEqual(result.ok, false);
      if (!result.ok) ok(reason.test(result.reason), result.reason);
    });
  }

  it("rejects a name with a newline", () => {
    const result = parseSkillDeclaration(
      "pr-description",
      '---\nrequires-skills: ["a\\nb"]\nrequires-skills-before: ["Bash(gh pr)"]\n---\n',
    );
    strictEqual(result.ok, false);
  });
});

describe("matchesDeclaration", () => {
  const decl = parsed(
    frontmatter(
      'requires-skills: [tanteki]\nrequires-skills-before: ["Bash(gh pr create)", "Write(**/*.html)"]',
    ),
  );
  const bash = async (command: string) =>
    matchesDeclaration(decl, {
      tool: "Bash",
      commands: (await prepareDenyInput(command)).individualCommands,
    });

  const cases: [string, boolean][] = [
    ["gh pr create --title x", true],
    ["cd /x && gh pr create", true],
    ["gh  pr  create", true],
    ["GH_TOKEN=x gh pr create", true],
    ["gh pr created", false],
    ["echo gh pr create", false],
    ["gh pr view 1", false],
    ['git commit -m "gh pr create"', false],
    ["git commit -m \"$(cat <<'EOF'\nfix\n\ngh pr create\nEOF\n)\"", false],
  ];
  for (const [command, expected] of cases) {
    it(`Bash ${JSON.stringify(command)} -> ${expected}`, async () => {
      strictEqual(await bash(command), expected);
    });
  }

  for (const [filePath, expected] of [
    ["/x/a.html", true],
    ["/x/sub/A.HTML", true],
    ["/x/a.md", false],
  ] as const) {
    it(`Write ${filePath} -> ${expected}`, () => {
      strictEqual(
        matchesDeclaration(decl, { tool: "Write", filePath }),
        expected,
      );
    });
  }
});

describe("scanLoadedSkills", () => {
  it("returns only the skill of the isMeta load record (fixture from a real transcript)", () => {
    const result = scanLoadedSkills(FIXTURE);
    deepStrictEqual([...result.loaded], ["pr-description"]);
  });

  it("skips broken lines, a cut first line, a missing file and a relative path", () => {
    const path = writeTranscript([
      `{"broken": Base directory for this skill: /x/y`,
      loadLine("tanteki"),
      "not json at all",
    ]);
    deepStrictEqual([...scanLoadedSkills(path).loaded], ["tanteki"]);
    deepStrictEqual([...scanLoadedSkills(join(tempDir(), "none")).loaded], []);
    deepStrictEqual([...scanLoadedSkills("relative/t.jsonl").loaded], []);
  });

  it("drops a first line cut by the scan range", () => {
    const first = loadLine("tanteki");
    const path = writeTranscript([first, loadLine("koncise")]);
    const size = readFileSync(path).length;
    // Range starts inside the first line: only the second is whole.
    const result = scanLoadedSkills(path, {
      maxScanBytes: size - Buffer.byteLength(first) + 5,
      chunkBytes: 32,
    });
    deepStrictEqual([...result.loaded], ["koncise"]);
  });

  it("finds a record whatever chunk boundary (including inside a multi-byte character) it straddles", () => {
    const record = loadLine("japanese-tech-writing", "日本語の本文".repeat(8));
    const path = writeTranscript(["a".repeat(50), record, "z".repeat(50)]);
    for (let chunkBytes = 7; chunkBytes < 400; chunkBytes += 1) {
      const result = scanLoadedSkills(path, { chunkBytes });
      ok(
        result.loaded.has("japanese-tech-writing"),
        `chunkBytes=${chunkBytes}`,
      );
    }
  });

  it("drops an over-long line and still finds records on both sides of it", () => {
    const path = writeTranscript([
      loadLine("tanteki"),
      "x".repeat(5000),
      loadLine("koncise"),
    ]);
    const result = scanLoadedSkills(path, {
      chunkBytes: 256,
      maxLineBytes: 1000,
    });
    deepStrictEqual([...result.loaded].sort(), ["koncise", "tanteki"]);
  });

  it("does not read earlier chunks once every needed name is found near the end", () => {
    const filler = Array.from({ length: 400 }, () => "y".repeat(100));
    const path = writeTranscript([...filler, loadLine("tanteki")]);
    const size = readFileSync(path).length;
    const result = scanLoadedSkills(path, {
      chunkBytes: 1024,
      needed: new Set(["tanteki"]),
    });
    ok(result.loaded.has("tanteki"));
    ok(result.bytesRead <= 1024, `read ${result.bytesRead} of ${size}`);
    strictEqual(result.timedOut, false);
  });

  it("reports a deadline stop after the first chunk", () => {
    const filler = Array.from({ length: 100 }, () => "y".repeat(100));
    const path = writeTranscript([loadLine("tanteki"), ...filler]);
    const result = scanLoadedSkills(path, {
      chunkBytes: 512,
      deadlineMs: 0,
      needed: new Set(["tanteki"]),
    });
    strictEqual(result.timedOut, true);
    strictEqual(result.bytesRead, 512);
  });
});

describe("readDeclarations", () => {
  it("reads a SKILL.md only from its first 8 KB and not through a symlink", () => {
    const skills = tempDir();
    const put = (name: string, text: string) => {
      mkdirSync(join(skills, name));
      writeFileSync(join(skills, name, "SKILL.md"), text);
    };
    const good = frontmatter(
      'requires-skills: [tanteki]\nrequires-skills-before: ["Bash(gh pr create)"]',
    );
    put("good", good);
    put("late", `---\nname: late\n${"#".repeat(9000)}\n---\n`);
    mkdirSync(join(skills, "linked"));
    const outside = join(tempDir(), "real.md");
    writeFileSync(outside, good);
    // SKILL.md as a symlink is not read.
    symlinkSync(outside, join(skills, "linked", "SKILL.md"));
    const result = readDeclarations(skills);
    deepStrictEqual(
      result.declarations.map((d) => d.skill),
      ["good"],
    );
  });
});

// --- repository declarations (K10) -------------------------------------------

interface CheckInput {
  skillsDir: string;
  apmText: string;
}

/** Returns the problems of every declaration under skillsDir; empty when none. */
function checkDeclarations({ skillsDir, apmText }: CheckInput): string[] {
  const problems: string[] = [];
  const known = new Set([
    ...readdirSync(skillsDir),
    ...extractApmSkillNames(apmText),
  ]);
  const { declarations, skipped } = readDeclarations(skillsDir);
  for (const { skill, reason } of skipped) {
    if (reason === "no declaration" || reason === "no closed frontmatter")
      continue;
    problems.push(`${skill}: ${reason}`);
  }
  for (const d of declarations) {
    for (const name of d.requires) {
      if (!known.has(name)) problems.push(`${d.skill}: unknown skill ${name}`);
    }
  }
  return problems;
}

describe("skill declarations in the repository", () => {
  const skillsDir = join(REPO_ROOT, ".skills");
  const apmText = readFileSync(join(REPO_ROOT, "home/dot_apm/apm.yml"), "utf8");

  it("satisfy the declaration rules", () => {
    deepStrictEqual(checkDeclarations({ skillsDir, apmText }), []);
  });

  it("are present for pr-description and visual-eli", () => {
    const names = readDeclarations(skillsDir).declarations.map((d) => d.skill);
    ok(names.includes("pr-description"));
    ok(names.includes("visual-eli"));
  });

  it("fails and names a skill that does not exist", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "demo"));
    writeFileSync(
      join(dir, "demo", "SKILL.md"),
      frontmatter(
        'requires-skills: [no-such-skill]\nrequires-skills-before: ["Bash(gh pr create)"]',
      ),
    );
    const problems = checkDeclarations({ skillsDir: dir, apmText });
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes("no-such-skill"));
  });

  it("extracts both apm.yml name forms", () => {
    const names = extractApmSkillNames(apmText);
    ok(names.has("stop-describing-ui"), "path form");
    ok(names.has("docx"), "list form");
  });

  it("has the directories the pr-description declaration names", () => {
    const dirsInSkills = readdirSync(skillsDir);
    for (const name of ["tanteki", "japanese-tech-writing", "koncise"]) {
      ok(dirsInSkills.includes(name), name);
    }
  });
});

describe(
  "hooks template registration",
  {
    skip:
      spawnSync("chezmoi", ["--version"]).status !== 0 &&
      "chezmoi is not on PATH",
  },
  () => {
    it("registers skill-requires-gate once under PreToolUse Bash|Write", () => {
      const tmpl = readFileSync(
        join(REPO_ROOT, "home/dot_claude/.settings.hooks.json.tmpl"),
        "utf8",
      );
      const prefix =
        '{{ $_ := set . "claude_hooks" (dict "auto_approval" true) }}{{ $_ := unset . "only_private" }}';
      const result = spawnSync(
        "chezmoi",
        ["execute-template", "--with-stdin"],
        {
          input: prefix + tmpl,
          encoding: "utf8",
        },
      );
      strictEqual(result.status, 0, result.stderr);
      const hooks = JSON.parse(result.stdout) as {
        PreToolUse: {
          matcher?: string;
          hooks: { command: string; timeout?: number }[];
        }[];
      };
      const hits = hooks.PreToolUse.filter((g) =>
        g.hooks.some((h) => h.command.includes("skill-requires-gate.ts")),
      );
      strictEqual(hits.length, 1);
      strictEqual(hits[0]?.matcher, "Bash|Write");
      strictEqual(hits[0]?.hooks[0]?.timeout, 5);
      ok(!hits[0]?.hooks[0]?.command.includes("run-guard"));
    });
  },
);
