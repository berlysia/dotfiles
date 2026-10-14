import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import {
  appendReadLog,
  commitStore,
  ensureStateDirs,
  initStore,
  readLearnings,
  repoFilePath,
  rotateLogs,
  storePaths,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

function withStore(fn: (store: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-learnings-store-"));
  try {
    fn(join(root, "agent-learnings"), root);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("initStore", () => {
  it("creates a private git repo with defaults, idempotently", () => {
    withStore((store) => {
      ok(initStore(store, runGit).ok);
      ok(initStore(store, runGit).ok);
      strictEqual(statSync(store).mode & 0o777, 0o700);
      strictEqual(readFileSync(join(store, "no-promote"), "utf8"), "local/*\n");
      strictEqual(readFileSync(join(store, ".gitignore"), "utf8"), ".state/\n");
      ok(existsSync(join(store, ".git")));
      ok(existsSync(join(store, ".state", "codex", "inbox")));
    });
  });
});

describe("ensureStateDirs", () => {
  it("creates the queue directories at 0700, for new and existing stores", () => {
    withStore((store) => {
      ok(initStore(store, runGit).ok);
      const paths = storePaths(store);
      for (const dir of [
        paths.queue,
        paths.processing,
        paths.failed,
        paths.workerCwd,
      ]) {
        strictEqual(statSync(dir).mode & 0o777, 0o700);
      }
      rmSync(paths.queue, { recursive: true });
      ensureStateDirs(store);
      strictEqual(statSync(paths.queue).mode & 0o777, 0o700);
    });
  });
});

describe("readLearnings / writeLearnings", () => {
  it("returns an empty file for a new key and writes 0600", () => {
    withStore((store) => {
      initStore(store, runGit);
      const r = readLearnings(store, "github.com/a/b");
      ok(r.ok);
      strictEqual(r.value.entries.length, 0);
      ok(writeLearnings(store, r.value).ok);
      strictEqual(
        statSync(repoFilePath(store, "github.com/a/b")).mode & 0o777,
        0o600,
      );
    });
  });
  it("refuses a symlinked repo file", () => {
    withStore((store) => {
      initStore(store, runGit);
      const target = join(store, "elsewhere.md");
      writeFileSync(target, "x");
      symlinkSync(target, repoFilePath(store, "github.com/a/b"));
      strictEqual(readLearnings(store, "github.com/a/b").ok, false);
    });
  });
  it("refuses when repos/ itself is a symlink", () => {
    withStore((store, root) => {
      initStore(store, runGit);
      rmSync(join(store, "repos"), { recursive: true });
      mkdirSync(join(root, "outside"));
      symlinkSync(join(root, "outside"), join(store, "repos"));
      strictEqual(readLearnings(store, "github.com/a/b").ok, false);
    });
  });
});

describe("commitStore", () => {
  it("commits with a fixed author, reports nothing-to-commit, and ignores gpgsign", () => {
    withStore((store) => {
      initStore(store, runGit);
      execFileSync("git", ["-C", store, "config", "commit.gpgsign", "true"]);
      const r = readLearnings(store, "github.com/a/b");
      ok(r.ok);
      writeLearnings(store, r.value);
      const first = commitStore(store, "learnings: test", runGit);
      ok(first.ok && first.committed);
      const second = commitStore(store, "learnings: again", runGit);
      ok(second.ok && !second.committed);
      const log = execFileSync("git", [
        "-C",
        store,
        "log",
        "--format=%an %s",
      ]).toString();
      ok(log.includes("agent-learnings learnings: test"));
    });
  });
});

describe("appendReadLog", () => {
  it("appends one JSON line with an ISO-8601 UTC timestamp", () => {
    withStore((store) => {
      initStore(store, runGit);
      const path = join(store, ".state", "reads.log");
      appendReadLog(path, {
        at: new Date("2026-10-15T01:02:03Z"),
        reader: "codex",
        repoKey: "github.com/a/b",
      });
      strictEqual(
        readFileSync(path, "utf8"),
        '{"at":"2026-10-15T01:02:03.000Z","reader":"codex","repoKey":"github.com/a/b"}\n',
      );
    });
  });
  it("normalizes unknown readers and swallows write failures", () => {
    withStore((store, root) => {
      initStore(store, runGit);
      const path = join(store, ".state", "reads.log");
      appendReadLog(path, {
        at: new Date(),
        reader: "evil\nreader",
        repoKey: "github.com/a/b",
      });
      ok(readFileSync(path, "utf8").includes('"reader":"unknown"'));
      chmodSync(join(store, ".state"), 0o500);
      appendReadLog(join(store, ".state", "x", "reads.log"), {
        at: new Date(),
        reader: "claude",
        repoKey: "k/a",
      });
      chmodSync(join(store, ".state"), 0o700);
      ok(root.length > 0);
    });
  });
});

describe("log rotation", () => {
  it("appendReadLog never rotates; rotateLogs rotates the three logs over 1MB", () => {
    withStore((store) => {
      initStore(store, runGit);
      const paths = storePaths(store);
      const big = 1024 * 1024 + 1;
      for (const path of [paths.runsLog, paths.readsLog, paths.codexReadsLog]) {
        writeFileSync(path, "");
        truncateSync(path, big);
      }
      appendReadLog(paths.readsLog, {
        at: new Date(),
        reader: "claude",
        repoKey: "github.com/a/b",
      });
      ok(!existsSync(`${paths.readsLog}.1`));
      rotateLogs(store);
      for (const path of [paths.runsLog, paths.readsLog, paths.codexReadsLog]) {
        ok(existsSync(`${path}.1`), path);
        ok(!existsSync(path), path);
      }
    });
  });
  it("leaves small logs alone", () => {
    withStore((store) => {
      initStore(store, runGit);
      const paths = storePaths(store);
      writeFileSync(paths.runsLog, "x\n");
      rotateLogs(store);
      ok(existsSync(paths.runsLog));
      ok(!existsSync(`${paths.runsLog}.1`));
    });
  });
});
