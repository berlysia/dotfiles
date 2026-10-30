// Checks home/dot_claude/.settings.permissions.json (not a hook). Lives here because the
// npm test glob covers home/dot_claude/hooks/tests/**; first settings-config test in the repo.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { test } from "node:test";

const repoRoot = join(import.meta.dirname, "../../../../..");
const settings = JSON.parse(
  readFileSync(
    join(repoRoot, "home/dot_claude/.settings.permissions.json"),
    "utf8",
  ),
) as { allow: string[]; ask: string[]; deny: string[] };

const requiredDeny = [
  "Bash(sudo:*)",
  "Bash(env sudo:*)",
  "Bash(command sudo:*)",
  "Bash(/usr/bin/sudo:*)",
  "Bash(pip:*)",
  "Bash(pip3:*)",
  "Bash(python -m pip:*)",
  "Bash(python3 -m pip:*)",
  "Bash(pipx:*)",
  "Bash(poetry:*)",
  "Read(~/.ssh/**)",
  "Read(~/.local/share/Trash/**)",
  "Read(//**/.Trash-*/**)",
  "Edit(//**/.git/commondir)",
  "Edit(//**/.git/info/attributes)",
  "Edit(//**/.git/worktrees/**)",
  "Edit(//**/.git/modules/**)",
  "Edit(//**/.git/worktree/*/.git)",
  "Edit(~/worktrees/**/.git)",
  "Edit(~/worktrees/*/.common-dir)",
];

const envReadRules = [
  "Read(//**/.env)",
  "Read(//**/.env.local)",
  "Read(//**/.env.*.local)",
  "Read(//**/.env.development)",
  "Read(//**/.env.dev)",
  "Read(//**/.env.production)",
  "Read(//**/.env.prod)",
  "Read(//**/.env.staging)",
  "Read(//**/.env.preview)",
  "Read(//**/.env.test)",
];

test("ask contains every .env Read rule", () => {
  const missing = envReadRules.filter((rule) => !settings.ask.includes(rule));
  assert.deepStrictEqual(missing, []);
});

// deny is evaluated before ask, so a rule left in deny would silently keep the hard block.
test("no .env Read rule remains in deny", () => {
  const leftover = settings.deny.filter((rule) => /^Read\(.*\.env/.test(rule));
  assert.deepStrictEqual(leftover, []);
});

test("deny contains every rule required by spec 制限", () => {
  const missing = requiredDeny.filter((rule) => !settings.deny.includes(rule));
  assert.deepStrictEqual(missing, []);
});

// Approximation via node's matchesGlob: "//" in a Claude Code rule means an absolute path, so
// drop one leading "/" and match against absolute sample paths. Not Claude Code's own matcher.
const absoluteReadGlobs = (rules: string[]) =>
  rules
    .map((rule) => /^Read\((.*)\)$/.exec(rule)?.[1])
    .filter(
      (glob): glob is string => glob !== undefined && glob.startsWith("//"),
    )
    .map((glob) => glob.slice(1));
const denyGlobs = absoluteReadGlobs(settings.deny);
const askGlobs = absoluteReadGlobs(settings.ask);
const editGlobs = (rules: string[]) =>
  rules
    .map((rule) => /^Edit\((.*)\)$/.exec(rule)?.[1])
    .filter((glob): glob is string => glob !== undefined)
    .map((glob) =>
      glob.startsWith("//")
        ? glob.slice(1)
        : glob.startsWith("~/")
          ? `/home/u/${glob.slice(2)}`
          : glob,
    );
const readGlobs = (rules: string[]) =>
  rules
    .map((rule) => /^Read\((.*)\)$/.exec(rule)?.[1])
    .filter((glob): glob is string => glob !== undefined)
    .map((glob) =>
      glob.startsWith("//")
        ? glob.slice(1)
        : glob.startsWith("~/")
          ? `/home/u/${glob.slice(2)}`
          : glob,
    );
const editAllowGlobs = editGlobs(settings.allow);
const editDenyGlobs = editGlobs(settings.deny);
const readAllowGlobs = readGlobs(settings.allow);
const readDenyGlobs = readGlobs(settings.deny);

test("no Read deny or ask matches .env.example or .env.sample", () => {
  const samples = [
    "/proj/.env.example",
    "/proj/.env.sample",
    "/a/b/.env.example",
  ];
  const blocking = [...denyGlobs, ...askGlobs].filter((glob) =>
    samples.some((p) => matchesGlob(p, glob)),
  );
  assert.deepStrictEqual(
    blocking,
    [],
    "spec keeps .env.example / .env.sample readable without a prompt",
  );
});

test("absolute-path Read asks match .env files outside the cwd", () => {
  const targets = ["/tmp/x/.env", "/home/u/proj/.env.production"];
  const unmatched = targets.filter(
    (p) => !askGlobs.some((glob) => matchesGlob(p, glob)),
  );
  assert.deepStrictEqual(unmatched, []);
});

test("absolute-path Read denies match the trash outside the cwd", () => {
  const targets = ["/mnt/x/.Trash-1000/f"];
  const unmatched = targets.filter(
    (p) => !denyGlobs.some((glob) => matchesGlob(p, glob)),
  );
  assert.deepStrictEqual(unmatched, []);
});

test("new-root worktree content is allowed and its gitfiles and marker are denied", () => {
  const source = "/home/u/worktrees/r/b/src/x";
  assert.equal(
    editAllowGlobs.some((glob) => matchesGlob(source, glob)),
    true,
  );
  assert.equal(
    editDenyGlobs.some((glob) => matchesGlob(source, glob)),
    false,
  );
  assert.equal(
    readAllowGlobs.some((glob) => matchesGlob(source, glob)),
    true,
  );
  assert.equal(
    readDenyGlobs.some((glob) => matchesGlob(source, glob)),
    false,
  );

  const protectedPaths = [
    "/home/u/worktrees/r/b/.git",
    "/home/u/worktrees/r/a/b/.git",
    "/home/u/worktrees/r/.common-dir",
  ];
  for (const path of protectedPaths) {
    assert.equal(
      editDenyGlobs.some((glob) => matchesGlob(path, glob)),
      true,
      path,
    );
  }
});

test("uv stays allowed (not denied)", () => {
  assert.equal(
    settings.deny.some((rule) => rule.startsWith("Bash(uv")),
    false,
  );
});
