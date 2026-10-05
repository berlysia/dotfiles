#!/usr/bin/env node --test

// Working-tree fingerprint decides whether completion-gate may skip its
// checks for a turn (see plan K1-K3). Every case runs against a throwaway git
// repository and a throwaway stateDir; HOME is never touched.

import { execFileSync } from "node:child_process";
import { deepStrictEqual, doesNotThrow, ok, strictEqual } from "node:assert";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  checkTreeChange,
  computeTreeFingerprint,
  pruneStaleBaselines,
  saveBaseline,
} from "../../lib/working-tree-fingerprint.ts";
import { createBlockingGit } from "../support/fake-git.ts";
import { EnvironmentHelper } from "./test-helpers.ts";

const PATIENT_DEADLINE_MS = 30_000;

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    // 0500 dirs from the read-only case must be removable.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "working-tree-fingerprint-test-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", message);
}

function initRepoWithoutCommit(): string {
  const repo = makeTempDir();
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

let templateRepo: string | undefined;

/**
 * A committed repository, copied from a template built once per run. Building
 * each repo with init/config/add/commit spawned ~7 git processes per case and
 * made this file the slowest in the suite (the suite runs in completion-gate).
 */
function makeRepo(): string {
  if (templateRepo === undefined) {
    const template = initRepoWithoutCommit();
    writeFileSync(join(template, ".gitignore"), "ignored.log\n");
    writeFileSync(join(template, "tracked.txt"), "one\n");
    mkdirSync(join(template, "sub"));
    writeFileSync(join(template, "sub", "inner.txt"), "inner\n");
    commitAll(template, "init");
    templateRepo = template;
  }
  const repo = makeTempDir();
  cpSync(templateRepo, repo, { recursive: true });
  return repo;
}

function baselinePath(stateDir: string, sessionId: string): string {
  return join(stateDir, `${sessionId}.txt`);
}

/** Saves the current fingerprint as the baseline for sessionId "s1". */
function saveCurrent(stateDir: string, repo: string): void {
  saveBaseline(
    stateDir,
    "s1",
    computeTreeFingerprint(repo, PATIENT_DEADLINE_MS),
  );
}

function stateOf(stateDir: string, repo: string): string {
  return checkTreeChange(stateDir, "s1", repo, PATIENT_DEADLINE_MS).state;
}

const isRoot = process.getuid?.() === 0;

describe("checkTreeChange: detection", () => {
  it("1: reports unchanged when nothing changed", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    strictEqual(stateOf(stateDir, repo), "unchanged");
  });

  it("2: reports changed when a tracked file is edited", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    strictEqual(stateOf(stateDir, repo), "changed");
  });

  it("3: reports changed when an already-modified file is edited again", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "tracked.txt"), "three\n");
    strictEqual(stateOf(stateDir, repo), "changed");
  });

  it("4: reports changed when an untracked file is created", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "new.txt"), "new\n");
    strictEqual(stateOf(stateDir, repo), "changed");
  });

  it("5: reports changed when only the content of an existing untracked file changes", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    writeFileSync(join(repo, "new.txt"), "a\n");
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "new.txt"), "b\n");
    strictEqual(stateOf(stateDir, repo), "changed");
  });

  it("5b: reports changed when an untracked file only gains the executable bit", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    writeFileSync(join(repo, "run.sh"), "echo hi\n", { mode: 0o644 });
    saveCurrent(stateDir, repo);
    chmodSync(join(repo, "run.sh"), 0o755);
    strictEqual(stateOf(stateDir, repo), "changed");
  });

  it("6: reports unchanged when only a gitignored file is created", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "ignored.log"), "noise\n");
    strictEqual(stateOf(stateDir, repo), "unchanged");
  });

  it("7: reports changed after committing (HEAD moved, tree clean)", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    commitAll(repo, "edit");
    strictEqual(git(repo, "status", "--porcelain"), "");
    strictEqual(stateOf(stateDir, repo), "changed");
  });

  it("8: reports unchanged when an edit is reverted", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    strictEqual(stateOf(stateDir, repo), "unchanged");
  });

  it("9: keeps reporting changed on repeated checks (baseline is not advanced)", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    strictEqual(stateOf(stateDir, repo), "changed");
    strictEqual(stateOf(stateDir, repo), "changed");
  });

  it("20: sees untracked files outside a subdirectory cwd", () => {
    const repo = makeRepo();
    const sub = join(repo, "sub");
    const stateDir = makeTempDir();
    saveBaseline(
      stateDir,
      "s1",
      computeTreeFingerprint(sub, PATIENT_DEADLINE_MS),
    );
    writeFileSync(join(repo, "outside.txt"), "x\n");
    strictEqual(
      checkTreeChange(stateDir, "s1", sub, PATIENT_DEADLINE_MS).state,
      "changed",
    );
  });

  it("21: handles untracked file names containing a newline", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(join(repo, "a\nb.txt"), "x\n");
    strictEqual(stateOf(stateDir, repo), "changed");

    const stateDir2 = makeTempDir();
    saveCurrent(stateDir2, repo);
    strictEqual(stateOf(stateDir2, repo), "unchanged");
    writeFileSync(join(repo, "a\nb.txt"), "y\n");
    strictEqual(stateOf(stateDir2, repo), "changed");
  });

  it("22: fingerprints a dangling untracked symlink and detects its creation", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    symlinkSync("does-not-exist", join(repo, "dangling"));
    ok(computeTreeFingerprint(repo, PATIENT_DEADLINE_MS) !== null);
    strictEqual(stateOf(stateDir, repo), "changed");
  });
});

describe("fail-safe", () => {
  it("10: returns null / unknown outside a git repository", () => {
    const dir = makeTempDir();
    const stateDir = makeTempDir();
    strictEqual(computeTreeFingerprint(dir, PATIENT_DEADLINE_MS), null);
    strictEqual(
      checkTreeChange(stateDir, "s1", dir, PATIENT_DEADLINE_MS).state,
      "unknown",
    );
  });

  it("11: returns null for a repository with an unborn HEAD", () => {
    const repo = initRepoWithoutCommit();
    strictEqual(computeTreeFingerprint(repo, PATIENT_DEADLINE_MS), null);
  });

  it("12: reports unknown when no baseline was saved", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    strictEqual(stateOf(stateDir, repo), "unknown");
  });

  it("13: saveBaseline(null) removes the baseline so it cannot cause a false skip", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    ok(existsSync(baselinePath(stateDir, "s1")));
    saveBaseline(stateDir, "s1", null);
    strictEqual(existsSync(baselinePath(stateDir, "s1")), false);
    strictEqual(stateOf(stateDir, repo), "unknown");
  });

  it("14: reports unknown for a malformed baseline", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    writeFileSync(baselinePath(stateDir, "s1"), "garbage");
    strictEqual(stateOf(stateDir, repo), "unknown");
  });

  it("15: returns null when an untracked nested git repository exists", () => {
    const repo = makeRepo();
    const nested = join(repo, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q");
    writeFileSync(join(nested, "f.txt"), "x\n");
    strictEqual(computeTreeFingerprint(repo, PATIENT_DEADLINE_MS), null);
  });

  it("16: returns null when the deadline is 0", () => {
    const repo = makeRepo();
    strictEqual(computeTreeFingerprint(repo, 0), null);
  });

  it("25: returns null when an untracked file exceeds the size limit", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(17 * 1024 * 1024));
    strictEqual(computeTreeFingerprint(repo, PATIENT_DEADLINE_MS), null);
  });

  it("26: returns null when an untracked file cannot be read", (t) => {
    if (isRoot) {
      t.skip("root ignores file modes");
      return;
    }
    const repo = makeRepo();
    writeFileSync(join(repo, "secret.txt"), "x\n", { mode: 0o000 });
    strictEqual(computeTreeFingerprint(repo, PATIENT_DEADLINE_MS), null);
  });

  it("23: keeps the old baseline (and reports changed) when it cannot be replaced", (t) => {
    if (isRoot) {
      t.skip("root ignores directory modes");
      return;
    }
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    const before = readFileSync(baselinePath(stateDir, "s1"), "utf-8");
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    chmodSync(stateDir, 0o500);
    try {
      doesNotThrow(() => saveCurrent(stateDir, repo));
      strictEqual(readFileSync(baselinePath(stateDir, "s1"), "utf-8"), before);
      strictEqual(stateOf(stateDir, repo), "changed");
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });

  it("forwards the deadline: checkTreeChange with 0 is unknown despite a valid baseline", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    deepStrictEqual(checkTreeChange(stateDir, "s1", repo, 0), {
      state: "unknown",
      reason: "fingerprint unavailable",
    });
  });

  it("gives up at the production default deadline when git diff blocks", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    saveCurrent(stateDir, repo);
    const env = new EnvironmentHelper();
    const git = createBlockingGit("diff");
    env.set("PATH", `${git.binDir}:${process.env.PATH ?? ""}`);
    try {
      // Three arguments: the production default (2000ms) must expire. The
      // deadline may run out on the earlier rev-parse calls under load, so
      // only the result is asserted, not that diff was reached.
      strictEqual(checkTreeChange(stateDir, "s1", repo).state, "unknown");
    } finally {
      env.restore();
      git.cleanup();
    }
  });
});

describe("state file handling", () => {
  it("17: rejects a path-traversing session id", () => {
    const repo = makeRepo();
    const base = makeTempDir();
    const stateDir = join(base, "state");
    saveBaseline(
      stateDir,
      "../x",
      computeTreeFingerprint(repo, PATIENT_DEADLINE_MS),
    );
    strictEqual(existsSync(join(base, "x.txt")), false);
    strictEqual(
      checkTreeChange(stateDir, "../x", repo, PATIENT_DEADLINE_MS).state,
      "unknown",
    );
  });

  it("18: replaces a symlinked baseline without writing through it", () => {
    const repo = makeRepo();
    const stateDir = makeTempDir();
    const victimDir = makeTempDir();
    const victim = join(victimDir, "victim.txt");
    writeFileSync(victim, "precious");
    symlinkSync(victim, baselinePath(stateDir, "s1"));
    saveCurrent(stateDir, repo);
    strictEqual(readFileSync(victim, "utf-8"), "precious");
    strictEqual(stateOf(stateDir, repo), "unchanged");
  });

  it("19: prunes baselines older than the max age only", () => {
    const stateDir = makeTempDir();
    const oldFile = join(stateDir, "old.txt");
    const freshFile = join(stateDir, "fresh.txt");
    writeFileSync(oldFile, "a");
    writeFileSync(freshFile, "b");
    const day = 24 * 60 * 60 * 1000;
    const eightDaysAgo = new Date(Date.now() - 8 * day);
    const oneDayAgo = new Date(Date.now() - day);
    utimesSync(oldFile, eightDaysAgo, eightDaysAgo);
    utimesSync(freshFile, oneDayAgo, oneDayAgo);
    pruneStaleBaselines(stateDir, 7 * day);
    deepStrictEqual(readdirSync(stateDir), ["fresh.txt"]);
  });
});
