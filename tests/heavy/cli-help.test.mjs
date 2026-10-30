// Process test: every own command under home/dot_local/bin and the doctor
// wrapper answers --help / -h with usage on stdout, exit 0, and does nothing
// else. The command set comes from a glob so a new command without a row here
// (and so without a checked --help) fails the suite.
//
// Why a fake HOME: the bun wrappers start code under ${HOME}; symlinking the
// source into a temp HOME runs the source itself, not what chezmoi deployed.
// Why stubs + before/after listings: a --help that falls through to real work
// (systemctl, VM start, ledger append) must be seen, not just hoped away.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN_SRC = join(REPO, "home/dot_local/bin");
const STUB_DIR = join(REPO, "tests/fixtures/cli-help-stubs");
const LAUNCH_TIMEOUT_MS = 10_000;
const DELIVERY_POLICY_CLI = join(
  REPO,
  "home/dot_claude/hooks/cli/delivery-policy.ts",
);

// ---- Mapping table (the one place to edit when a command is added) --------
// key:      unique row id. globName: the name the glob yields (defaults to key).
// from:     "bin" = fake ~/.local/bin/<globName>, "shell" = fake ~/.shell_common/executable_doctor,
//           or an explicit argv array (run as is).
// expect:   name the help text must contain. word: usage word (case-insensitive).
// subs:     extra words the help must list (commands with subcommands).
// exclude:  reason string => not launched (still counted against the glob).
// pending:  reason string => row kept and skipped until it is enabled.
const AI_USAGE = { expect: "ai-usage" };
const ROWS = [
  { key: "agent-learnings", expect: "agent-learnings" },
  { key: "agent-vm", expect: "agent-vm", subs: ["prewarm", "sync"] },
  { key: "agent-vm-node-modules", expect: "agent-vm-node-modules" },
  { key: "ai-usage", expect: "ai-usage" },
  { key: "ask-grokbot", expect: "ask-grokbot" },
  { key: "claude-rc-launch", expect: "claude-rc-launch" },
  { key: "claude-rc-sync", expect: "claude-rc-sync" },
  { key: "claude-sessions", expect: "claude-sessions" },
  { key: "claude-task-list-id", expect: "claude-task-list-id" },
  { key: "claude-usage", ...AI_USAGE },
  {
    key: "claude-zai.tmpl",
    exclude:
      "chezmoi template rendered only on only_private machines; rendering needs chezmoi execute-template and the result depends on machine config (help is at tmpl:28-55)",
  },
  { key: "codex-usage", ...AI_USAGE },
  { key: "cursor-usage", ...AI_USAGE },
  { key: "delegation", expect: "delegation", subs: ["route", "record"] },
  {
    key: "delivery-policy",
    exclude:
      "the wrapper takes HOME from passwd and runs the deployed code, so it cannot exercise the source",
  },
  {
    key: "delivery-policy-cli",
    globName: "delivery-policy",
    from: ["bun", "run", DELIVERY_POLICY_CLI],
    expect: "delivery-policy",
  },
  { key: "dotfiles-feedback", expect: "dotfiles-feedback", word: "使い方" },
  { key: "dotfiles-sync-doctor", expect: "dotfiles-sync-doctor" },
  { key: "doctor", from: "shell", expect: "Test Suite" },
  { key: "gemini-polish", expect: "gemini-polish" },
  { key: "git-worktree-cleanup", expect: "git-worktree-cleanup" },
  { key: "git-worktree-create", expect: "git-worktree-create" },
  { key: "git-worktree-deps", expect: "git-worktree-deps" },
  { key: "hook-timing", expect: "hook-timing" },
  { key: "opencode-usage", ...AI_USAGE },
  { key: "tailnet-ssh.mts", expect: "tailnet-ssh" },
  { key: "textlint-global", expect: "textlint-global" },
  { key: "workflow-band-preview", expect: "workflow-band-preview" },
  { key: "workflow-cli", expect: "workflow-cli", subs: ["round", "stamp"] },
];
const AGENT_VM_SUBS = [
  ["shell"],
  ["prewarm"],
  ["golden"],
  ["golden", "refresh"],
  ["golden", "rm"],
  ["list"],
  ["gc"],
  ["rm"],
  ["sync"],
  ["node-modules-sync"],
  ["restore-git"],
  ["accept-git"],
  ["fetch-browsers"],
  ["env"],
  ["env", "edit"],
  ["env", "adopt"],
  ["env", "gh"],
];
const DELEGATION_SUBS = [
  "route",
  "review",
  "open",
  "bind",
  "close",
  "record",
  "amend",
  "lapse",
];
const WORKFLOW_SUBS = [
  "status",
  "dir",
  "round",
  "stamp",
  "triage",
  "ask-approval",
  "reset",
];
// Side effects only; the help wording is not judged here.
const PROBES = [
  ...[
    "show",
    "path",
    "add",
    "remove",
    "feedback",
    "status",
    "init",
    "tag",
    "promote",
    "rekey",
  ].map((sub) => ["agent-learnings", [sub, "--help"]]),
  ["ai-usage", ["claude", "--help"]],
  ...["send", "flush", "status", "drop"].map((sub) => [
    "dotfiles-feedback",
    [sub, "--help"],
  ]),
  ["claude-rc-sync", ["status", "--help"]],
  ["claude-rc-sync", ["restart", "--help"]],
  ["git-worktree-cleanup", ["probe-branch", "--help"]],
  ["git-worktree-create", ["probe-branch", "--help"]],
  ["git-worktree-deps", ["probe-dir", "--help"]],
];
const STUB_NAMES = [
  "systemctl",
  "orb",
  "claude",
  "codex",
  "gh",
  "op",
  "tailscale",
  "ssh",
];

// ---- Table / glob matcher --------------------------------------------------
export function findTableMismatches(globNames, tableGlobNames) {
  const glob = new Set(globNames);
  const table = new Set(tableGlobNames);
  return {
    missingFromTable: [...glob].filter((n) => !table.has(n)).sort(),
    missingFromGlob: [...table].filter((n) => !glob.has(n)).sort(),
  };
}
export function assertTableMatchesGlob(globNames, tableGlobNames) {
  const { missingFromTable, missingFromGlob } = findTableMismatches(
    globNames,
    tableGlobNames,
  );
  const problems = [
    ...missingFromTable.map(
      (n) =>
        `command "${n}" exists in the source but has no row in the cli-help table`,
    ),
    ...missingFromGlob.map(
      (n) => `table row "${n}" has no matching command in the source`,
    ),
  ];
  assert.equal(problems.length, 0, problems.join("\n"));
}

function globCommandNames() {
  const bins = readdirSync(BIN_SRC)
    .filter((f) => f.startsWith("executable_"))
    .map((f) => f.slice("executable_".length));
  return [...bins, "doctor"];
}
const globName = (row) => row.globName ?? row.key;

// ---- Harness ---------------------------------------------------------------
let tmpRoot;
let fakeHome;
let cwdRepo;
let markerDir;

function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out.push(`L ${path}`);
      else if (st.isDirectory()) {
        out.push(`D ${path}`);
        walk(path);
      } else out.push(`F ${path} ${st.size}`);
    }
  };
  walk(root);
  return out;
}
function gitStatus() {
  return spawnSync("git", ["status", "--porcelain"], {
    cwd: cwdRepo,
    encoding: "utf8",
  }).stdout;
}
function markers() {
  return readdirSync(markerDir).sort();
}
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(k) || k.startsWith("XDG_") || k.startsWith("GIT_"))
      continue;
    env[k] = v;
  }
  env.HOME = fakeHome;
  env.PATH = [STUB_DIR, join(fakeHome, ".local/bin"), process.env.PATH].join(
    ":",
  );
  env.EDITOR = join(STUB_DIR, "editor");
  env.VISUAL = join(STUB_DIR, "editor");
  env.STUB_MARKER_DIR = markerDir;
  // bun writes its transpiler cache under $HOME/.bun by default. That is bun's
  // own bookkeeping, not the command's effect, so keep it out of the listing.
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(tmpRoot, "bun-cache");
  return env;
}
function link(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
}

before(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cli-help-")));
  fakeHome = join(tmpRoot, "home");
  cwdRepo = join(tmpRoot, "repo");
  markerDir = join(tmpRoot, "markers");
  mkdirSync(fakeHome);
  mkdirSync(cwdRepo);
  mkdirSync(markerDir);
  spawnSync("git", ["init", "-q"], { cwd: cwdRepo });
  link(join(REPO, "home/dot_claude/hooks"), join(fakeHome, ".claude/hooks"));
  link(
    join(REPO, "home/dot_local/share/ai-usage"),
    join(fakeHome, ".local/share/ai-usage"),
  );
  link(
    join(REPO, "home/dot_local/share/delegation"),
    join(fakeHome, ".local/share/delegation"),
  );
  link(
    join(REPO, "mods/workflow-band"),
    join(fakeHome, ".claude/mods/workflow-band"),
  );
  link(join(REPO, "home/dot_shell_common"), join(fakeHome, ".shell_common"));
  // git-worktree-create and -cleanup source ../lib/worktree-location.sh, deployed to ~/.local/lib.
  link(join(REPO, "home/dot_local/lib"), join(fakeHome, ".local/lib"));
  for (const f of readdirSync(BIN_SRC)) {
    if (!f.startsWith("executable_")) continue;
    const name = f.slice("executable_".length);
    if (name === "claude-zai.tmpl") continue;
    // Copied, not linked: chezmoi's executable_ prefix sets the mode on deploy,
    // but some sources are 0644 in git, so a link would fail with EACCES.
    const dest = join(fakeHome, ".local/bin", name);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(BIN_SRC, f), dest);
    chmodSync(dest, 0o755);
  }
});
after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function commandFor(row) {
  if (Array.isArray(row.from)) return row.from;
  if (row.from === "shell")
    return [join(fakeHome, ".shell_common/executable_doctor")];
  return [join(fakeHome, ".local/bin", globName(row))];
}

// Runs one launch and returns the outcome plus every observed side effect.
function launch(row, args) {
  const argv = commandFor(row);
  const homeBefore = listTree(fakeHome);
  const gitBefore = gitStatus();
  const res = spawnSync(argv[0], [...argv.slice(1), ...args], {
    cwd: cwdRepo,
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: LAUNCH_TIMEOUT_MS,
  });
  const homeAfter = listTree(fakeHome);
  const gitAfter = gitStatus();
  const stubMarkers = markers();
  for (const m of stubMarkers) rmSync(join(markerDir, m), { force: true });
  const sideEffects = [];
  if (stubMarkers.length)
    sideEffects.push(`stub called: ${stubMarkers.join(", ")}`);
  const added = homeAfter.filter((e) => !homeBefore.includes(e));
  const removed = homeBefore.filter((e) => !homeAfter.includes(e));
  if (added.length || removed.length)
    sideEffects.push(
      `fake HOME changed: +${JSON.stringify(added)} -${JSON.stringify(removed)}`,
    );
  if (gitAfter !== gitBefore)
    sideEffects.push(`cwd repo status changed: ${JSON.stringify(gitAfter)}`);
  return {
    status: res.status,
    signal: res.signal,
    timedOut: res.error?.code === "ETIMEDOUT",
    error: res.error,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    sideEffects,
  };
}

function describeRun(label, r) {
  return `${label}: status=${r.status} signal=${r.signal} timedOut=${r.timedOut}\n  stdout=${JSON.stringify(r.stdout.slice(0, 300))}\n  stderr=${JSON.stringify(r.stderr.slice(0, 300))}\n  sideEffects=${JSON.stringify(r.sideEffects)}`;
}

function assertHelp(label, row, r) {
  const desc = describeRun(label, r);
  assert.equal(r.timedOut, false, `timed out: ${desc}`);
  assert.equal(r.error, undefined, `spawn error: ${desc}`);
  assert.equal(r.status, 0, `exit status: ${desc}`);
  const word = row.word ?? "usage";
  assert.ok(
    r.stdout.toLowerCase().includes(word.toLowerCase()),
    `stdout lacks "${word}": ${desc}`,
  );
  assert.ok(
    r.stdout.includes(row.expect),
    `stdout lacks "${row.expect}": ${desc}`,
  );
  for (const sub of row.subs ?? [])
    assert.ok(
      r.stdout.includes(sub),
      `stdout lacks subcommand "${sub}": ${desc}`,
    );
  assert.equal(r.stderr, "", `stderr not empty: ${desc}`);
  assert.deepEqual(r.sideEffects, [], `side effects: ${desc}`);
}
function assertNoSideEffects(label, r) {
  const desc = describeRun(label, r);
  assert.equal(r.timedOut, false, `timed out: ${desc}`);
  assert.deepEqual(r.sideEffects, [], `side effects: ${desc}`);
}

const rowByKey = (key) => ROWS.find((r) => r.key === key);

// ---- Cases -----------------------------------------------------------------
test("every command in the source has a table row and vice versa", () => {
  assertTableMatchesGlob(globCommandNames(), ROWS.map(globName));
});

test("matcher names a command that is missing from the table or from the glob", () => {
  assert.throws(
    () => assertTableMatchesGlob(["a", "dummy-new"], ["a"]),
    /"dummy-new"/,
  );
  assert.throws(
    () => assertTableMatchesGlob(["a"], ["a", "dummy-gone"]),
    /"dummy-gone"/,
  );
  assert.doesNotThrow(() =>
    assertTableMatchesGlob(["a", "b"], ["b", "a", "a"]),
  );
});

for (const row of ROWS) {
  for (const flag of ["--help", "-h"]) {
    const title = `${row.key} ${flag} prints usage and does nothing else`;
    if (row.exclude) continue;
    test(title, { skip: row.pending }, () => {
      assertHelp(`${row.key} ${flag}`, row, launch(row, [flag]));
    });
  }
}
test("excluded rows carry a reason", () => {
  for (const row of ROWS.filter((r) => r.exclude))
    assert.ok(row.exclude.length > 20, row.key);
});

for (const sub of AGENT_VM_SUBS) {
  const row = rowByKey("agent-vm");
  test(`agent-vm ${sub.join(" ")} --help prints usage and does nothing else`, () => {
    assertHelp(
      `agent-vm ${sub.join(" ")} --help`,
      row,
      launch(row, [...sub, "--help"]),
    );
  });
}
for (const sub of DELEGATION_SUBS) {
  const row = rowByKey("delegation");
  test(`delegation ${sub} --help prints usage and does nothing else`, () => {
    assertHelp(`delegation ${sub} --help`, row, launch(row, [sub, "--help"]));
  });
}
test("delegation review --since 7 --help prints usage and does nothing else", () => {
  const row = rowByKey("delegation");
  assertHelp(
    "delegation review --since 7 --help",
    row,
    launch(row, ["review", "--since", "7", "--help"]),
  );
});
for (const sub of WORKFLOW_SUBS) {
  const row = rowByKey("workflow-cli");
  test(`workflow-cli ${sub} --help prints usage and does nothing else`, () => {
    assertHelp(`workflow-cli ${sub} --help`, row, launch(row, [sub, "--help"]));
  });
}
test("workflow-cli round plan.md --help prints usage and does nothing else", () => {
  const row = rowByKey("workflow-cli");
  assertHelp(
    "workflow-cli round plan.md --help",
    row,
    launch(row, ["round", "plan.md", "--help"]),
  );
});

test("workflow-cli stamp plan.md --verdict --help treats --help as the value, not as help", () => {
  const r = launch(rowByKey("workflow-cli"), [
    "stamp",
    "plan.md",
    "--verdict",
    "--help",
  ]);
  const desc = describeRun("workflow-cli stamp plan.md --verdict --help", r);
  assert.equal(r.timedOut, false, desc);
  assert.notEqual(r.status, 0, desc);
  assert.doesNotMatch(r.stdout, /usage/i, desc);
});
test("agent-vm fetch-browsers --from-apply --help treats --help as the value, not as help", () => {
  const r = launch(rowByKey("agent-vm"), [
    "fetch-browsers",
    "--from-apply",
    "--help",
  ]);
  const desc = describeRun("agent-vm fetch-browsers --from-apply --help", r);
  assert.equal(r.timedOut, false, desc);
  assert.notEqual(r.status, 0, desc);
  assert.ok(
    !r.stdout.includes(
      "agent-vm - run claude/codex in a per-repo OrbStack isolated machine",
    ),
    desc,
  );
});

for (const [key, args] of PROBES) {
  test(`probe: ${key} ${args.join(" ")} has no side effects`, () => {
    assertNoSideEffects(
      `${key} ${args.join(" ")}`,
      launch(rowByKey(key), args),
    );
  });
}

test("stub directory holds every stub the harness relies on", () => {
  const present = readdirSync(STUB_DIR);
  for (const n of [...STUB_NAMES, "editor"]) assert.ok(present.includes(n), n);
});
