import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runWorker } from "../../../scripts/learnings-worker.ts";
import { writeInboxRequest } from "../../lib/agent-learnings/core/inbox.ts";
import {
  COMMON_KEY,
  serializeLearningsFile,
  type LearningEntry,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import { withStoreLock } from "../../lib/agent-learnings/core/lock.ts";
import {
  enqueueJob,
  readProcessed,
} from "../../lib/agent-learnings/core/queue.ts";
import {
  readLearnings,
  repoFilePath,
  storePaths,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

import {
  KEY,
  SID,
  addOp,
  entriesOf,
  entry,
  fenced,
  names,
  sidN,
  user,
  utterances,
  withWorld,
  type World,
} from "../support/agent-learnings-worker-fixture.ts";

describe("runWorker happy path", () => {
  it("applies an add, commits with evidence, records the position", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("hello ", 3));
      w.enqueue();
      const q = w.queryFor(() => fenced([addOp()]));
      const result = await runWorker(w.deps(q));
      strictEqual(result.status, "done");
      strictEqual(entriesOf(w).length, 1);
      const log = execFileSync("git", [
        "-C",
        w.store,
        "log",
        "-1",
        "--format=%s%n%b",
      ]).toString();
      ok(log.startsWith(`learnings: session 0f0e0d0c (${KEY})`), log);
      ok(log.includes("the user corrected the preload location"));
      const processed = readProcessed(w.store).records[SID];
      ok((processed?.byteOffset ?? 0) > 0);
      ok(w.prompts[0]?.includes("<transcript>"));
      const runs = w.runs();
      strictEqual(runs.length, 1);
      strictEqual(runs[0]?.result, "applied");
      strictEqual(runs[0]?.opsApplied, 1);
      strictEqual(names(storePaths(w.store).queue).length, 0);
      strictEqual(names(storePaths(w.store).processing).length, 0);
    }));
  it("puts retag and untag lines from on-changing updates into the commit body", async () =>
    withWorld(async (w) => {
      const file = readLearnings(w.store, KEY);
      ok(file.ok);
      file.value.format = 1;
      file.value.entries = [
        { ...entry(1), extra: [["on", "cmd:git commit"]] },
        { ...entry(2), extra: [["on", "cmd:git push"]] },
      ];
      ok(writeLearnings(w.store, file.value).ok);
      w.writeTranscript(utterances("hello ", 3));
      w.enqueue();
      const q = w.queryFor(() =>
        fenced([
          {
            op: "update",
            id: entry(1).id,
            on: ["cmd:git tag"],
            evidence: "ev1",
          },
          { op: "update", id: entry(2).id, body: "rewritten", evidence: "ev2" },
        ]),
      );
      strictEqual((await runWorker(w.deps(q))).status, "done");
      const log = execFileSync("git", [
        "-C",
        w.store,
        "log",
        "-1",
        "--format=%b",
      ]).toString();
      ok(
        log.includes(
          `retag ${entry(1).id}: cmd:git commit -> cmd:git tag (ev1)`,
        ),
        log,
      );
      ok(
        log.includes(`untag ${entry(2).id}: cmd:git push (updated by worker)`),
        log,
      );
      const after = entriesOf(w);
      strictEqual(after[0]?.seen, 1);
      strictEqual(after[0]?.updated, "2026-10-01");
      deepStrictEqual(after[1]?.extra, []);
    }));
  it("skips with fewer than 3 user turns without calling the LLM or recording a position", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("hi ", 1));
      w.enqueue();
      const q = w.queryFor(() => fenced([]));
      await runWorker(w.deps(q));
      strictEqual(w.prompts.length, 0);
      strictEqual(SID in readProcessed(w.store).records, false);
      const runs = w.runs();
      strictEqual(runs[0]?.result, "skipped");
      strictEqual(runs[0]?.reason, "fewer than 3 user turns");
      strictEqual(names(storePaths(w.store).queue).length, 0);
    }));
  it("sends only the new range after a resume", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("first", 3));
      w.enqueue();
      const q = w.queryFor(() => fenced([]));
      await runWorker(w.deps(q));
      appendFileSync(
        w.transcriptPath(),
        `${utterances("second", 3).join("\n")}\n`,
      );
      w.enqueue();
      await runWorker(w.deps(q));
      strictEqual(w.prompts.length, 2);
      ok(w.prompts[0]?.includes("first1"));
      ok(!w.prompts[1]?.includes("first1"));
      ok(w.prompts[1]?.includes("second1"));
    }));
  it("records the position and does not commit for an empty ops list", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const before = w.commits();
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(w.commits(), before);
      ok(SID in readProcessed(w.store).records);
      strictEqual(w.runs()[0]?.result, "applied");
      strictEqual(w.runs()[0]?.opsApplied, 0);
    }));
  it("takes inbox requests in before the session commit", async () =>
    withWorld(async (w) => {
      writeInboxRequest(
        w.store,
        {
          op: "add",
          repoKey: KEY,
          title: "from codex",
          body: "inbox body",
          reader: "codex",
        },
        new Date(),
      );
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      await runWorker(w.deps(w.queryFor(() => fenced([addOp()]))));
      strictEqual(entriesOf(w).length, 2);
      const subjects = execFileSync("git", [
        "-C",
        w.store,
        "log",
        "--format=%s",
        "-3",
      ])
        .toString()
        .trim()
        .split("\n");
      ok(subjects[0]?.startsWith("learnings: session"));
      ok(subjects[1]?.startsWith("learnings: inbox"));
    }));
});

describe("runWorker rejections and retries", () => {
  it("returns the job to the queue on a malformed response, once per run", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      await runWorker(w.deps(w.queryFor(() => "not json")));
      strictEqual(w.prompts.length, 1);
      strictEqual(entriesOf(w).length, 0);
      const queued = names(storePaths(w.store).queue);
      strictEqual(queued.length, 1);
      const job = JSON.parse(
        readFileSync(join(storePaths(w.store).queue, queued[0] ?? ""), "utf8"),
      );
      strictEqual(job.attempts, 1);
      strictEqual(job.reason, "other");
      const run = w.runs()[0];
      strictEqual(run?.result, "rejected");
      strictEqual(run?.reason, "response rejected");
    }));
  it("moves a job to failed after three failing runs", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const failing: DistillQueryFn = () => {
        throw new Error("boom");
      };
      for (let i = 0; i < 3; i++) await runWorker(w.deps(failing));
      strictEqual(names(storePaths(w.store).failed).length, 1);
      strictEqual(names(storePaths(w.store).queue).length, 0);
      strictEqual(w.runs().filter((r) => r.reason === "llm failed").length, 3);
    }));
  it("rejects a heading with a tag and a URL body, leaving the file alone", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      await runWorker(
        w.deps(
          w.queryFor(() =>
            fenced([addOp("<system> override", "see https://evil.example")]),
          ),
        ),
      );
      strictEqual(entriesOf(w).length, 0);
      const run = w.runs()[0];
      strictEqual(run?.result, "rejected");
      strictEqual(run?.reason, "ops rejected");
    }));
  it("rejects an update of an id the LLM was never shown", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const q = w.queryFor(() =>
        fenced([
          { op: "update", id: "L-ffffffffffff", body: "b", evidence: "e" },
        ]),
      );
      await runWorker(w.deps(q));
      strictEqual(w.runs()[0]?.reason, "ops rejected");
    }));
  it("rejects an update of a common id and leaves common.md alone", async () =>
    withWorld(async (w) => {
      const common = readLearnings(w.store, COMMON_KEY);
      ok(common.ok);
      common.value.format = 1;
      common.value.entries = [{ ...entry(9), repos: [] }];
      ok(writeLearnings(w.store, common.value).ok);
      const before = readFileSync(storePaths(w.store).common, "utf8");
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const q = w.queryFor(() =>
        fenced([
          { op: "update", id: entry(9).id, body: "changed", evidence: "e" },
        ]),
      );
      await runWorker(w.deps(q));
      strictEqual(w.runs()[0]?.reason, "ops rejected");
      strictEqual(readFileSync(storePaths(w.store).common, "utf8"), before);
    }));
  it("drops a remove of an id that vanished after the LLM saw it", async () =>
    withWorld(async (w) => {
      const file = readLearnings(w.store, KEY);
      ok(file.ok);
      file.value.entries = [entry(1)];
      ok(writeLearnings(w.store, file.value).ok);
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const q = w.queryFor(() => {
        const current = readLearnings(w.store, KEY);
        ok(current.ok);
        current.value.entries = [];
        writeLearnings(w.store, current.value);
        return fenced([
          { op: "remove", id: entry(1).id, reason: "wrong" },
          addOp(),
        ]);
      });
      await runWorker(w.deps(q));
      strictEqual(entriesOf(w).length, 1);
      strictEqual(w.runs()[0]?.opsDropped, 1);
      strictEqual(w.runs()[0]?.opsApplied, 1);
    }));
  it("completes with opsApplied 0 when the only op was dropped", async () =>
    withWorld(async (w) => {
      const file = readLearnings(w.store, KEY);
      ok(file.ok);
      file.value.entries = [entry(1)];
      ok(writeLearnings(w.store, file.value).ok);
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const q = w.queryFor(() => {
        const current = readLearnings(w.store, KEY);
        ok(current.ok);
        current.value.entries = [];
        writeLearnings(w.store, current.value);
        return fenced([{ op: "remove", id: entry(1).id, reason: "wrong" }]);
      });
      await runWorker(w.deps(q));
      const run = w.runs()[0];
      strictEqual(run?.result, "applied");
      strictEqual(run?.opsDropped, 1);
      strictEqual(run?.opsApplied, 0);
      strictEqual(names(storePaths(w.store).failed).length, 0);
    }));
});

describe("runWorker job validation", () => {
  it("rejects a transcript named for another session", async () =>
    withWorld(async (w) => {
      const other = sidN(2);
      w.writeTranscript(utterances("x", 3), other);
      enqueueJob(
        w.store,
        {
          sessionId: SID,
          transcriptPath: w.transcriptPath(other),
          cwd: w.repo,
          repoKey: KEY,
          reason: "r",
        },
        new Date(),
      );
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(w.prompts.length, 0);
      strictEqual(w.runs()[0]?.reason, "session mismatch");
      strictEqual(w.runs()[0]?.result, "failed");
    }));
  it("rejects a transcript outside ~/.claude/projects", async () =>
    withWorld(async (w) => {
      const outside = join(w.root, `${SID}.jsonl`);
      writeFileSync(outside, `${utterances("x", 3).join("\n")}\n`);
      enqueueJob(
        w.store,
        {
          sessionId: SID,
          transcriptPath: outside,
          cwd: w.repo,
          repoKey: KEY,
          reason: "r",
        },
        new Date(),
      );
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(w.prompts.length, 0);
      strictEqual(w.runs()[0]?.reason, "transcript outside projects");
    }));
  it("records a missing transcript as unreadable without the path", async () =>
    withWorld(async (w) => {
      w.enqueue();
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(w.prompts.length, 0);
      strictEqual(w.runs()[0]?.reason, "transcript unreadable");
      strictEqual(w.runs()[0]?.result, "failed");
    }));
  it("rejects a job whose cwd resolves to another repo key", async () =>
    withWorld(async (w) => {
      execFileSync("git", [
        "-C",
        w.repo,
        "remote",
        "set-url",
        "origin",
        "https://github.com/x/y.git",
      ]);
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(w.prompts.length, 0);
      strictEqual(w.runs()[0]?.reason, "repo mismatch");
    }));
  it("uses the enqueued repo key when the cwd no longer exists", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      enqueueJob(
        w.store,
        {
          sessionId: SID,
          transcriptPath: w.transcriptPath(),
          cwd: join(w.root, "gone"),
          repoKey: KEY,
          reason: "r",
        },
        new Date(),
      );
      await runWorker(w.deps(w.queryFor(() => fenced([addOp()]))));
      strictEqual(entriesOf(w).length, 1);
    }));
  it("sends a repo file in a newer format straight to failed without calling the LLM", async () =>
    withWorld(async (w) => {
      writeFileSync(
        repoFilePath(w.store, KEY),
        `<!-- agent-learnings format: 2; key: ${KEY} -->\n\n# Learnings: ${KEY}\n`,
      );
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(w.prompts.length, 0);
      strictEqual(names(storePaths(w.store).failed).length, 1);
      const failed = JSON.parse(
        readFileSync(join(storePaths(w.store).failed, `${SID}.json`), "utf8"),
      );
      strictEqual(failed.attempts, 0);
      strictEqual(w.runs()[0]?.reason, "learnings file unreadable");
    }));
});

describe("runWorker locking and re-enqueue", () => {
  it("releases the job without using an attempt when the store lock is busy", async () =>
    withWorld(async (w) => {
      writeFileSync(
        join(storePaths(w.store).state, "lock"),
        `${process.pid} ${Date.now()}`,
      );
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      await runWorker(w.deps(w.queryFor(() => fenced([addOp()]))));
      const job = JSON.parse(
        readFileSync(join(storePaths(w.store).queue, `${SID}.json`), "utf8"),
      );
      strictEqual(job.attempts, 0);
      strictEqual(w.runs()[0]?.reason, "lock busy");
      strictEqual(w.runs()[0]?.result, "skipped");
      strictEqual(entriesOf(w).length, 0);
    }));
  it("holds no store lock while the LLM runs", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      let acquired = false;
      const q = w.queryFor(async () => {
        const r = await withStoreLock(
          storePaths(w.store).state,
          { waitMs: 0 },
          () => true,
        );
        acquired = r.ok;
        return fenced([]);
      });
      await runWorker(w.deps(q));
      ok(acquired);
    }));
  it("re-enqueues the session when the transcript grew during processing", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const q = w.queryFor(() => {
        appendFileSync(w.transcriptPath(), `${user("more")}\n`);
        return fenced([]);
      });
      await runWorker(w.deps(q));
      deepNames(names(storePaths(w.store).queue), [`${SID}.json`]);
    }));
  it("re-enqueues a compact job with the same reason when the transcript grew", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue(SID, "compact");
      const q = w.queryFor(() => {
        appendFileSync(w.transcriptPath(), `${user("more")}\n`);
        return fenced([]);
      });
      await runWorker(w.deps(q));
      const queued = JSON.parse(
        readFileSync(join(storePaths(w.store).queue, `${SID}.json`), "utf8"),
      );
      strictEqual(queued.reason, "compact");
    }));
  it("does not re-enqueue for an unterminated trailing line that did not change", async () =>
    withWorld(async (w) => {
      writeFileSync(
        w.transcriptPath(),
        `${utterances("x", 3).join("\n")}\n${user("half written")}`,
      );
      w.enqueue();
      const q = w.queryFor(() => fenced([]));
      await runWorker(w.deps(q));
      strictEqual(names(storePaths(w.store).queue).length, 0);
      await runWorker(w.deps(q));
      strictEqual(w.prompts.length, 1);
    }));
  it("does not re-enqueue after a rejected response even if the transcript grew", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const q = w.queryFor(() => {
        appendFileSync(w.transcriptPath(), `${user("more")}\n`);
        return "not json";
      });
      await runWorker(w.deps(q));
      const job = JSON.parse(
        readFileSync(join(storePaths(w.store).queue, `${SID}.json`), "utf8"),
      );
      strictEqual(job.attempts, 1); // 失敗で戻した 1 件だけ。別のジョブは増えない
      strictEqual(names(storePaths(w.store).queue).length, 1);
    }));
  it("treats a corrupt processed.json as empty and logs one reset line", async () =>
    withWorld(async (w) => {
      writeFileSync(storePaths(w.store).processed, "{broken");
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(
        w.runs().filter((r) => r.reason === "processed reset").length,
        1,
      );
      strictEqual(
        w.runs().find((r) => r.reason === "processed reset")?.result,
        "skipped",
      );
      ok(w.prompts[0]?.includes("x1"));
    }));
});

describe("runWorker batch and single-instance", () => {
  it("handles at most 10 jobs per start", async () =>
    withWorld(async (w) => {
      for (let n = 1; n <= 12; n++) {
        w.writeTranscript(utterances("x", 1), sidN(n));
        w.enqueue(sidN(n));
      }
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(names(storePaths(w.store).queue).length, 2);
      strictEqual(w.runs().length, 10);
    }));
  it("skips at once while another live process holds worker.lock", async () =>
    withWorld(async (w) => {
      writeFileSync(
        join(storePaths(w.store).state, "worker.lock"),
        `${process.pid} ${Date.now()}`,
      );
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const result = await runWorker(w.deps(w.queryFor(() => fenced([]))));
      strictEqual(result.status, "skipped");
      strictEqual(w.prompts.length, 0);
      strictEqual(w.runs().length, 0);
      strictEqual(names(storePaths(w.store).queue).length, 1);
    }));
  it("refreshes worker.lock for each job so a running worker is not taken over", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3), sidN(1));
      w.writeTranscript(utterances("y", 3), sidN(2));
      w.enqueue(sidN(1));
      w.enqueue(sidN(2));
      const lock = storePaths(w.store).workerLock;
      const statuses: string[] = [];
      const ages: number[] = [];
      const q = w.queryFor(async (call) => {
        if (call === 0) {
          const old = new Date(Date.now() - 29 * 60_000);
          utimesSync(lock, old, old);
        } else {
          ages.push(Date.now() - statSync(lock).mtimeMs);
        }
        const second = await runWorker(w.deps(w.queryFor(() => fenced([]))));
        statuses.push(second.status);
        return fenced([]);
      });
      await runWorker(w.deps(q));
      ok(
        statuses.every((s) => s === "skipped"),
        statuses.join(),
      );
      strictEqual(ages.length, 1);
    }));
  it("does nothing in a worker session", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3));
      w.enqueue();
      const result = await runWorker(
        w.deps(
          w.queryFor(() => fenced([])),
          { env: { AGENT_LEARNINGS_WORKER: "1" } },
        ),
      );
      strictEqual(result.status, "worker-session");
      strictEqual(w.prompts.length, 0);
      strictEqual(names(storePaths(w.store).queue).length, 1);
    }));
  it("rotates the three logs over 1MB at the end of a run", async () =>
    withWorld(async (w) => {
      const paths = storePaths(w.store);
      for (const path of [paths.runsLog, paths.readsLog, paths.codexReadsLog]) {
        writeFileSync(path, "");
        truncateSync(path, 1024 * 1024 + 1);
      }
      await runWorker(w.deps(w.queryFor(() => fenced([]))));
      for (const path of [paths.runsLog, paths.readsLog, paths.codexReadsLog])
        ok(existsSync(`${path}.1`), path);
    }));
});

describe("runWorker promotion", () => {
  const OTHER = "github.com/org-a/alpha-service";
  const PTITLE = "Avoid overwriting files with cp";
  const PBODY =
    "Pass the update=none flag to cp so existing files are never overwritten.";
  const sharedEntry = (n: number, over: Partial<LearningEntry> = {}) => ({
    ...entry(n),
    title: PTITLE,
    body: PBODY,
    seen: 2,
    repos: [OTHER],
    ...over,
  });
  const X = sharedEntry(0x71);
  const promoteOp = (over: Record<string, unknown> = {}) => ({
    op: "promote",
    matchId: X.id,
    title: PTITLE,
    body: PBODY,
    evidence: "the same cp fix came up again",
    ...over,
  });
  const putFile = (w: World, key: string, entries: LearningEntry[]): void => {
    ok(
      writeLearnings(w.store, { format: 1, key, readOnly: false, entries }).ok,
    );
  };
  const run = async (
    w: World,
    respond: (call: number, prompt: string) => string | Promise<string>,
  ) => {
    w.writeTranscript(utterances("x", 3));
    w.enqueue();
    return runWorker(w.deps(w.queryFor(respond)));
  };
  const lastCommit = (w: World): string =>
    execFileSync("git", ["-C", w.store, "log", "-1", "--format=%B"]).toString();

  it("promotes a learning from another repo into common.md in one commit", async () =>
    withWorld(async (w) => {
      putFile(w, OTHER, [X]);
      const before = w.commits();
      await run(w, () => fenced([promoteOp()]));
      const common = entriesOf(w, COMMON_KEY);
      strictEqual(common.length, 1);
      strictEqual(common[0]?.title, PTITLE);
      strictEqual(common[0]?.seen, 3);
      strictEqual(entriesOf(w, OTHER).length, 0);
      strictEqual(w.commits(), before + 1);
      ok(
        lastCommit(w).includes(
          `promote ${common[0]?.id} <- ${X.id} (${OTHER})`,
        ),
      );
      strictEqual(w.runs()[0]?.result, "applied");
      strictEqual(w.runs()[0]?.opsApplied, 1);
      ok(w.prompts[0]?.includes(X.id));
      ok(!w.prompts[0]?.includes(OTHER), "the candidate list names no repo");
    }));
  it("commits an add and a promote together and counts both", async () =>
    withWorld(async (w) => {
      putFile(w, OTHER, [X]);
      const before = w.commits();
      await run(w, () => fenced([addOp(), promoteOp()]));
      strictEqual(entriesOf(w).length, 1);
      strictEqual(entriesOf(w, COMMON_KEY).length, 1);
      strictEqual(w.commits(), before + 1);
      strictEqual(w.runs()[0]?.opsApplied, 2);
      const message = lastCommit(w);
      ok(message.includes("add L-") && message.includes("promote L-"));
    }));
  it("neither shows nor accepts candidates from a repo that matches no-promote", async () =>
    withWorld(async (w) => {
      writeFileSync(
        join(w.store, "no-promote"),
        "local/*\ngithub.com/org-a/*\n",
      );
      putFile(w, OTHER, [X]);
      await run(w, () => fenced([promoteOp()]));
      ok(!w.prompts[0]?.includes(X.id));
      strictEqual(w.runs()[0]?.reason, "ops rejected");
      strictEqual(entriesOf(w, OTHER).length, 1);
      strictEqual(entriesOf(w, COMMON_KEY).length, 0);
    }));
  it("stops every promotion when no-promote is unreadable but still applies adds", async () =>
    withWorld(async (w) => {
      writeFileSync(join(w.store, "no-promote"), "x/*\n".repeat(300));
      putFile(w, OTHER, [X]);
      await run(w, () => fenced([addOp()]));
      ok(!w.prompts[0]?.includes(X.id));
      strictEqual(entriesOf(w).length, 1);
      strictEqual(w.runs()[0]?.result, "applied");
    }));
  it("rejects the whole response when a promote leaks a repo name, so the add is not written either", async () =>
    withWorld(async (w) => {
      putFile(w, OTHER, [X]);
      const before = w.commits();
      await run(w, () =>
        fenced([
          addOp(),
          promoteOp({ body: `${PBODY} Seen in alpha-service.` }),
        ]),
      );
      strictEqual(w.runs()[0]?.reason, "ops rejected");
      strictEqual(entriesOf(w).length, 0);
      strictEqual(entriesOf(w, OTHER).length, 1);
      strictEqual(w.commits(), before);
    }));
  it("rejects a remove of a candidate id", async () =>
    withWorld(async (w) => {
      putFile(w, OTHER, [X]);
      await run(w, () => fenced([{ op: "remove", id: X.id, reason: "wrong" }]));
      strictEqual(w.runs()[0]?.reason, "ops rejected");
      strictEqual(entriesOf(w, OTHER).length, 1);
    }));
  it("drops a promote whose source a human removed while the LLM was running", async () =>
    withWorld(async (w) => {
      putFile(w, OTHER, [X]);
      await run(w, () => {
        putFile(w, OTHER, []);
        return fenced([promoteOp()]);
      });
      const last = w.runs()[0];
      strictEqual(last?.result, "applied");
      strictEqual(last?.opsDropped, 1);
      strictEqual(last?.opsApplied, 0);
      strictEqual(entriesOf(w, COMMON_KEY).length, 0);
      strictEqual(names(storePaths(w.store).queue).length, 0);
    }));
  it("drops a promote whose own entry was evicted by the same response's add", async () =>
    withWorld(async (w) => {
      const full = Array.from({ length: 40 }, (_, i) => ({
        ...entry(0x100 + i),
        seen: 5,
      }));
      const oldest = { ...entry(0x100), seen: 1, updated: "2026-01-01" };
      full[0] = oldest;
      putFile(w, KEY, full);
      putFile(w, OTHER, [X]);
      await run(w, () => fenced([addOp(), promoteOp({ id: oldest.id })]));
      const last = w.runs()[0];
      strictEqual(last?.result, "applied");
      strictEqual(last?.opsApplied, 1);
      strictEqual(last?.opsDropped, 1);
      ok(!entriesOf(w).some((e) => e.id === oldest.id));
      strictEqual(entriesOf(w).length, 40);
      strictEqual(entriesOf(w, OTHER).length, 1);
      strictEqual(entriesOf(w, COMMON_KEY).length, 0);
    }));
  it("ignores other-repo files in a newer format or whose key does not match the file name", async () =>
    withWorld(async (w) => {
      const repos = storePaths(w.store).repos;
      writeFileSync(
        join(repos, "future.md"),
        "<!-- agent-learnings format: 2; key: github.com/x/y -->\n\n# Learnings: github.com/x/y\n",
      );
      writeFileSync(
        join(repos, "wrong-name.md"),
        serializeLearningsFile({
          format: 1,
          key: OTHER,
          readOnly: false,
          entries: [X],
        }),
      );
      const result = await run(w, () => fenced([]));
      strictEqual(result.status, "done");
      ok(!w.prompts[0]?.includes(X.id));
      strictEqual(w.runs()[0]?.result, "applied");
    }));
});

function deepNames(actual: string[], expected: string[]): void {
  strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}
