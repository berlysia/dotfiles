// Shared by heavy/agent-learnings-worker.test.ts and perf/agent-learnings-worker.test.ts.
// withWorld() runs `git init`: only heavy and perf import this file.
import { ok } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WorkerDeps } from "../../../scripts/learnings-worker.ts";
import type {
  DistillMessage,
  DistillQueryFn,
} from "../../lib/agent-learnings/claude/distill.ts";
import { patientRunGit as runGit } from "./patient-git.ts";
import { type LearningEntry } from "../../lib/agent-learnings/core/learnings-file.ts";
import {
  enqueueJob,
  type RunLogLine,
} from "../../lib/agent-learnings/core/queue.ts";
import {
  defaultStoreDir,
  initStore,
  readLearnings,
  storePaths,
} from "../../lib/agent-learnings/core/store.ts";

export const KEY = "github.com/a/b";
export const SID = "0f0e0d0c-0000-4000-8000-000000000001";
export const sidN = (n: number): string =>
  `0f0e0d0c-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const user = (text: string): string =>
  JSON.stringify({ type: "user", message: { content: text } });
export const utterances = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => user(`${prefix}${i + 1}`));
export const fenced = (ops: unknown[]): string =>
  `\`\`\`json\n${JSON.stringify({ schemaVersion: 1, ops })}\n\`\`\``;
export const addOp = (
  title = "Use bunfig preload",
  body = "Put it in bunfig.toml.",
) => ({
  op: "add",
  title,
  body,
  evidence: "the user corrected the preload location",
});
export const entry = (n: number): LearningEntry => ({
  id: `L-${n.toString(16).padStart(12, "0")}`,
  title: `existing ${n}`,
  body: `existing body ${n}`,
  seen: 1,
  repos: [KEY],
  updated: "2026-10-01",
  extra: [],
});

export type World = {
  root: string;
  home: string;
  store: string;
  repo: string;
  transcriptPath: (sid?: string) => string;
  writeTranscript: (lines: string[], sid?: string) => void;
  enqueue: (sid?: string, reason?: string) => void;
  prompts: string[];
  queryFor: (
    respond: (call: number, prompt: string) => string | Promise<string>,
  ) => DistillQueryFn;
  deps: (queryFn: DistillQueryFn, over?: Partial<WorkerDeps>) => WorkerDeps;
  runs: () => RunLogLine[];
  commits: () => number;
};

export async function withWorld(
  fn: (w: World) => Promise<void>,
): Promise<void> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-learnings-worker-")),
  );
  try {
    const home = join(root, "home");
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/a/b.git",
    ]);
    mkdirSync(join(home, ".claude/projects/p"), { recursive: true });
    const store = defaultStoreDir(home);
    const init = initStore(store, runGit);
    ok(init.ok, init.ok ? "" : init.reason);
    const prompts: string[] = [];
    const transcriptPath = (sid = SID): string =>
      join(home, ".claude/projects/p", `${sid}.jsonl`);
    const world: World = {
      root,
      home,
      store,
      repo,
      transcriptPath,
      writeTranscript: (lines, sid = SID) =>
        writeFileSync(transcriptPath(sid), `${lines.join("\n")}\n`),
      enqueue: (sid = SID, reason = "other") => {
        const r = enqueueJob(
          store,
          {
            sessionId: sid,
            transcriptPath: transcriptPath(sid),
            cwd: repo,
            repoKey: KEY,
            reason,
          },
          new Date(),
        );
        ok(r.status === "enqueued");
      },
      prompts,
      queryFor: (respond) => {
        let call = 0;
        return (args) => {
          prompts.push(args.prompt);
          const n = call++;
          return (async function* (): AsyncGenerator<DistillMessage> {
            yield {
              type: "result",
              subtype: "success",
              result: await respond(n, args.prompt),
            };
          })();
        };
      },
      deps: (queryFn, over = {}) => ({
        home,
        store,
        now: () => new Date(),
        queryFn,
        runGit,
        claudePath: undefined,
        extraRedact: [],
        env: {},
        lockWaitMs: 300,
        ...over,
      }),
      runs: () => {
        try {
          return readFileSync(storePaths(store).runsLog, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as RunLogLine);
        } catch {
          return [];
        }
      },
      commits: () =>
        Number(
          execFileSync("git", ["-C", store, "rev-list", "--count", "HEAD"])
            .toString()
            .trim(),
        ),
    };
    await fn(world);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}
export const names = (dir: string): string[] => readdirSync(dir).sort();
export const entriesOf = (w: World, key = KEY) => {
  const r = readLearnings(w.store, key);
  ok(r.ok);
  return r.value.entries;
};
