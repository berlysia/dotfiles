import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildSessionLearningsContext,
  buildWorkerSpawnSpec,
  jobInputFromHook,
} from "../../lib/agent-learnings/claude/session-context.ts";
import type { RunGit } from "../../lib/run-git.ts";
import {
  COMMON_KEY,
  type LearningEntry,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import { parseInjectionLines } from "../../lib/agent-learnings/core/metrics.ts";
import {
  defaultStoreDir,
  ensureStateDirs,
  storePaths,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

describe("jobInputFromHook", () => {
  const base = { session_id: "s", transcript_path: "/t.jsonl", cwd: "/c" };
  it("uses the fixed compact reason for PreCompact", () => {
    deepStrictEqual(
      jobInputFromHook({ ...base, hook_event_name: "PreCompact" }),
      { ...base, reason: "compact" },
    );
  });
  it("keeps the SessionEnd reason", () => {
    deepStrictEqual(
      jobInputFromHook({
        ...base,
        hook_event_name: "SessionEnd",
        reason: "logout",
      }),
      { ...base, reason: "logout" },
    );
  });
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

describe("buildSessionLearningsContext injection records", () => {
  const KEY = "github.com/berlysia/foo";
  const roots: string[] = [];
  after(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });
  const entry = (n: number, extra: Array<[string, string]>): LearningEntry => ({
    id: `L-${n.toString(16).padStart(12, "0")}`,
    title: `title ${n}`,
    body: `body ${n}`,
    seen: 1,
    repos: [KEY],
    updated: "2026-10-01",
    extra,
  });
  const git: RunGit = (args) => {
    if (args[0] === "config")
      return { ok: true, stdout: "https://github.com/berlysia/foo.git" };
    if (args[0] === "rev-parse") return { ok: true, stdout: "/work/r/.git" };
    return { ok: false, status: 1 };
  };
  function setup(entries: LearningEntry[]) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "session-context-")));
    roots.push(home);
    const store = defaultStoreDir(home);
    mkdirSync(join(store, ".git"), { recursive: true });
    mkdirSync(join(store, "repos"), { mode: 0o700 });
    ensureStateDirs(store);
    ok(
      writeLearnings(store, { format: 1, key: KEY, readOnly: false, entries })
        .ok,
    );
    ok(
      writeLearnings(store, {
        format: 1,
        key: COMMON_KEY,
        readOnly: false,
        entries: [],
      }).ok,
    );
    return { home, store };
  }
  const run = (home: string, env?: Record<string, string | undefined>) =>
    buildSessionLearningsContext({
      cwd: "/work/r",
      home,
      runGit: git,
      now: new Date("2026-10-22T00:00:00Z"),
      env: env ?? {},
    });

  it("records untagged and session items as kind session and ends with the hint", async () => {
    const { home, store } = setup([
      entry(1, []),
      entry(2, [["on", "session"]]),
      entry(3, [["on", "cmd:git commit"]]),
    ]);
    const text = await run(home);
    ok(text?.split("\n").some((l) => l.includes("--at=session")));
    const lines = parseInjectionLines(
      readFileSync(storePaths(store).injectionsLog, "utf8"),
    ).lines;
    deepStrictEqual(lines.map((l) => [l.id, l.kind, l.trigger]).sort(), [
      ["L-000000000001", "session", "untagged"],
      ["L-000000000002", "session", "session"],
    ]);
  });
  it("does not create injections.log for a worker session", async () => {
    const { home, store } = setup([entry(1, [])]);
    strictEqual(await run(home, { AGENT_LEARNINGS_WORKER: "1" }), null);
    strictEqual(existsSync(storePaths(store).injectionsLog), false);
  });
  it(
    "returns the text when .state is read-only",
    { skip: process.getuid?.() === 0 },
    async () => {
      const { home, store } = setup([entry(1, [])]);
      chmodSync(storePaths(store).state, 0o500);
      try {
        ok((await run(home))?.includes("title 1"));
      } finally {
        chmodSync(storePaths(store).state, 0o700);
      }
    },
  );
});
