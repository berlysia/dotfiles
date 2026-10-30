import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createWorktree, findMountsUnder } from "../../lib/claude-worktree.ts";
import {
  handleWorktreeCleanup,
  handleWorktreeCreate,
} from "../../lib/claude-worktree-handlers.ts";
import type { Deps } from "../../lib/claude-worktree-git.ts";
import {
  GIT_FAILURE,
  createRepo,
  createTempTracker,
  git,
  interceptGit,
} from "../support/claude-worktree-fixture.ts";
import type { Repo } from "../support/claude-worktree-fixture.ts";
import { currentRoot } from "../../lib/worktree-locations.ts";

const temp = createTempTracker();
// The hook runs git-worktree-deps and agent-vm-node-modules from HOME and PATH, and reads the VM marker from the
// environment, so none of them may be the developer's.
const savedEnv: Record<string, string | undefined> = {};
const testHome = temp.make("cwh-home-");
const fakeBin = temp.make("cwh-bin-");
const gitDir = dirname(
  execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
);
const vmMarker = join(testHome, "vm-marker");
for (const [name, value] of Object.entries({
  HOME: testHome,
  PATH: [fakeBin, gitDir, "/usr/bin", "/bin"].join(":"),
  AGENT_VM_MARKER: join(testHome, "no-such-marker"),
  XDG_CONFIG_HOME: join(testHome, ".config"),
  XDG_DATA_HOME: join(testHome, ".local", "share"),
  XDG_STATE_HOME: join(testHome, ".local", "state"),
  XDG_CACHE_HOME: join(testHome, ".cache"),
})) {
  savedEnv[name] = process.env[name];
  process.env[name] = value;
}
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  temp.cleanup();
});

// A stand-in for ~/.local/bin/git-worktree-deps that records its arguments, then runs `body`.
const cliPath = join(testHome, ".local", "bin", "git-worktree-deps");
const cliLog = join(testHome, "deps-calls.log");
const helperLog = join(testHome, "helper-calls.log");
function writeScript(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
}
function installCli(body = ""): void {
  rmSync(cliLog, { force: true });
  writeScript(
    cliPath,
    `printf '%s\\n' "$*" >> "$HOME/deps-calls.log"\n${body}`,
  );
}
function readLog(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}
const helperPath = join(fakeBin, "agent-vm-node-modules");
// `remove <wt> -- <command...>`: records, then runs the command like the real helper does after detaching.
function installHelper(body?: string): void {
  rmSync(helperLog, { force: true });
  writeScript(
    helperPath,
    `printf '%s\\n' "$*" >> "$HOME/helper-calls.log"\n${body ?? 'shift 3\nexec "$@"'}`,
  );
}
beforeEach(() => {
  installCli();
  rmSync(helperPath, { force: true });
  rmSync(vmMarker, { force: true });
  process.env.AGENT_VM_MARKER = join(testHome, "no-such-marker");
});
afterEach(() => {
  process.env.AGENT_VM_MARKER = join(testHome, "no-such-marker");
});
function enterVm(): void {
  writeFileSync(vmMarker, "");
  process.env.AGENT_VM_MARKER = vmMarker;
}
function processState(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}
function isRunning(pid: number): boolean {
  const state = processState(pid);
  return state !== "" && !state.startsWith("Z");
}
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const throwingDeps: Deps = {
  runGit: () => {
    throw new Error("injected exception");
  },
  now: Date.now,
};

function createInput(repo: Repo, name: string): string {
  return JSON.stringify({
    hook_event_name: "WorktreeCreate",
    name,
    cwd: repo.dir,
  });
}

function removeInput(repo: Repo, worktreePath: unknown): string {
  return JSON.stringify({
    hook_event_name: "WorktreeRemove",
    worktree_path: worktreePath,
    cwd: repo.dir,
  });
}

function stopInput(repo: Repo, agentId: unknown): string {
  return JSON.stringify({
    hook_event_name: "SubagentStop",
    agent_id: agentId,
    cwd: repo.dir,
  });
}

function makeWorktree(repo: Repo, name: string): string {
  const result = createWorktree({ name, cwd: repo.dir });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.path;
}

// Everything the handlers must strip: C0 except "\n", and DEL.
function hasControlChars(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && code !== 0x0a) || code === 0x7f;
  });
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.trimEnd().split("\n").length;
}

describe("handleWorktreeCreate", () => {
  it("C53: valid input prints the path on one stdout line and exits 0", () => {
    const repo = createRepo(temp, { origin: true });
    const result = handleWorktreeCreate(createInput(repo, "bold-oak-a3f2"));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      result.stdout,
      `${join(currentRoot(repo.commonDir, testHome), "worktree-bold-oak-a3f2")}\n`,
    );
    assert.equal(result.stderr, "");
  });

  it("C53: unusable input leaves stdout empty and exits 1", () => {
    const repo = createRepo(temp);
    const inputs: [string, string][] = [
      ["broken JSON", "{not json"],
      ["empty stdin", ""],
      ["null", "null"],
      ["array", "[]"],
      ["string", '"x"'],
      ["number", "42"],
      ["name is an array", JSON.stringify({ name: ["a"], cwd: repo.dir })],
      ["name missing", JSON.stringify({ cwd: repo.dir })],
      ["cwd missing", JSON.stringify({ name: "ok-name" })],
      ["core refuses the name", createInput(repo, "a/b")],
    ];
    for (const [label, input] of inputs) {
      const result = handleWorktreeCreate(input);
      assert.equal(result.stdout, "", label);
      assert.equal(result.exitCode, 1, label);
      assert.notEqual(result.stderr, "", label);
    }
    assert.equal(git(repo.dir, "branch", "--list", "worktree-*"), "");
  });

  it("C53b: a warning goes to stderr and stdout stays the path alone", () => {
    const repo = createRepo(temp);
    const result = handleWorktreeCreate(createInput(repo, "warned"));
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.stdout,
      `${join(currentRoot(repo.commonDir, testHome), "worktree-warned")}\n`,
    );
    assert.match(result.stderr, /origin\/HEAD not found/);
  });

  it("C53: an exception inside the core exits 1 with stdout empty", () => {
    const repo = createRepo(temp);
    const result = handleWorktreeCreate(
      createInput(repo, "boom"),
      throwingDeps,
    );
    assert.equal(result.stdout, "");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /injected exception/);
  });

  it("T4: marker conflicts, unmarked roots and symlink roots fail before creating a branch", () => {
    const repo = createRepo(temp);
    const other = createRepo(temp);
    const root = currentRoot(repo.commonDir, testHome);
    const rootPath = root.slice(0, -1);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, ".common-dir"),
      `${realpathSync(other.commonDir)}\n`,
    );
    const markerBefore = readFileSync(join(root, ".common-dir"), "utf8");
    const conflict = handleWorktreeCreate(createInput(repo, "conflict"));
    assert.equal(conflict.exitCode, 1);
    assert.equal(conflict.stdout, "");
    assert.notEqual(conflict.stderr, "");
    assert.equal(readFileSync(join(root, ".common-dir"), "utf8"), markerBefore);
    assert.equal(git(repo.dir, "branch", "--list", "worktree-conflict"), "");
    assert.equal(
      git(repo.dir, "worktree", "list", "--porcelain").includes(root),
      false,
    );

    rmSync(rootPath, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "keep.txt"), "keep\n");
    const unmarked = handleWorktreeCreate(createInput(repo, "unmarked"));
    assert.equal(unmarked.exitCode, 1);
    assert.equal(unmarked.stdout, "");
    assert.equal(existsSync(join(root, ".common-dir")), false);
    assert.equal(git(repo.dir, "branch", "--list", "worktree-unmarked"), "");
    assert.equal(
      git(repo.dir, "worktree", "list", "--porcelain").includes(root),
      false,
    );

    const elsewhere = temp.make("cwh-outside-");
    rmSync(rootPath, { recursive: true });
    symlinkSync(elsewhere, rootPath);
    const symlinked = handleWorktreeCreate(createInput(repo, "symlink"));
    assert.equal(symlinked.exitCode, 1);
    assert.equal(symlinked.stdout, "");
    assert.equal(git(repo.dir, "branch", "--list", "worktree-symlink"), "");
    assert.equal(
      git(repo.dir, "worktree", "list", "--porcelain").includes(root),
      false,
    );
  });

  it("T4: a healthy handler-created worktree is marked under the current root", () => {
    const repo = createRepo(temp);
    const result = handleWorktreeCreate(createInput(repo, "healthy"));
    const root = currentRoot(repo.commonDir, testHome);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, `${join(root, "worktree-healthy")}\n`);
    assert.equal(
      readFileSync(join(root, ".common-dir"), "utf8"),
      `${realpathSync(repo.commonDir)}\n`,
    );
    assert.notEqual(git(repo.dir, "branch", "--list", "worktree-healthy"), "");
  });

  it("C55: control characters in git's stderr are stripped from the output", () => {
    const repo = createRepo(temp);
    const { deps } = interceptGit([
      {
        match: ["branch"],
        replace: {
          ok: false,
          status: 128,
          stderr: "fatal: \x1b[31mboom\r\nsecond\x07 line",
          timedOut: false,
        },
      },
    ]);
    const result = handleWorktreeCreate(createInput(repo, "dirty"), deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /boom/);
    assert.equal(hasControlChars(result.stderr), false);
  });
});

describe("handleWorktreeCleanup: WorktreeRemove", () => {
  it("T2: removes an unchanged worktree from the legacy location", () => {
    const repo = createRepo(temp);
    const name = "worktree-legacy-remove";
    const path = join(repo.commonDir, "worktree", name);
    mkdirSync(join(repo.commonDir, "worktree"), { recursive: true });
    git(repo.dir, "worktree", "add", "-q", "-b", name, path);
    assert.equal(path, `${repo.commonDir}/worktree/${name}`);

    const result = handleWorktreeCleanup(removeInput(repo, path));
    assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 0 });
    assert.equal(existsSync(path), false);
    assert.equal(git(repo.dir, "branch", "--list", name), "");
  });

  it("C54: removes a removable worktree and exits 0 with nothing on stdout", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "gone");
    const result = handleWorktreeCleanup(removeInput(repo, path));
    assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 0 });
    assert.equal(existsSync(path), false);
  });

  it("C54: missing, non-string, empty and relative worktree_path exit 1 and remove nothing", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "keep");
    const bad: unknown[] = [undefined, 5, [path], "", "worktree-keep"];
    for (const value of bad) {
      const input =
        value === undefined
          ? JSON.stringify({ hook_event_name: "WorktreeRemove", cwd: repo.dir })
          : removeInput(repo, value);
      const result = handleWorktreeCleanup(input);
      assert.equal(result.exitCode, 1, JSON.stringify(value));
      assert.equal(result.stdout, "");
    }
    assert.ok(existsSync(path));
  });

  it("C54: outside-managed-dirs exits 1 and removes nothing", () => {
    const repo = createRepo(temp);
    const result = handleWorktreeCleanup(removeInput(repo, repo.dir));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /outside-managed-dirs/);
    assert.ok(existsSync(repo.dir));
  });

  it("C54: the same input twice exits 0 both times", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "twice");
    const input = removeInput(repo, path);
    assert.equal(handleWorktreeCleanup(input).exitCode, 0);
    assert.equal(handleWorktreeCleanup(input).exitCode, 0);
  });

  it("C54: an exception inside the core exits 1 with a stderr line", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "thrown");
    const result = handleWorktreeCleanup(removeInput(repo, path), throwingDeps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(lineCount(result.stderr), 1);
    assert.ok(existsSync(path));
  });

  it("C54b: a kept branch is reported on one line, plus a prune hint for stale registrations", () => {
    const repo = createRepo(temp);

    const worked = makeWorktree(repo, "worked");
    writeFileSync(join(worked, "w.txt"), "w\n");
    git(worked, "add", "--", "w.txt");
    git(worked, "commit", "-q", "-m", "w");
    const kept = handleWorktreeCleanup(removeInput(repo, worked));
    assert.equal(kept.exitCode, 0);
    assert.equal(
      kept.stderr,
      "kept branch worktree-worked: reflog-not-single-creation\n",
    );

    const moved = makeWorktree(repo, "moved");
    const tipMoved = interceptGit([
      {
        match: ["rev-parse", "--verify"],
        replace: { ok: true, stdout: "f".repeat(40) },
      },
    ]);
    const movedResult = handleWorktreeCleanup(
      removeInput(repo, moved),
      tipMoved.deps,
    );
    assert.equal(movedResult.exitCode, 0);
    assert.equal(movedResult.stderr, "kept branch worktree-moved: tip-moved\n");

    const stale = makeWorktree(repo, "stale");
    // Removing the directory behind git's back makes the registration prunable.
    rmSync(stale, { recursive: true });
    const prunable = handleWorktreeCleanup(removeInput(repo, stale));
    assert.equal(prunable.exitCode, 0);
    assert.equal(lineCount(prunable.stderr), 2);
    assert.match(prunable.stderr, /^kept branch worktree-stale: prunable\n/);
    assert.match(prunable.stderr, /git worktree prune\n$/);

    const partial = makeWorktree(repo, "partial");
    const incomplete = interceptGit([
      {
        match: ["worktree", "remove"],
        before: () => rmSync(partial, { recursive: true }),
        replace: GIT_FAILURE,
      },
    ]);
    const incompleteResult = handleWorktreeCleanup(
      removeInput(repo, partial),
      incomplete.deps,
    );
    assert.equal(incompleteResult.exitCode, 0);
    assert.equal(lineCount(incompleteResult.stderr), 2);
    assert.match(
      incompleteResult.stderr,
      /^kept branch worktree-partial: remove-incomplete\n/,
    );
    assert.match(incompleteResult.stderr, /git worktree prune\n$/);
  });

  it("C55: control characters in worktree_path are stripped from stderr", () => {
    const repo = createRepo(temp);
    // An existing directory outside the managed dirs, so the refusal message
    // quotes the path.
    const dirty = join(temp.make("cwt-dirty-"), "\x1b[31mevil\x07");
    mkdirSync(dirty);
    const result = handleWorktreeCleanup(removeInput(repo, dirty));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /evil/);
    assert.equal(hasControlChars(result.stderr), false);
  });
});

describe("handleWorktreeCleanup: SubagentStop", () => {
  const AGENT = "a278c2e632b92ee6c";

  it("T2: removes an unchanged legacy worktree-agent path on SubagentStop", () => {
    const repo = createRepo(temp);
    const name = `worktree-agent-${AGENT}`;
    const path = join(repo.commonDir, "worktree", name);
    mkdirSync(join(repo.commonDir, "worktree"), { recursive: true });
    git(repo.dir, "worktree", "add", "-q", "-b", name, path);

    const result = handleWorktreeCleanup(stopInput(repo, AGENT));
    assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 0 });
    assert.equal(existsSync(path), false);
    assert.equal(git(repo.dir, "branch", "--list", name), "");
  });

  it("C56: a non-string or missing agent_id, or a missing cwd, exits 0 with one stderr line", () => {
    const repo = createRepo(temp);
    const inputs = [
      stopInput(repo, 123),
      JSON.stringify({ hook_event_name: "SubagentStop", cwd: repo.dir }),
      JSON.stringify({ hook_event_name: "SubagentStop", agent_id: AGENT }),
    ];
    for (const input of inputs) {
      const result = handleWorktreeCleanup(input);
      assert.equal(result.exitCode, 0, input);
      assert.equal(result.stdout, "");
      assert.equal(lineCount(result.stderr), 1, input);
    }
  });

  it("C56: an exception inside the core exits 0 with one stderr line", () => {
    const repo = createRepo(temp);
    const result = handleWorktreeCleanup(stopInput(repo, AGENT), throwingDeps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(lineCount(result.stderr), 1);
  });

  it("C56b: none and removed are silent; removed with a kept branch and kept give one line; always exit 0", () => {
    const none = handleWorktreeCleanup(stopInput(createRepo(temp), AGENT));
    assert.deepEqual(none, { stdout: "", stderr: "", exitCode: 0 });

    const removedRepo = createRepo(temp);
    makeWorktree(removedRepo, `agent-${AGENT}`);
    assert.deepEqual(handleWorktreeCleanup(stopInput(removedRepo, AGENT)), {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const casRepo = createRepo(temp);
    makeWorktree(casRepo, `agent-${AGENT}`);
    const { deps } = interceptGit([
      {
        match: ["update-ref", "-d"],
        before: () => {
          const moved = git(
            casRepo.dir,
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            "-m",
            "moved",
          );
          git(
            casRepo.dir,
            "update-ref",
            `refs/heads/worktree-agent-${AGENT}`,
            moved,
          );
        },
      },
    ]);
    const cas = handleWorktreeCleanup(stopInput(casRepo, AGENT), deps);
    assert.equal(cas.exitCode, 0);
    assert.equal(cas.stdout, "");
    assert.equal(
      cas.stderr,
      `kept branch worktree-agent-${AGENT}: cas-missed\n`,
    );

    const keptRepo = createRepo(temp);
    const keptPath = makeWorktree(keptRepo, `agent-${AGENT}`);
    writeFileSync(join(keptPath, "new.txt"), "x\n");
    const kept = handleWorktreeCleanup(stopInput(keptRepo, AGENT));
    assert.equal(kept.exitCode, 0);
    assert.equal(kept.stdout, "");
    assert.equal(lineCount(kept.stderr), 1);
    assert.match(kept.stderr, /has-changes/);
  });
});

describe("handleWorktreeCleanup: undecidable input", () => {
  it("C57: an unknown or missing hook_event_name, broken JSON and empty stdin do nothing", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "untouched");
    const inputs = [
      JSON.stringify({
        hook_event_name: "PreToolUse",
        worktree_path: path,
        cwd: repo.dir,
      }),
      JSON.stringify({ worktree_path: path, cwd: repo.dir }),
      `{"hook_event_name":"WorktreeRemove","worktree_path":"${path}",`,
      "",
      "null",
    ];
    for (const input of inputs) {
      assert.deepEqual(
        handleWorktreeCleanup(input),
        { stdout: "", stderr: "", exitCode: 0 },
        input,
      );
    }
    assert.ok(existsSync(path));
  });
});

function worktreePath(repo: Repo, name: string): string {
  return join(currentRoot(repo.commonDir, testHome), `worktree-${name}`);
}

// The clock stands still except for one jump right after `git worktree add`, so the hook sees exactly `elapsedMs`
// since it started, whatever the real speed of git.
function createAfter(
  repo: Repo,
  name: string,
  elapsedMs: number,
  timing?: Deps["timing"],
) {
  const clock = { t: 1_000_000 };
  const { deps } = interceptGit(
    [
      {
        match: ["worktree", "add"],
        after: () => {
          clock.t += elapsedMs;
        },
      },
    ],
    { now: () => clock.t },
  );
  return handleWorktreeCreate(createInput(repo, name), { ...deps, timing });
}

describe("handleWorktreeCreate: dependency preparation", () => {
  it("T2-1: a session name runs the CLI once with --source new and a timeout, and stdout stays the path", () => {
    for (const name of ["foo", "bridge-cse_x"]) {
      const repo = createRepo(temp, { origin: true });
      installCli();
      const result = handleWorktreeCreate(createInput(repo, name));
      const path = worktreePath(repo, name);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${path}\n`);
      assert.deepEqual(readLog(cliLog), [`--source new --timeout 150 ${path}`]);
    }
  });

  it("T2-2: agent- and wf_ names are subagent worktrees and run the CLI with --no-install", () => {
    for (const name of ["agent-abc", "agent-foo", "wf_x-1"]) {
      const repo = createRepo(temp, { origin: true });
      installCli();
      const result = handleWorktreeCreate(createInput(repo, name));
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(readLog(cliLog), [
        `--no-install ${worktreePath(repo, name)}`,
      ]);
    }
  });

  it("T2-3: a reused worktree runs the CLI with --no-install and without --source", () => {
    const repo = createRepo(temp, { origin: true });
    const path = worktreePath(repo, "again");
    handleWorktreeCreate(createInput(repo, "again"));
    installCli();
    const second = handleWorktreeCreate(createInput(repo, "again"));
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(second.stdout, `${path}\n`);
    assert.deepEqual(readLog(cliLog), [`--no-install ${path}`]);
  });

  it("T2-4: a missing CLI still exits 0 with the path and one stderr line", () => {
    const repo = createRepo(temp, { origin: true });
    rmSync(cliPath);
    const result = handleWorktreeCreate(createInput(repo, "nocli"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${worktreePath(repo, "nocli")}\n`);
    assert.equal(lineCount(result.stderr), 1);
    assert.match(result.stderr, /git-worktree-deps/);
  });

  it("T2-5: a CLI that exits 1 still exits 0 with the path and one stderr line", () => {
    const repo = createRepo(temp, { origin: true });
    installCli("exit 1");
    const result = handleWorktreeCreate(createInput(repo, "failing"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${worktreePath(repo, "failing")}\n`);
    assert.equal(lineCount(result.stderr), 1);
    assert.match(result.stderr, /status 1/);
  });

  it("T2-6: a CLI that prints a lot leaves stdout as the path alone and forwards its output to stderr in a bounded form", () => {
    const repo = createRepo(temp, { origin: true });
    installCli(
      `i=0\nwhile [ $i -lt 20000 ]; do echo "out $i"; echo "err $i" >&2; i=$((i+1)); done`,
    );
    const result = handleWorktreeCreate(createInput(repo, "chatty"));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, `${worktreePath(repo, "chatty")}\n`);
    assert.match(result.stderr, /err 19999/);
    assert.ok(lineCount(result.stderr) <= 101, `${lineCount(result.stderr)}`);
    assert.equal(hasControlChars(result.stderr), false);
  });

  it("T2-6b: colour codes from the CLI do not leave their residue in stderr", () => {
    const repo = createRepo(temp, { origin: true });
    installCli(`printf '\\033[1;33m⚠️  warned\\033[0m\\n' >&2`);
    const result = handleWorktreeCreate(createInput(repo, "coloured"));
    assert.equal(result.stderr, "⚠️  warned\n");
  });

  it("T2-7: the CLI is started as the leader of its own process group", () => {
    const repo = createRepo(temp, { origin: true });
    installCli(
      `echo $$ > "$HOME/leader.pid"\nps -o pgid= -p $$ | tr -d ' ' > "$HOME/leader.pgid"`,
    );
    const result = handleWorktreeCreate(createInput(repo, "leader"));
    assert.equal(result.exitCode, 0, result.stderr);
    const pid = readFileSync(join(testHome, "leader.pid"), "utf8").trim();
    const pgid = readFileSync(join(testHome, "leader.pgid"), "utf8").trim();
    assert.equal(pgid, pid);
  });

  it("T2-8: the install budget follows the time left (elapsed 70 s -> 130, 170 s -> 30)", () => {
    for (const [elapsedSec, expected] of [
      [70, "--source new --timeout 130"],
      [170, "--source new --timeout 30"],
    ] as const) {
      const repo = createRepo(temp, { origin: true });
      installCli();
      const result = createAfter(repo, "budget", elapsedSec * 1000);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(readLog(cliLog), [
        `${expected} ${worktreePath(repo, "budget")}`,
      ]);
    }
  });

  it("T2-9: with under 30 s for the install (elapsed 171 s, 215 s) the CLI runs with --no-install and the path is returned", () => {
    for (const elapsedSec of [171, 215]) {
      const repo = createRepo(temp, { origin: true });
      installCli();
      const result = createAfter(repo, "late", elapsedSec * 1000);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${worktreePath(repo, "late")}\n`);
      assert.deepEqual(readLog(cliLog), [
        `--no-install ${worktreePath(repo, "late")}`,
      ]);
    }
  });

  it("T2-10: with under 10 s for the CLI itself (elapsed 235 s) it is not run; exit 0, the path, one stderr line", () => {
    const repo = createRepo(temp, { origin: true });
    installCli();
    const result = createAfter(repo, "toolate", 235_000);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${worktreePath(repo, "toolate")}\n`);
    assert.deepEqual(readLog(cliLog), []);
    assert.equal(lineCount(result.stderr), 1);
  });

  it("T2-11: the overall deadline kills a CLI whose child ignores TERM, without timeout on PATH", () => {
    const repo = createRepo(temp, { origin: true });
    rmSync(join(testHome, "child.pid"), { force: true });
    installCli(
      `( trap '' TERM; sleep 30 ) &\necho $! > "$HOME/child.pid"\ntrap '' TERM\nsleep 30`,
    );
    const started = Date.now();
    const result = handleWorktreeCreate(createInput(repo, "stuck"), {
      ...interceptGit().deps,
      timing: { budgetMs: 3000, cliReserveMs: 0, minCliMs: 1000 },
    });
    const tookMs = Date.now() - started;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${worktreePath(repo, "stuck")}\n`);
    assert.equal(lineCount(result.stderr), 1);
    assert.match(result.stderr, /deadline/);
    assert.ok(tookMs < 8000, `${tookMs} ms`);
    const childPid = Number(readFileSync(join(testHome, "child.pid"), "utf8"));
    sleepMs(300);
    assert.equal(isRunning(childPid), false);
  });

  it("T2-12: a CLI killed at the deadline in the middle of a clear-out leaves its marker in node_modules", () => {
    const repo = createRepo(temp, { origin: true });
    const path = worktreePath(repo, "midway");
    // The worktree is the last argument in both call shapes.
    installCli(
      `for last; do :; done\nmkdir -p "$last/node_modules"\ntouch "$last/node_modules/.git-worktree-deps-incomplete"\nsleep 30`,
    );
    const result = handleWorktreeCreate(createInput(repo, "midway"), {
      ...interceptGit().deps,
      timing: { budgetMs: 2000, cliReserveMs: 0, minCliMs: 1000 },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${path}\n`);
    assert.equal(lineCount(result.stderr), 1);
    assert.ok(
      existsSync(join(path, "node_modules", ".git-worktree-deps-incomplete")),
    );
  });

  // The notice reads the marker in T3 (dependency-notice.ts); until then this cannot pass.
  it(
    "T2-12b: the next notice for that worktree is the [deps] sentence",
    { todo: "T3: buildDependencyNotice reads .git-worktree-deps-incomplete" },
    async () => {
      const { buildDependencyNotice } =
        await import("../../lib/dependency-notice.ts");
      const repo = createRepo(temp, { origin: true });
      const path = worktreePath(repo, "midway2");
      handleWorktreeCreate(createInput(repo, "midway2"));
      writeFileSync(join(path, "package.json"), "{}\n");
      writeFileSync(join(path, "pnpm-lock.yaml"), "\n");
      mkdirSync(join(path, "node_modules"));
      writeFileSync(join(path, "node_modules", "left"), "x");
      writeFileSync(
        join(path, "node_modules", ".git-worktree-deps-incomplete"),
        "",
      );
      assert.match(buildDependencyNotice(path) ?? "", /^\[deps\]/);
    },
  );
});

describe("findMountsUnder", () => {
  const line = (mountPoint: string) =>
    `99 36 8:1 /x ${mountPoint} rw - ext4 /dev/x rw`;
  const base =
    "36 1 8:1 / / rw - ext4 /dev/sda1 rw\n37 36 0:6 / /proc rw - proc proc rw";

  it("T2-30: decodes the four escapes mountinfo uses (space, tab, newline, backslash)", () => {
    const cases: [string, string][] = [
      ["/h/re po/wt", "/h/re\\040po/wt/node_modules"],
      ["/h/re\tpo/wt", "/h/re\\011po/wt/node_modules"],
      ["/h/re\npo/wt", "/h/re\\012po/wt/node_modules"],
      ["/h/re\\po/wt", "/h/re\\134po/wt/node_modules"],
    ];
    for (const [path, mountPoint] of cases) {
      assert.equal(
        findMountsUnder(`${base}\n${line(mountPoint)}\n`, [path]),
        "mounted",
        path,
      );
    }
  });

  it("T2-31: no mount under the path is `none`; a sibling that shares the prefix is not under it", () => {
    assert.equal(findMountsUnder(`${base}\n`, ["/h/wt"]), "none");
    assert.equal(
      findMountsUnder(`${base}\n${line("/h/wt2/node_modules")}\n`, ["/h/wt"]),
      "none",
    );
    assert.equal(
      findMountsUnder(`${base}\n${line("/h/wt")}\n`, ["/h/wt"]),
      "mounted",
    );
  });

  it("T2-32: a table with no parsable line is `unreadable`, never `none`", () => {
    assert.equal(findMountsUnder("", ["/h/wt"]), "unreadable");
    assert.equal(findMountsUnder("garbage\n", ["/h/wt"]), "unreadable");
  });
});

describe("handleWorktreeCleanup inside agent-vm", () => {
  const AGENT = "a278c2e632b92ee6c";
  const MOUNTS =
    "36 1 8:1 / / rw - ext4 /dev/sda1 rw\n37 36 0:6 / /proc rw - proc proc rw\n";
  const removeCalls = (calls: { args: readonly string[] }[]) =>
    calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "remove");

  it("T2-20: WorktreeRemove goes through the helper: remove <wt> -- git ... worktree remove --force", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "vm-remove");
    enterVm();
    installHelper();
    const result = handleWorktreeCleanup(removeInput(repo, path));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(existsSync(path), false);
    const calls = readLog(helperLog);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.startsWith(`remove ${path} -- git `), calls[0]);
    assert.ok(
      calls[0]?.endsWith(`worktree remove --force -- ${path}`),
      calls[0],
    );
  });

  it("T2-21: SubagentStop of an unchanged worktree goes through the helper too, without --force", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, `agent-${AGENT}`);
    enterVm();
    installHelper();
    const result = handleWorktreeCleanup(stopInput(repo, AGENT));
    assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 0 });
    assert.equal(existsSync(path), false);
    const calls = readLog(helperLog);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.startsWith(`remove ${path} -- git `), calls[0]);
    assert.ok(calls[0]?.endsWith(`worktree remove -- ${path}`), calls[0]);
  });

  it("T2-22: a helper that exits 70 keeps the worktree and git is never called; SubagentStop exits 0, WorktreeRemove fails as before", () => {
    for (const event of ["remove", "stop"] as const) {
      const repo = createRepo(temp);
      const path = makeWorktree(
        repo,
        event === "stop" ? `agent-${AGENT}` : "refused",
      );
      enterVm();
      installHelper("echo 'refused: locked' >&2\nexit 70");
      const { deps, calls } = interceptGit();
      const result =
        event === "stop"
          ? handleWorktreeCleanup(stopInput(repo, AGENT), deps)
          : handleWorktreeCleanup(removeInput(repo, path), deps);
      assert.equal(result.exitCode, event === "stop" ? 0 : 1, event);
      assert.equal(existsSync(path), true, event);
      assert.deepEqual(removeCalls(calls), [], event);
      assert.equal(readLog(helperLog).length, 1, event);
      assert.match(result.stderr, /refused: locked/, event);
    }
  });

  it("T2-23: outside agent-vm the helper is not called and removal is the plain git removal", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "plain");
    installHelper();
    const { deps, calls } = interceptGit();
    const result = handleWorktreeCleanup(removeInput(repo, path), deps);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readLog(helperLog), []);
    assert.deepEqual(
      removeCalls(calls).map((c) => c.args.join(" ")),
      [`worktree remove --force -- ${path}`],
    );
  });

  it("T2-24: no helper and no mount under the worktree: the plain git removal runs (WorktreeRemove and SubagentStop)", () => {
    for (const event of ["remove", "stop"] as const) {
      const repo = createRepo(temp);
      const path = makeWorktree(
        repo,
        event === "stop" ? `agent-${AGENT}` : "nomount",
      );
      enterVm();
      const { deps } = interceptGit();
      const withMounts = { ...deps, readMountinfo: () => MOUNTS };
      const result =
        event === "stop"
          ? handleWorktreeCleanup(stopInput(repo, AGENT), withMounts)
          : handleWorktreeCleanup(removeInput(repo, path), withMounts);
      assert.equal(result.exitCode, 0, `${event}: ${result.stderr}`);
      assert.equal(existsSync(path), false, event);
    }
  });

  it("T2-25: no helper and a mount under the worktree, or an unreadable table: git is not called, the worktree stays, stderr says how to recover", () => {
    const cases: [string, (path: string) => () => string][] = [
      [
        "mounted",
        (path) => () =>
          `${MOUNTS}99 36 8:1 /x ${path}/node_modules rw - ext4 /dev/x rw\n`,
      ],
      [
        "unreadable",
        () => () => {
          throw new Error("EACCES");
        },
      ],
    ];
    for (const [label, readMountinfo] of cases) {
      for (const event of ["remove", "stop"] as const) {
        const repo = createRepo(temp);
        const path = makeWorktree(
          repo,
          event === "stop" ? `agent-${AGENT}` : "mounted",
        );
        enterVm();
        const { deps, calls } = interceptGit();
        const input = { ...deps, readMountinfo: readMountinfo(path) };
        const result =
          event === "stop"
            ? handleWorktreeCleanup(stopInput(repo, AGENT), input)
            : handleWorktreeCleanup(removeInput(repo, path), input);
        const where = `${label}/${event}`;
        assert.equal(result.exitCode, event === "stop" ? 0 : 1, where);
        assert.equal(existsSync(path), true, where);
        assert.deepEqual(removeCalls(calls), [], where);
        assert.match(result.stderr, /agent-vm-node-modules/, where);
      }
    }
  });

  it("T2-26: a mount of a sibling directory that shares the name prefix does not keep the worktree", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "prefix");
    enterVm();
    const { deps } = interceptGit();
    const result = handleWorktreeCleanup(removeInput(repo, path), {
      ...deps,
      readMountinfo: () =>
        `${MOUNTS}99 36 8:1 /x ${path}2/node_modules rw - ext4 /dev/x rw\n`,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(existsSync(path), false);
  });

  it("T2-27: end to end, a repo directory named with a space or a backslash is matched through the mountinfo escapes", () => {
    for (const [dirName, escaped] of [
      ["re po", "re\\040po"],
      ["re\\po", "re\\134po"],
    ] as const) {
      const parent = temp.make("cwh-named-");
      const dir = join(parent, dirName);
      mkdirSync(dir);
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "a.txt"), "a\n");
      git(dir, "add", "--", "a.txt");
      git(dir, "commit", "-q", "-m", "a");
      const repo: Repo = {
        dir,
        commonDir: join(dir, ".git"),
        baseSha: git(dir, "rev-parse", "HEAD"),
        originSha: null,
      };
      const path = makeWorktree(repo, "escaped");
      const mountPoint = `${path}/node_modules`.replace(dirName, escaped);
      enterVm();
      const { deps, calls } = interceptGit();
      const result = handleWorktreeCleanup(removeInput(repo, path), {
        ...deps,
        readMountinfo: () =>
          `${MOUNTS}99 36 8:1 /x ${mountPoint} rw - ext4 /dev/x rw\n`,
      });
      assert.equal(result.exitCode, 1, dirName);
      assert.equal(existsSync(path), true, dirName);
      assert.deepEqual(removeCalls(calls), [], dirName);
    }
  });
});
