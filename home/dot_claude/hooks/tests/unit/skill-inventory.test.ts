#!/usr/bin/env -S bun test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const SCRIPT = join(REPO_ROOT, "scripts/skill-inventory.sh");

interface Env {
  root: string;
  mdDir: string;
  md: string;
  selfDir: string;
  cmdDir: string;
  privDir: string;
  apmLock: string;
  ext: string;
  installed: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function makeEnv(rootName = "skill-inv-"): Env {
  const root = mkdtempSync(join(tmpdir(), rootName));
  const env: Env = {
    root,
    mdDir: join(root, "md"),
    md: join(root, "md", "skill-approvals.md"),
    selfDir: join(root, ".skills"),
    cmdDir: join(root, "commands"),
    privDir: join(root, "private-skills"),
    apmLock: join(root, "apm.lock.yaml"),
    ext: join(root, "external.toml.tmpl"),
    installed: join(root, "installed-skills"),
  };
  mkdirSync(env.mdDir);
  mkdirSync(env.selfDir);
  mkdirSync(env.cmdDir);
  mkdirSync(env.installed);
  return env;
}

function addSelf(env: Env, name: string, skillMd = "# skill\n"): void {
  mkdirSync(join(env.selfDir, name), { recursive: true });
  writeFileSync(join(env.selfDir, name, "SKILL.md"), skillMd);
}

function addCommand(env: Env, name: string, body = "# cmd\n"): void {
  writeFileSync(join(env.cmdDir, `${name}.md`), body);
}

function addPrivate(env: Env, name: string): void {
  mkdirSync(join(env.privDir, name), { recursive: true });
}

function addInstalled(env: Env, name: string, skillMd = "# skill\n"): void {
  mkdirSync(join(env.installed, name), { recursive: true });
  writeFileSync(join(env.installed, name, "SKILL.md"), skillMd);
}

function writeApm(env: Env, lines: string[]): void {
  writeFileSync(
    env.apmLock,
    [
      "lockfile_version: '1'",
      "dependencies:",
      "- repo_url: x",
      "  deployed_files:",
      ...lines,
      "",
    ].join("\n"),
  );
}

function apmLines(...names: string[]): string[] {
  return names.map((n) => `  - .claude/skills/${n}`);
}

function writeExternal(env: Env, names: string[]): void {
  writeFileSync(
    env.ext,
    names
      .map((n) => `[".claude/skills/${n}/SKILL.md"]\n  type = "file"\n`)
      .join("\n"),
  );
}

function writeMd(env: Env, content: string): void {
  writeFileSync(env.md, content);
}

function readMd(env: Env): string {
  return readFileSync(env.md, "utf8");
}

function baseArgs(env: Env): string[] {
  return [
    "--md",
    env.md,
    "--self-skills-dir",
    env.selfDir,
    "--commands-dir",
    env.cmdDir,
    "--private-dir",
    env.privDir,
    "--apm-lock",
    env.apmLock,
    "--chezmoi-external",
    env.ext,
    "--installed-skills-dir",
    env.installed,
  ];
}

function run(
  env: Env,
  sub: string,
  opts: { args?: string[]; env?: Record<string, string> } = {},
): RunResult {
  const r = spawnSync("bash", [SCRIPT, sub, ...(opts.args ?? baseArgs(env))], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function allow(
  env: Env,
  opts: { env?: Record<string, string> } = {},
): string[] {
  const r = run(env, "allow", opts);
  strictEqual(r.status, 0, `allow failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as string[];
}

function sync(env: Env): RunResult {
  return run(env, "sync-md");
}

describe("skill-inventory allow: functional", () => {
  it("allows a checked external", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext1"));
    writeMd(env, "- [x] ext1\n");
    deepStrictEqual(allow(env), ["ext1"]);
  });

  it("does not allow an unchecked self-made skill with a reason", () => {
    const env = makeEnv();
    addSelf(env, "self1");
    writeMd(env, "- [ ] self1 — 重い\n");
    deepStrictEqual(allow(env), []);
  });

  it("allows an unlisted self-made skill", () => {
    const env = makeEnv();
    addSelf(env, "self2");
    deepStrictEqual(allow(env), ["self2"]);
  });

  it("allows an unlisted command", () => {
    const env = makeEnv();
    addCommand(env, "cmd1");
    deepStrictEqual(allow(env), ["cmd1"]);
  });

  it("parses CRLF entry lines", () => {
    const env = makeEnv();
    addSelf(env, "self5");
    writeMd(env, "- [ ] self5\r\n");
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    deepStrictEqual(JSON.parse(r.stdout), []);
    ok(!r.stderr.includes("line"), r.stderr);
  });

  it("accepts [X] and CRLF [x]", () => {
    const env = makeEnv();
    writeMd(env, "- [X] ext2\n- [x] ext3\r\n");
    deepStrictEqual(allow(env), ["ext2", "ext3"]);
  });

  const malformed = [
    "- [ ] s-理由",
    "- [ ] s - 理由",
    "- [ ] s.",
    "- [ ] s—理由",
    "  - [ ] s",
    "* [ ] s",
    "-[ ] s",
    "- [] s",
    "- [ ]s",
    "- [x]  s",
    "- [x] s t",
  ];
  for (const line of malformed) {
    it(`treats malformed line as malformed: ${JSON.stringify(line)}`, () => {
      const env = makeEnv();
      addSelf(env, "s");
      addSelf(env, "t");
      writeMd(env, `# head\n${line}\n`);
      const r = run(env, "allow");
      strictEqual(r.status, 0);
      deepStrictEqual(JSON.parse(r.stdout), []);
      ok(/line 2\b/.test(r.stderr), r.stderr);
      const before = readMd(env);
      const s = sync(env);
      strictEqual(s.status, 0);
      strictEqual(readMd(env), before);
    });
  }

  it("treats empty reason and multiple dashes as entry lines", () => {
    const env = makeEnv();
    addSelf(env, "s");
    writeMd(env, "- [ ] s —\n- [x] u — 理由 — 続き\n");
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    deepStrictEqual(JSON.parse(r.stdout), ["u"]);
    ok(!r.stderr.includes("line"), r.stderr);
  });

  it("allows a checked name that has no source", () => {
    const env = makeEnv();
    writeMd(env, "- [x] ghost\n");
    deepStrictEqual(allow(env), ["ghost"]);
  });

  it("outputs sorted unique names", () => {
    const env = makeEnv();
    addSelf(env, "b");
    addSelf(env, "a");
    addCommand(env, "a");
    const r = run(env, "allow");
    strictEqual(r.stdout.trim(), '["a","b"]');
  });

  it("treats a self-made name that is also in the apm lock as external", () => {
    const env = makeEnv();
    addSelf(env, "dup");
    writeApm(env, apmLines("dup"));
    deepStrictEqual(allow(env), []);
    const s = sync(env);
    strictEqual(s.status, 0);
    const md = readMd(env);
    ok(md.indexOf("## External") < md.indexOf("- [ ] dup"), md);
    ok(!md.includes("- [x] dup"), md);
  });

  it("allows private names and keeps them out of md even when self-made shares the name", () => {
    const env = makeEnv();
    addSelf(env, "shared");
    addPrivate(env, "shared");
    addPrivate(env, "p1");
    deepStrictEqual(allow(env), ["p1", "shared"]);
    const s = sync(env);
    strictEqual(s.status, 0);
    ok(!readMd(env).includes("shared"), readMd(env));
    ok(!readMd(env).includes("p1"), readMd(env));
    ok(!s.stdout.includes("p1"), s.stdout);
  });

  it("creates md with header and sections when absent", () => {
    const env = makeEnv();
    addSelf(env, "a");
    writeApm(env, apmLines("b"));
    const s = sync(env);
    strictEqual(s.status, 0, s.stderr);
    strictEqual(
      readMd(env),
      [
        "# Skill auto-approve checklist",
        "",
        "`[x]` の行は `Skill(<name>)` として settings.json の permissions.allow に入る（次回の chezmoi apply で反映）。",
        "未チェックにする理由は `— ` の後に書く。自作スキルは md に載る前から許可される。",
        "private-skills 由来はここに載せず、常に許可される。",
        "apply は未掲載のスキルを追記するだけで、行を消さない。",
        "",
        "## Self-made",
        "",
        "- [x] a",
        "",
        "## External",
        "",
        "- [ ] b",
        "",
      ].join("\n"),
    );
    ok(s.stdout.includes("2 件"), s.stdout);
    ok(s.stdout.includes("a, b"), s.stdout);
    // The generated md must itself be clean for allow.
    const r = run(env, "allow");
    deepStrictEqual(JSON.parse(r.stdout), ["a"]);
    ok(!r.stderr.includes("line"), r.stderr);
  });

  it("keeps checked and private allowed when malformed lines exist but suspends unlisted self-made", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext7"));
    addPrivate(env, "p2");
    addSelf(env, "t");
    writeMd(env, "- [ ] s-x\n- [x] ext7\n");
    // `s-x` is a valid name here, so make it malformed explicitly.
    writeMd(env, "- [ ] s-x—bad\n- [x] ext7\n");
    deepStrictEqual(allow(env), ["ext7", "p2"]);
  });

  it("emits no malformed warning for a clean md", () => {
    const env = makeEnv();
    writeMd(env, "- [x] a\n- [ ] b — 理由\n");
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    ok(!r.stderr.includes("line"), r.stderr);
    ok(!r.stderr.includes("malformed"), r.stderr);
  });

  it("does not flag links, fenced content, or mid-line [x]", () => {
    const env = makeEnv();
    addSelf(env, "t");
    writeMd(
      env,
      [
        "- [リンク](https://example.com)",
        "```",
        "- [ ] fenced",
        "- [ ] s-x—",
        "```",
        "~~~",
        "- [ ] tilde",
        "~~~",
        "  ```",
        "  - [ ] indented",
        "  ```",
        "説明: 行に [x] を付けると許可される",
        "",
      ].join("\n"),
    );
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    deepStrictEqual(JSON.parse(r.stdout), ["t"]);
    ok(!r.stderr.includes("line"), r.stderr);
  });

  it("does not treat fenced names as listed", () => {
    const env = makeEnv();
    addSelf(env, "fenced");
    writeMd(env, "```\n- [ ] fenced\n```\n");
    deepStrictEqual(allow(env), ["fenced"]);
  });

  it("flags an unclosed fence at the opening line and suspends unlisted self-made", () => {
    const env = makeEnv();
    addSelf(env, "t");
    writeMd(env, "intro\n```\n- [ ] x\n");
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    deepStrictEqual(JSON.parse(r.stdout), []);
    ok(/line 2\b/.test(r.stderr), r.stderr);
  });

  it("flags a line starting with [x] as malformed", () => {
    const env = makeEnv();
    writeMd(env, "[x] を付けると許可される\n");
    const r = run(env, "allow");
    ok(/line 1\b/.test(r.stderr), r.stderr);
  });

  it("sync-md leaves existing lines byte-identical and appends at section ends", () => {
    const env = makeEnv();
    addSelf(env, "newself");
    writeApm(env, apmLines("newext", "oldext"));
    const original = [
      "# Title",
      "",
      "free text  with trailing spaces  ",
      "",
      "## Self-made",
      "",
      "- [x] oldself",
      "- [ ] gone — インストールされていない",
      "",
      "## External",
      "",
      "- [ ] oldext — 理由",
      "",
      "## Notes",
      "",
      "memo",
      "",
    ].join("\n");
    writeMd(env, original);
    const s = sync(env);
    strictEqual(s.status, 0, s.stderr);
    strictEqual(
      readMd(env),
      [
        "# Title",
        "",
        "free text  with trailing spaces  ",
        "",
        "## Self-made",
        "",
        "- [x] oldself",
        "- [ ] gone — インストールされていない",
        "- [x] newself",
        "",
        "## External",
        "",
        "- [ ] oldext — 理由",
        "- [ ] newext",
        "",
        "## Notes",
        "",
        "memo",
        "",
      ].join("\n"),
    );
  });

  it("is idempotent", () => {
    const env = makeEnv();
    addSelf(env, "a");
    writeApm(env, apmLines("b"));
    sync(env);
    const first = readMd(env);
    const s2 = sync(env);
    strictEqual(s2.status, 0);
    strictEqual(readMd(env), first);
    ok(!s2.stdout.includes("追記"), s2.stdout);
  });

  it("adds a newline when the md lacks a trailing newline", () => {
    const env = makeEnv();
    addSelf(env, "a");
    writeMd(env, "## Self-made\n\n- [x] old");
    const s = sync(env);
    strictEqual(s.status, 0);
    strictEqual(readMd(env), "## Self-made\n\n- [x] old\n- [x] a\n");
  });

  it("creates missing sections at the end of an existing md", () => {
    const env = makeEnv();
    writeApm(env, apmLines("b"));
    writeMd(env, "# Mine\n");
    const s = sync(env);
    strictEqual(s.status, 0);
    strictEqual(readMd(env), "# Mine\n\n## External\n\n- [ ] b\n");
  });

  it("annotates allowed-tools for a self-made skill without changing the check", () => {
    const env = makeEnv();
    addSelf(env, "at1", "---\nname: at1\nallowed-tools: Bash(*)\n---\nbody\n");
    deepStrictEqual(allow(env), ["at1"]);
    sync(env);
    ok(
      readMd(env).includes("- [x] at1 — allowed-tools: Bash(*)\n"),
      readMd(env),
    );
  });

  it("joins list-form allowed-tools for a command", () => {
    const env = makeEnv();
    addCommand(
      env,
      "c1",
      "---\ndescription: x\nallowed-tools:\n  - Read\n  - Bash(git *)\n---\nbody\n",
    );
    sync(env);
    ok(
      readMd(env).includes("- [x] c1 — allowed-tools: Read, Bash(git *)\n"),
      readMd(env),
    );
  });

  it("ignores allowed-tools outside frontmatter", () => {
    const env = makeEnv();
    addSelf(env, "body1", "---\nname: body1\n---\nallowed-tools: X\n");
    sync(env);
    ok(readMd(env).includes("- [x] body1\n"), readMd(env));
    ok(!readMd(env).includes("allowed-tools"), readMd(env));
  });

  it("annotates unknown for unclosed frontmatter", () => {
    const env = makeEnv();
    addSelf(env, "open1", "---\nname: open1\nbody\n");
    sync(env);
    ok(
      readMd(env).includes("- [x] open1 — allowed-tools: unknown\n"),
      readMd(env),
    );
  });

  it("warns when a checked external's allowed-tools changed, without rewriting md", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext4"));
    addInstalled(env, "ext4", "---\nallowed-tools: Bash(*)\n---\n");
    writeMd(env, "- [x] ext4\n");
    const s = sync(env);
    strictEqual(s.status, 0);
    ok(s.stderr.includes("ext4"), s.stderr);
    ok(s.stderr.includes("Bash(*)"), s.stderr);
    strictEqual(readMd(env), "- [x] ext4\n");
  });
});

describe("skill-inventory: security", () => {
  it("treats an injection-shaped entry as malformed", () => {
    const env = makeEnv();
    writeMd(env, '- [x] a"),Bash(*\n');
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    const names = JSON.parse(r.stdout) as string[];
    for (const n of names) ok(!/["),*]/.test(n), n);
    ok(/line 1\b/.test(r.stderr), r.stderr);
  });

  it("only allows the name part when a reason contains injection text", () => {
    const env = makeEnv();
    writeMd(env, '- [x] ok — a"),Bash(*\n');
    deepStrictEqual(allow(env), ["ok"]);
  });

  it("drops invalid directory names without printing them", () => {
    const env = makeEnv();
    const bad = ['foo"bar', "-n", ".hidden", "has space"];
    for (const n of bad) {
      addSelf(env, n);
      addPrivate(env, n);
    }
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    deepStrictEqual(JSON.parse(r.stdout), []);
    ok(/invalid/i.test(r.stderr), r.stderr);
    for (const n of ["foo", "bar", "hidden", "space"]) {
      ok(!r.stderr.includes(n), `stderr leaks ${n}: ${r.stderr}`);
    }
    const s = sync(env);
    strictEqual(s.status, 0);
    const md = readMd(env);
    for (const n of ["foo", "hidden", "space"]) ok(!md.includes(n), md);
    ok(!/^- \[.\] -n/m.test(md), md);
  });

  it("never lists an installed-only name when private-dir is missing", () => {
    const env = makeEnv();
    addInstalled(env, "pv1");
    const s = sync(env);
    strictEqual(s.status, 0);
    ok(!readMd(env).includes("pv1"), readMd(env));
  });

  it("sanitizes a long control-character allowed-tools value", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext5"));
    const value = `Bash(a)\t\x01\x07${"x".repeat(200)}\x7f`;
    addInstalled(env, "ext5", `---\nallowed-tools: ${value}\r\n---\n`);
    // ext5 unlisted -> appended as unchecked external with annotation
    const s = sync(env);
    strictEqual(s.status, 0, s.stderr);
    const lines = readMd(env)
      .split("\n")
      .filter((l) => l.includes("ext5"));
    strictEqual(lines.length, 1);
    const line = lines[0] ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence
    ok(!/[\x00-\x1f\x7f]/.test(line), JSON.stringify(line));
    const value2 = line.split("allowed-tools: ")[1] ?? "";
    ok(value2.length > 0 && value2.length <= 80, `${value2.length}`);
  });

  it("does not let an allowed-tools value forge an entry line", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext6"));
    addInstalled(env, "ext6", "---\nallowed-tools:\n- [x] evil\n---\n");
    const s = sync(env);
    strictEqual(s.status, 0);
    ok(!/^- \[x\] evil/m.test(readMd(env)), readMd(env));
    ok(!/^evil/m.test(readMd(env)), readMd(env));
    deepStrictEqual(allow(env).includes("evil"), false);
  });
});

describe("skill-inventory: reliability", () => {
  it("handles an empty md with missing optional sources", () => {
    const env = makeEnv();
    addSelf(env, "only");
    writeMd(env, "");
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    deepStrictEqual(JSON.parse(r.stdout), ["only"]);
  });

  it("handles a missing md for allow and creates one for sync-md", () => {
    const env = makeEnv();
    addSelf(env, "a");
    addPrivate(env, "p");
    deepStrictEqual(allow(env), ["a", "p"]);
    strictEqual(sync(env).status, 0);
    ok(readMd(env).startsWith("# Skill auto-approve checklist\n"));
  });

  it("returns [] when the apm lock has no skill lines and dirs are empty", () => {
    const env = makeEnv();
    writeApm(env, []);
    mkdirSync(env.privDir);
    const r = run(env, "allow");
    strictEqual(r.status, 0);
    strictEqual(r.stdout.trim(), "[]");
  });

  it("gives the same result under LC_ALL=C and a UTF-8 locale", () => {
    const env = makeEnv();
    addSelf(env, "self5");
    addSelf(env, "t");
    writeMd(env, "- [ ] self5\r\n- [X] ext2\n- [x] ok — 理由\n- [ ] s—理由\n");
    const a = run(env, "allow", { env: { LC_ALL: "C" } });
    const b = run(env, "allow", { env: { LC_ALL: "C.UTF-8" } });
    strictEqual(a.status, 0);
    strictEqual(a.stdout, b.stdout);
    deepStrictEqual(JSON.parse(a.stdout), ["ext2", "ok"]);
  });

  it("fails with a usage message on missing arguments", () => {
    const env = makeEnv();
    const r = run(env, "allow", { args: ["--md", env.md] });
    ok(r.status !== 0);
    ok(/usage/i.test(r.stderr), r.stderr);
    const r2 = run(env, "sync-md", { args: [] });
    ok(r2.status !== 0);
    ok(/usage/i.test(r2.stderr), r2.stderr);
  });

  it("fails with a usage message on an unknown subcommand", () => {
    const env = makeEnv();
    const r = run(env, "bogus");
    ok(r.status !== 0);
    ok(/usage/i.test(r.stderr), r.stderr);
  });

  it("works with spaces in paths", () => {
    const env = makeEnv("skill inv ");
    const spaced = join(env.root, "x y");
    mkdirSync(spaced);
    const selfDir = join(spaced, ".skills");
    mkdirSync(join(selfDir, "sp"), { recursive: true });
    writeFileSync(join(selfDir, "sp", "SKILL.md"), "# s\n");
    const md = join(spaced, "skill approvals.md");
    const args = baseArgs(env);
    args[args.indexOf("--md") + 1] = md;
    args[args.indexOf("--self-skills-dir") + 1] = selfDir;
    const r = run(env, "allow", { args });
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(JSON.parse(r.stdout), ["sp"]);
    const s = run(env, "sync-md", { args });
    strictEqual(s.status, 0, s.stderr);
    ok(readFileSync(md, "utf8").includes("- [x] sp\n"));
  });

  it("keeps a 4-backtick fence open across a 3-backtick line", () => {
    const env = makeEnv();
    addSelf(env, "inner");
    writeMd(env, "````\n```\n- [ ] inner\n````\n");
    const r = run(env, "allow");
    deepStrictEqual(JSON.parse(r.stdout), ["inner"]);
    ok(!r.stderr.includes("line"), r.stderr);
  });

  it("does not close a backtick fence with ~~~", () => {
    const env = makeEnv();
    addSelf(env, "after");
    writeMd(env, "```\n~~~\n- [ ] after\n```\n");
    const r = run(env, "allow");
    deepStrictEqual(JSON.parse(r.stdout), ["after"]);
    ok(!r.stderr.includes("line"), r.stderr);
  });

  it("does not close a fence on a line with an info string or 4-space indent", () => {
    const env = makeEnv();
    addSelf(env, "t");
    writeMd(env, "```\n    ```\n```js\n");
    const r = run(env, "allow");
    deepStrictEqual(JSON.parse(r.stdout), []);
    ok(/line 1\b/.test(r.stderr), r.stderr);
  });

  it("does not open a fence on a 4-space-indented fence marker", () => {
    const env = makeEnv();
    writeMd(env, "    ```\n- [ ] s-x—\n");
    const r = run(env, "allow");
    ok(/line 2\b/.test(r.stderr), r.stderr);
  });

  it("rejects names with a trailing dot or leading dash from dirs", () => {
    const env = makeEnv();
    for (const n of ["s.", "-a"]) {
      addSelf(env, n);
      addPrivate(env, n);
    }
    deepStrictEqual(allow(env), []);
    sync(env);
    const md = readMd(env);
    ok(!/^- \[.\] s\./m.test(md), md);
    ok(!/^- \[.\] -a/m.test(md), md);
  });

  it("creates no temp file when malformed lines exist", () => {
    const env = makeEnv();
    addSelf(env, "t");
    writeMd(env, "- [ ] s-x—bad\n");
    const s = sync(env);
    strictEqual(s.status, 0);
    deepStrictEqual(readdirSync(env.mdDir), ["skill-approvals.md"]);
  });

  it("fails when --apm-lock is a directory", () => {
    const env = makeEnv();
    mkdirSync(env.apmLock);
    ok(run(env, "allow").status !== 0);
    ok(run(env, "sync-md").status !== 0);
  });

  it("exits 0 and leaves md untouched with malformed lines and an unlisted external", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext9"));
    writeMd(env, "- [ ] s-x—bad\n");
    const s = sync(env);
    strictEqual(s.status, 0);
    strictEqual(readMd(env), "- [ ] s-x—bad\n");
    ok(/line 1\b/.test(s.stderr), s.stderr);
  });

  it("fails without leaving a temp file when md dir is read-only", (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root bypasses directory permissions");
      return;
    }
    const env = makeEnv();
    addSelf(env, "a");
    const before = "# keep\n";
    writeMd(env, before);
    chmodSync(env.mdDir, 0o555);
    try {
      const s = sync(env);
      ok(s.status !== 0);
      strictEqual(readMd(env), before);
      deepStrictEqual(readdirSync(env.mdDir), ["skill-approvals.md"]);
    } finally {
      chmodSync(env.mdDir, 0o755);
    }
  });
});

describe("skill-inventory: maintainability", () => {
  it("reports every malformed line number", () => {
    const env = makeEnv();
    writeMd(env, "a\nb\n- [ ] s-x—1\nc\nd\ne\n* [ ] y\n");
    const r = run(env, "allow");
    ok(/line 3\b/.test(r.stderr), r.stderr);
    ok(/line 7\b/.test(r.stderr), r.stderr);
  });
});

describe("skill-inventory: extra boundaries", () => {
  it("ignores an apm lock line with an invalid name", () => {
    const env = makeEnv();
    writeApm(env, ['  - .claude/skills/foo"bar', ...apmLines("good")]);
    const s = sync(env);
    strictEqual(s.status, 0);
    ok(!readMd(env).includes("foo"), readMd(env));
    ok(readMd(env).includes("- [ ] good"), readMd(env));
  });

  it("reads allowed-tools after a UTF-8 BOM", () => {
    const env = makeEnv();
    addSelf(env, "bom", "﻿---\nallowed-tools: Read\n---\n");
    sync(env);
    ok(readMd(env).includes("- [x] bom — allowed-tools: Read\n"), readMd(env));
  });

  it("matches the key case-insensitively and with underscores or quotes", () => {
    const env = makeEnv();
    addSelf(env, "k1", "---\nAllowed-Tools: Read\n---\n");
    addSelf(env, "k2", "---\nallowed_tools: Read\n---\n");
    addSelf(env, "k3", '---\n"allowed-tools": Read\n---\n');
    sync(env);
    const md = readMd(env);
    ok(md.includes("- [x] k1 — allowed-tools: Read\n"), md);
    ok(md.includes("- [x] k2 — allowed-tools: Read\n"), md);
    ok(md.includes("- [x] k3 — allowed-tools: Read\n"), md);
  });

  it("handles CRLF frontmatter", () => {
    const env = makeEnv();
    addSelf(env, "crlf", "---\r\nallowed-tools: Read\r\n---\r\nbody\r\n");
    sync(env);
    ok(readMd(env).includes("- [x] crlf — allowed-tools: Read\n"), readMd(env));
  });

  it("keeps U+2028 and U+0085 out of the annotation and the warning", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext10", "ext11"));
    addInstalled(env, "ext10", "---\nallowed-tools: A B\u0085C\n---\n");
    addInstalled(env, "ext11", "---\nallowed-tools: A B\u0085C\n---\n");
    writeMd(env, "- [x] ext11\n");
    const s = sync(env);
    strictEqual(s.status, 0);
    const md = readMd(env);
    ok(!md.includes(" ") && !md.includes("\u0085"), JSON.stringify(md));
    ok(
      !s.stderr.includes(" ") && !s.stderr.includes("\u0085"),
      JSON.stringify(s.stderr),
    );
    ok(md.includes("- [ ] ext10 — allowed-tools: ABC\n"), md);
    // md is unchanged except for the appended ext10 line? ext11 already listed.
    ok(md.startsWith("- [x] ext11\n"), md);
  });

  it("warns only when the current allowed-tools differs from the annotation", () => {
    const env = makeEnv();
    writeApm(env, apmLines("ext8"));
    addInstalled(env, "ext8", "---\nallowed-tools: Read\n---\n");
    writeMd(env, "- [x] ext8 — allowed-tools: Read\n");
    const same = sync(env);
    strictEqual(same.status, 0);
    ok(!same.stderr.includes("ext8"), same.stderr);

    addInstalled(env, "ext8", "---\nallowed-tools: Bash(*)\n---\n");
    const changed = sync(env);
    strictEqual(changed.status, 0);
    ok(changed.stderr.includes("ext8"), changed.stderr);
    strictEqual(readMd(env), "- [x] ext8 — allowed-tools: Read\n");
  });
});
