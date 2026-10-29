import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildSessionLearningsContext,
  enqueueSessionJob,
  kickWorkerIfQueued,
} from "../../lib/agent-learnings/claude/session-context.ts";
import { runGit } from "../../lib/run-git.ts";
import {
  initStore,
  defaultStoreDir,
  storePaths,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";
import { writeInboxRequest } from "../../lib/agent-learnings/core/inbox.ts";
import {
  claimJob,
  countJobs,
  enqueueJob,
} from "../../lib/agent-learnings/core/queue.ts";

describe("buildSessionLearningsContext", () => {
  it("returns null without a store, drains the inbox and renders after", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "agent-learnings-session-")),
    );
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

describe("buildSessionLearningsContext start-time filter", () => {
  const entry = (n: number, extra: Array<[string, string]>) => ({
    id: `L-${n.toString(16).padStart(12, "0")}`,
    title: `title ${n}`,
    body: `body ${n}`,
    seen: 1,
    repos: ["github.com/foo/bar"],
    updated: "2026-10-01",
    extra,
  });
  async function startContext(
    repoEntries: ReturnType<typeof entry>[],
    commonEntries: ReturnType<typeof entry>[] = [],
  ) {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "agent-learnings-startfilter-")),
    );
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
      const store = defaultStoreDir(home);
      initStore(store, runGit);
      for (const [key, entries] of [
        ["github.com/foo/bar", repoEntries],
        ["common", commonEntries],
      ] as const)
        ok(
          writeLearnings(store, { format: 1, key, readOnly: false, entries })
            .ok,
        );
      return await buildSessionLearningsContext({
        cwd: repo,
        home,
        runGit,
        now: new Date(),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("shows no-on, session and invalid-on entries and counts the scene-only ones", async () => {
    const out =
      (await startContext([
        entry(1, []),
        entry(2, [["on", "session"]]),
        entry(3, [["on", "cmd:git commit"]]),
        entry(4, [["on", "bogus!!"]]),
      ])) ?? "";
    ok(out.includes("title 1"));
    ok(out.includes("title 2"));
    ok(!out.includes("title 3"));
    ok(out.includes("title 4"));
    ok(out.includes("他に 1 件は、コマンドやファイルの場面で出る"));
  });
  it("has no scene line when nothing was filtered out", async () => {
    const out = (await startContext([entry(1, [])])) ?? "";
    ok(!out.includes("他に"));
  });
  it("is not null when the only entry is scene-only", async () => {
    const out =
      (await startContext([entry(1, [["on", "cmd:git commit"]])])) ?? "";
    ok(out.startsWith("[agent-learnings]"));
    ok(out.includes("他に 1 件は"));
    ok(out.includes("agent-learnings remove"));
    ok(!out.includes("title 1"));
  });
  it("shows a common entry whose only trigger is a path prefix", async () => {
    const out =
      (await startContext([], [entry(1, [["on", "path:mods/x/"]])])) ?? "";
    ok(out.includes("title 1"));
  });
});

describe("session.ts SessionStart state GC", () => {
  it("removes scene state older than 7 days under both the claude and codex state dirs", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "agent-learnings-gc-")),
    );
    try {
      const repoRoot = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../..",
      );
      const day = 24 * 60 * 60;
      const nowSec = Date.now() / 1000;
      const files = (["claude", "codex"] as const).map((reader) => {
        const dir = join(root, `.${reader}/state/agent-learnings`);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const old = join(dir, "sess-old.injected");
        const fresh = join(dir, "sess-new.injected");
        writeFileSync(old, "");
        writeFileSync(fresh, "");
        utimesSync(old, nowSec - 8 * day, nowSec - 8 * day);
        utimesSync(fresh, nowSec - 6 * day, nowSec - 6 * day);
        return { old, fresh };
      });
      writeFileSync(join(root, "envfile"), "");
      const env = { ...process.env, HOME: root };
      delete env.DOCUMENT_WORKFLOW_DIR;
      delete env.CLAUDE_LOGS_DIR;
      env.CLAUDE_ENV_FILE = join(root, "envfile");
      execFileSync(
        "bun",
        [join(repoRoot, "home/dot_claude/hooks/implementations/session.ts")],
        {
          cwd: repoRoot,
          input: JSON.stringify({
            hook_event_name: "SessionStart",
            cwd: repoRoot,
            session_id: "abcdef1234567890",
            transcript_path: "/tmp/fake-transcript.jsonl",
            source: "startup",
          }),
          encoding: "utf-8",
          env,
          timeout: 30_000,
        },
      );
      for (const { old, fresh } of files) {
        strictEqual(existsSync(old), false);
        strictEqual(existsSync(fresh), true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("enqueueSessionJob", () => {
  const SID = "0f0e0d0c-0000-4000-8000-000000000001";
  function withRepo(
    fn: (ctx: { repo: string; home: string; root: string }) => void,
  ): void {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "agent-learnings-sessionend-")),
    );
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
      enqueueSessionJob(input(repo), {
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
      enqueueSessionJob(input(repo), {
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
      enqueueSessionJob(input(root), {
        home,
        runGit,
        env: {},
        spawn: () => void spawned++,
      });
      strictEqual(spawned, 0);
    }));
  it("records the compact reason on the queued job", () =>
    withRepo(({ repo, home }) => {
      const store = defaultStoreDir(home);
      initStore(store, runGit);
      enqueueSessionJob(
        { ...input(repo), reason: "compact" },
        { home, runGit, env: {}, spawn: () => {} },
      );
      const job = JSON.parse(
        readFileSync(join(storePaths(store).queue, `${SID}.json`), "utf8"),
      );
      strictEqual(job.reason, "compact");
    }));
  it("enqueues and starts the worker once for a repo with an origin", () =>
    withRepo(({ repo, home }) => {
      const store = defaultStoreDir(home);
      initStore(store, runGit);
      const spawned: string[] = [];
      enqueueSessionJob(input(repo), {
        home,
        runGit,
        env: {},
        spawn: (h) => void spawned.push(h),
      });
      strictEqual(countJobs(store).queue, 1);
      deepStrictEqual(spawned, [home]);
    }));
});

describe("worker session exclusion and worker restart at SessionStart", () => {
  function withHome(
    fn: (ctx: { repo: string; home: string; store: string }) => Promise<void>,
  ): Promise<void> {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "agent-learnings-sessionstart-")),
    );
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
