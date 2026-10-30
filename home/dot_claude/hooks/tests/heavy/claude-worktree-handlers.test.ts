import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createWorktree } from "../../lib/claude-worktree.ts";
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

const temp = createTempTracker();
after(() => temp.cleanup());

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
      `${join(repo.commonDir, "worktree", "worktree-bold-oak-a3f2")}\n`,
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
      `${join(repo.commonDir, "worktree", "worktree-warned")}\n`,
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
