import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getLearningsHealthNotice } from "../../lib/agent-learnings/claude/health.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import {
  claimJob,
  enqueueJob,
  failJob,
} from "../../lib/agent-learnings/core/queue.ts";
import { initStore } from "../../lib/agent-learnings/core/store.ts";

const SID = "0f0e0d0c-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-15T12:00:00Z");

function withStore(fn: (store: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-learnings-health-"));
  try {
    const store = join(root, "s");
    ok(initStore(store, runGit).ok);
    fn(store, root);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}
const job = (reason = "other") => ({
  sessionId: SID,
  transcriptPath: "/t.jsonl",
  cwd: "/c",
  repoKey: "github.com/a/b",
  reason,
});
const notice = (store: string) =>
  getLearningsHealthNotice({ store, now: NOW, runGit });

describe("getLearningsHealthNotice", () => {
  it("is null for a fresh store without a remote, and for a missing store", () => {
    withStore((store, root) => {
      strictEqual(notice(store), null);
      strictEqual(notice(join(root, "missing")), null);
    });
  });
  it("reports failed jobs without leaking the job reason", () => {
    withStore((store) => {
      enqueueJob(store, job("SECRET-REASON /home/x/path"), NOW);
      for (let i = 0; i < 3; i++) {
        const claimed = claimJob(store, { tried: new Set(), now: NOW });
        ok(claimed);
        failJob(store, claimed);
      }
      const line = notice(store) ?? "";
      ok(line.includes("failed"));
      ok(line.includes("agent-learnings status"));
      ok(!line.includes("SECRET-REASON"));
      ok(!line.includes("/home/x"));
      strictEqual(line.split("\n").length, 1);
    });
  });
  it("reports a job queued for more than 24 hours", () => {
    withStore((store) => {
      enqueueJob(store, job(), new Date(NOW.getTime() - 25 * 3_600_000));
      ok((notice(store) ?? "").includes("queue"));
      // 23 時間なら正常
    });
    withStore((store) => {
      enqueueJob(store, job(), new Date(NOW.getTime() - 23 * 3_600_000));
      strictEqual(notice(store), null);
    });
  });
  it("reports unpushed commits older than 7 days when an upstream exists", () => {
    withStore((store, root) => {
      const remote = join(root, "remote.git");
      execFileSync("git", ["init", "-q", "--bare", remote]);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", store, ...args], {
          env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
        });
      git("remote", "add", "origin", remote);
      git("push", "-q", "-u", "origin", "HEAD");
      strictEqual(notice(store), null);
      writeFileSync(join(store, "note.txt"), "x");
      git("add", "-A");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "old",
      );
      ok((notice(store) ?? "").includes("push"));
    });
  });
  it("does not report a recent unpushed commit", () => {
    withStore((store, root) => {
      const remote = join(root, "remote.git");
      execFileSync("git", ["init", "-q", "--bare", remote]);
      const git = (date: string, ...args: string[]) =>
        execFileSync("git", ["-C", store, ...args], {
          env: { ...process.env, GIT_COMMITTER_DATE: date },
        });
      git(NOW.toISOString(), "remote", "add", "origin", remote);
      git(NOW.toISOString(), "push", "-q", "-u", "origin", "HEAD");
      writeFileSync(join(store, "note.txt"), "x");
      git(NOW.toISOString(), "add", "-A");
      git(
        "2026-10-14T12:00:00Z",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "recent",
      );
      strictEqual(notice(store), null);
    });
  });
});
