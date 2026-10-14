import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildSessionLearningsContext,
  buildWorkerSpawnSpec,
  enqueueSessionEnd,
  kickWorkerIfQueued,
} from "../../lib/agent-learnings/claude/session-context.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import {
  initStore,
  defaultStoreDir,
} from "../../lib/agent-learnings/core/store.ts";
import { writeInboxRequest } from "../../lib/agent-learnings/core/inbox.ts";
import {
  claimJob,
  countJobs,
  enqueueJob,
} from "../../lib/agent-learnings/core/queue.ts";

describe("buildSessionLearningsContext", () => {
  it("returns null without a store, drains the inbox and renders after", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-learnings-session-"));
    try {
      const repo = join(root, "repo");
      const home = join(root, "home");
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "https://github.com/foo/bar.git",
      ]);
      strictEqual(
        await buildSessionLearningsContext({
          cwd: repo,
          home,
          runGit,
          now: new Date(),
        }),
        null,
      );
      const store = defaultStoreDir(home);
      initStore(store, runGit);
      writeInboxRequest(
        store,
        {
          op: "add",
          repoKey: "github.com/foo/bar",
          title: "t",
          body: "b を使う",
          reader: "codex",
        },
        new Date(),
      );
      const out = await buildSessionLearningsContext({
        cwd: repo,
        home,
        runGit,
        now: new Date(),
      });
      ok((out ?? "").includes("b を使う"));
      ok(
        readFileSync(join(store, ".state/reads.log"), "utf8").includes(
          '"reader":"claude"',
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("enqueueSessionEnd", () => {
  const SID = "0f0e0d0c-0000-4000-8000-000000000001";
  function withRepo(
    fn: (ctx: { repo: string; home: string; root: string }) => void,
  ): void {
    const root = mkdtempSync(join(tmpdir(), "agent-learnings-sessionend-"));
    try {
      const repo = join(root, "repo");
      const home = join(root, "home");
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "https://github.com/foo/bar.git",
      ]);
      fn({ repo, home, root });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const input = (cwd: string) => ({
    session_id: SID,
    transcript_path: "/home/x/.claude/projects/p/s.jsonl",
    cwd,
    reason: "other",
  });

  it("does nothing without a store", () =>
    withRepo(({ repo, home }) => {
      let spawned = 0;
      enqueueSessionEnd(input(repo), {
        home,
        runGit,
        env: {},
        spawn: () => void spawned++,
      });
      strictEqual(spawned, 0);
    }));
  it("does nothing in a worker session", () =>
    withRepo(({ repo, home }) => {
      const store = defaultStoreDir(home);
      initStore(store, runGit);
      let spawned = 0;
      enqueueSessionEnd(input(repo), {
        home,
        runGit,
        env: { AGENT_LEARNINGS_WORKER: "1" },
        spawn: () => void spawned++,
      });
      strictEqual(spawned, 0);
      strictEqual(countJobs(store).queue, 0);
    }));
  it("does nothing outside a git repo", () =>
    withRepo(({ root, home }) => {
      initStore(defaultStoreDir(home), runGit);
      let spawned = 0;
      enqueueSessionEnd(input(root), {
        home,
        runGit,
        env: {},
        spawn: () => void spawned++,
      });
      strictEqual(spawned, 0);
    }));
  it("enqueues and starts the worker once for a repo with an origin", () =>
    withRepo(({ repo, home }) => {
      const store = defaultStoreDir(home);
      initStore(store, runGit);
      const spawned: string[] = [];
      enqueueSessionEnd(input(repo), {
        home,
        runGit,
        env: {},
        spawn: (h) => void spawned.push(h),
      });
      strictEqual(countJobs(store).queue, 1);
      deepStrictEqual(spawned, [home]);
    }));
});

describe("buildWorkerSpawnSpec", () => {
  it("passes only the allowlisted env, one fixed argument, the worker cwd, detached", () => {
    const spec = buildWorkerSpawnSpec("/h", {
      CLAUDECODE: "1",
      CLAUDE_CODE_PLUGIN_DIRS: "/p",
      PATH: "/bin",
      HOME: "/h",
    });
    strictEqual(spec.command, process.execPath);
    deepStrictEqual(spec.args, ["/h/.claude/scripts/learnings-worker.ts"]);
    deepStrictEqual(spec.env, { PATH: "/bin", HOME: "/h" });
    strictEqual(spec.cwd, "/h/.local/share/agent-learnings/.state/worker-cwd");
    strictEqual(spec.detached, true);
    strictEqual(spec.stdio, "ignore");
  });
});

describe("worker session exclusion and worker restart at SessionStart", () => {
  function withHome(
    fn: (ctx: { repo: string; home: string; store: string }) => Promise<void>,
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "agent-learnings-sessionstart-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/foo/bar.git",
    ]);
    const store = defaultStoreDir(home);
    initStore(store, runGit);
    return fn({ repo, home, store }).finally(() =>
      rmSync(root, { recursive: true, force: true }),
    );
  }
  const SID = "0f0e0d0c-0000-4000-8000-000000000001";
  const job = {
    sessionId: SID,
    transcriptPath: "/t.jsonl",
    cwd: "/c",
    repoKey: "github.com/foo/bar",
    reason: "other",
  };

  it("returns null in a worker session and writes no reads.log", () =>
    withHome(async ({ repo, home, store }) => {
      writeInboxRequest(
        store,
        {
          op: "add",
          repoKey: "github.com/foo/bar",
          title: "t",
          body: "b を使う",
          reader: "codex",
        },
        new Date(),
      );
      const out = await buildSessionLearningsContext({
        cwd: repo,
        home,
        runGit,
        now: new Date(),
        env: { AGENT_LEARNINGS_WORKER: "1" },
      });
      strictEqual(out, null);
      strictEqual(existsSync(join(store, ".state/reads.log")), false);
    }));
  it("starts the worker only when a job is queued or processing", () =>
    withHome(async ({ home, store }) => {
      let spawned = 0;
      const spawn = () => void spawned++;
      kickWorkerIfQueued(home, { spawn });
      strictEqual(spawned, 0);
      enqueueJob(store, job, new Date());
      kickWorkerIfQueued(home, { spawn });
      strictEqual(spawned, 1);
      ok(claimJob(store, { tried: new Set(), now: new Date() }));
      kickWorkerIfQueued(home, { spawn });
      strictEqual(spawned, 2); // processing だけが残っている
    }));
  it("does nothing without a store", () =>
    withHome(async ({ home }) => {
      let spawned = 0;
      kickWorkerIfQueued(`${home}-none`, { spawn: () => void spawned++ });
      strictEqual(spawned, 0);
    }));
});
