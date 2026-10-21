import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  runLearningsCli,
  type RunLearningsCliDeps,
} from "../../cli/learnings.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import { parseLearningsFile } from "../../lib/agent-learnings/core/learnings-file.ts";
import { writeInboxRequest } from "../../lib/agent-learnings/core/inbox.ts";
import {
  appendRunLog,
  enqueueJob,
} from "../../lib/agent-learnings/core/queue.ts";

async function withEnv(
  fn: (deps: RunLearningsCliDeps, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "agent-learnings-cli-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/foo/bar.git",
  ]);
  mkdirSync(join(root, "home"));
  const deps: RunLearningsCliDeps = {
    cwd: repo,
    home: join(root, "home"),
    now: new Date("2026-10-15T00:00:00Z"),
    readerEnv: undefined,
    isTty: true,
    agentEnv: false,
    lockWaitMs: 200,
    runGit,
    confirm: async () => true,
  };
  try {
    await fn(deps, root);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}
const store = (deps: RunLearningsCliDeps) =>
  join(deps.home, ".local/share/agent-learnings");

describe("runLearningsCli", () => {
  it("show prints nothing and exits 0 before init", () =>
    withEnv(async (deps) => {
      const r = await runLearningsCli(["show"], deps);
      strictEqual(r.exitCode, 0);
      strictEqual(r.stdout, "");
    }));
  it("add prints an id, show renders it, reads.log records the reader", () =>
    withEnv(async (deps) => {
      strictEqual((await runLearningsCli(["init"], deps)).exitCode, 0);
      const add = await runLearningsCli(
        ["add", "--title", "t", "--body=b を使う"],
        deps,
      );
      strictEqual(add.exitCode, 0);
      ok(/^L-[0-9a-f]{12}\n$/.test(add.stdout));
      const show = await runLearningsCli(["show", "--reader", "codex"], deps);
      ok(show.stdout.includes("b を使う"));
      ok(
        readFileSync(
          join(store(deps), ".state/codex/reads.log"),
          "utf8",
        ).includes('"reader":"codex"'),
      );
      const log = execFileSync("git", [
        "-C",
        store(deps),
        "log",
        "-1",
        "--format=%B",
      ]).toString();
      ok(log.includes(`add ${add.stdout.trim()}: manual add`));
    }));
  it(
    "show --cwd reads another repo, and still exits 0 when reads.log cannot be written",
    { skip: process.getuid?.() === 0 },
    () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        await runLearningsCli(["add", "--title", "t", "--body", "b"], deps);
        chmodSync(join(store(deps), ".state"), 0o500);
        const r = await runLearningsCli(["show", "--cwd", deps.cwd], {
          ...deps,
          cwd: deps.home,
        });
        chmodSync(join(store(deps), ".state"), 0o700);
        strictEqual(r.exitCode, 0);
        ok(r.stdout.includes("b"));
      }),
  );
  it("add rejects invalid text with exit 1, remove unknown id exits 1", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      strictEqual(
        (await runLearningsCli(["add", "--title", "#x", "--body", "b"], deps))
          .exitCode,
        1,
      );
      strictEqual(
        (await runLearningsCli(["remove", "L-ffffffffffff"], deps)).exitCode,
        1,
      );
    }));
  it("agents without a TTY cannot use --common, URLs, rekey or init", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      const agent = { ...deps, isTty: false };
      strictEqual(
        (
          await runLearningsCli(
            ["add", "--common", "--title", "c", "--body", "b"],
            agent,
          )
        ).exitCode,
        1,
      );
      strictEqual(
        (
          await runLearningsCli(
            ["add", "--title", "u", "--body", "https://e.com"],
            agent,
          )
        ).exitCode,
        1,
      );
      strictEqual(
        (
          await runLearningsCli(
            ["rekey", "github.com/foo/bar", "github.com/foo/baz"],
            agent,
          )
        ).exitCode,
        1,
      );
      strictEqual((await runLearningsCli(["init"], agent)).exitCode, 1);
      strictEqual(
        (await runLearningsCli(["add", "--title", "a", "--body", "ok"], agent))
          .exitCode,
        0,
      );
    }));
  it("remove finds ids in common.md too", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      const id = (
        await runLearningsCli(
          ["add", "--common", "--title", "c", "--body", "b"],
          deps,
        )
      ).stdout.trim();
      strictEqual((await runLearningsCli(["remove", id], deps)).exitCode, 0);
    }));
  it("add and remove refuse a read-only file with exit 1", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      const path = (await runLearningsCli(["path"], deps)).stdout.trim();
      writeFileSync(
        path,
        "<!-- agent-learnings format: 2; key: github.com/foo/bar -->\n",
      );
      strictEqual(
        (await runLearningsCli(["add", "--title", "t", "--body", "b"], deps))
          .exitCode,
        1,
      );
    }));
  it("returns 2 when the lock is held by a live process", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      writeFileSync(
        join(store(deps), ".state/lock"),
        `${process.pid} ${Date.now()}`,
      );
      strictEqual(
        (await runLearningsCli(["add", "--title", "t", "--body", "b"], deps))
          .exitCode,
        2,
      );
    }));
  it("applies a pending inbox request on the next add without waiting on its own lock", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      writeInboxRequest(
        store(deps),
        {
          op: "add",
          repoKey: "github.com/foo/bar",
          title: "from inbox",
          body: "b",
          reader: "codex",
        },
        new Date(),
      );
      const started = Date.now();
      strictEqual(
        (
          await runLearningsCli(["add", "--title", "t", "--body", "b"], {
            ...deps,
            lockWaitMs: 10_000,
          })
        ).exitCode,
        0,
      );
      ok(Date.now() - started < 3_000);
      ok((await runLearningsCli(["show"], deps)).stdout.includes("from inbox"));
    }));
  it("refuses add and remove on a read-only file, add outside a repo, and allows add --common outside a repo for a human", () =>
    withEnv(async (deps, root) => {
      await runLearningsCli(["init"], deps);
      const id = (
        await runLearningsCli(["add", "--title", "t", "--body", "b"], deps)
      ).stdout.trim();
      const path = (await runLearningsCli(["path"], deps)).stdout.trim();
      writeFileSync(
        path,
        "<!-- agent-learnings format: 2; key: github.com/foo/bar -->\n",
      );
      strictEqual(
        (await runLearningsCli(["add", "--title", "t2", "--body", "b"], deps))
          .exitCode,
        1,
      );
      strictEqual((await runLearningsCli(["remove", id], deps)).exitCode, 1);
      mkdirSync(join(root, "plain"));
      const outside = { ...deps, cwd: join(root, "plain") };
      strictEqual(
        (await runLearningsCli(["add", "--title", "t", "--body", "b"], outside))
          .exitCode,
        1,
      );
      const commonId = (
        await runLearningsCli(
          ["add", "--common", "--title", "c", "--body", "b"],
          outside,
        )
      ).stdout.trim();
      ok(/^L-[0-9a-f]{12}$/.test(commonId));
      ok((await runLearningsCli(["show"], deps)).stdout.includes("c: b"));
      strictEqual(
        (await runLearningsCli(["remove", commonId], outside)).exitCode,
        0,
      );
    }));
  it("rejects human-only operations when an agent environment variable is present, even with a TTY", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      const agentWithPty = { ...deps, isTty: true, agentEnv: true };
      strictEqual(
        (
          await runLearningsCli(
            ["add", "--common", "--title", "c", "--body", "b"],
            agentWithPty,
          )
        ).exitCode,
        1,
      );
    }));
  it(
    "falls back to the inbox when the store is not writable",
    { skip: process.getuid?.() === 0 },
    () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        chmodSync(join(store(deps), ".state"), 0o500);
        chmodSync(join(store(deps), ".state/codex"), 0o700);
        const r = await runLearningsCli(
          ["add", "--title", "t", "--body", "b"],
          { ...deps, isTty: false },
        );
        chmodSync(join(store(deps), ".state"), 0o700);
        strictEqual(r.exitCode, 0);
        ok(/^R-[0-9a-f]{12}\n$/.test(r.stdout));
      }),
  );
  it("path succeeds in a repo and exits 1 in a non-git directory", () =>
    withEnv(async (deps, root) => {
      strictEqual((await runLearningsCli(["path"], deps)).exitCode, 0);
      mkdirSync(join(root, "plain"));
      strictEqual(
        (await runLearningsCli(["path"], { ...deps, cwd: join(root, "plain") }))
          .exitCode,
        1,
      );
    }));
  it("status reports inbox, unpushed and reader counts", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      await runLearningsCli(["show", "--reader", "codex"], deps);
      const r = await runLearningsCli(["status"], deps);
      strictEqual(r.exitCode, 0);
      ok(r.stdout.includes("inbox: 0"));
      ok(r.stdout.includes("codex: 1"));
      ok(r.stdout.includes("remote"));
    }));
  it("rekey moves the file and rewrites keys everywhere, refusing an existing target", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      await runLearningsCli(["add", "--title", "t", "--body", "b"], deps);
      // common.md に旧キーを repos に持つ項目を置く（plan-3 の昇格で起きる形を手で作る）
      writeFileSync(
        join(store(deps), "common.md"),
        "<!-- agent-learnings format: 1; key: common -->\n\n# Learnings: common\n\n## c\n<!-- id: L-0000000000c1; seen: 2; repos: github.com/foo/bar,github.com/x/y; updated: 2026-10-01 -->\nbody\n",
      );
      const r = await runLearningsCli(
        ["rekey", "github.com/foo/bar", "github.com/foo/baz"],
        deps,
      );
      strictEqual(r.exitCode, 0);
      const moved = readFileSync(r.stdout.trim(), "utf8");
      ok(
        moved.includes("key: github.com/foo/baz") &&
          moved.includes("# Learnings: github.com/foo/baz"),
      );
      ok(moved.includes("repos: github.com/foo/baz;"));
      const common = readFileSync(join(store(deps), "common.md"), "utf8");
      ok(!common.includes("github.com/foo/bar"));
      strictEqual(
        (
          await runLearningsCli(
            ["rekey", "github.com/foo/baz", "github.com/foo/baz"],
            deps,
          )
        ).exitCode,
        1,
      );
    }));
  it("rekey says which key is wrong and what shape a key has", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      await runLearningsCli(["add", "--title", "t", "--body", "b"], deps);
      const usage = await runLearningsCli(["rekey"], deps);
      ok(usage.stderr.includes("host/owner/repo"));

      // `path` prints a file name; passing it back is the likely mistake
      const path = (await runLearningsCli(["path"], deps)).stdout.trim();
      const fileName = await runLearningsCli(
        ["rekey", path.slice(path.lastIndexOf("/") + 1), "github.com/foo/baz"],
        deps,
      );
      strictEqual(fileName.exitCode, 1);
      ok(fileName.stderr.includes("<old>"));
      ok(fileName.stderr.includes("ファイル名"));
      ok(fileName.stderr.includes("github.com/foo/bar"));

      const badNew = await runLearningsCli(
        ["rekey", "github.com/foo/bar", "baz"],
        deps,
      );
      strictEqual(badNew.exitCode, 1);
      ok(badNew.stderr.includes("<new>"));
      ok(badNew.stderr.includes("host/owner/repo"));

      const same = await runLearningsCli(
        ["rekey", "github.com/foo/bar", "github.com/foo/bar"],
        deps,
      );
      strictEqual(same.exitCode, 1);
      ok(same.stderr.includes("同じ"));
    }));
  it("status reports queue counts and the worker's recent results", () =>
    withEnv(async (deps) => {
      strictEqual((await runLearningsCli(["init"], deps)).exitCode, 0);
      const sessionId = "0f0e0d0c-0000-4000-8000-000000000001";
      enqueueJob(
        store(deps),
        {
          sessionId,
          transcriptPath: "/t.jsonl",
          cwd: "/c",
          repoKey: "github.com/foo/bar",
          reason: "other",
        },
        deps.now,
      );
      appendRunLog(store(deps), {
        schemaVersion: 1,
        at: "2026-10-14T00:00:00.000Z",
        sessionId,
        result: "rejected",
        opsApplied: 0,
        opsDropped: 0,
        reason: "response rejected",
      });
      const r = await runLearningsCli(["status"], deps);
      strictEqual(r.exitCode, 0);
      ok(r.stdout.includes("queue: 1"), r.stdout);
      ok(r.stdout.includes("rejected 1"), r.stdout);
    }));

  describe("promote", () => {
    const addOne = async (
      deps: RunLearningsCliDeps,
      body = "update=none keeps files",
    ): Promise<string> =>
      (
        await runLearningsCli(
          ["add", "--title", "cp flag", "--body", body],
          deps,
        )
      ).stdout.trim();
    const entryIds = (path: string): string[] => {
      const parsed = parseLearningsFile(readFileSync(path, "utf8"));
      return parsed.ok ? parsed.value.entries.map((e) => e.id) : [];
    };
    const paths = async (deps: RunLearningsCliDeps) => ({
      repo: (await runLearningsCli(["path"], deps)).stdout.trim(),
      common: (await runLearningsCli(["path", "--common"], deps)).stdout.trim(),
    });

    it("moves a repo entry to common.md after a y confirmation and commits once", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        const id = await addOne(deps);
        const messages: string[] = [];
        const r = await runLearningsCli(["promote", id], {
          ...deps,
          confirm: async (message) => {
            messages.push(message);
            return true;
          },
        });
        strictEqual(r.exitCode, 0);
        ok(/^L-[0-9a-f]{12}\n$/.test(r.stdout));
        const commonId = r.stdout.trim();
        const p = await paths(deps);
        deepStrictEqual(entryIds(p.repo), []);
        deepStrictEqual(entryIds(p.common), [commonId]);
        strictEqual(messages.length, 1);
        ok(messages[0]?.includes("update=none keeps files"));
        const log = execFileSync("git", [
          "-C",
          store(deps),
          "log",
          "-1",
          "--format=%s",
        ])
          .toString()
          .trim();
        strictEqual(
          log,
          `learnings: promote ${id} -> ${commonId} (github.com/foo/bar)`,
        );
      }));
    it("warns about a repo name part in the text but still asks", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        const id = await addOne(deps, "this is what we do in foo");
        const messages: string[] = [];
        const r = await runLearningsCli(["promote", id], {
          ...deps,
          confirm: async (message) => {
            messages.push(message);
            return true;
          },
        });
        strictEqual(r.exitCode, 0);
        ok(messages[0]?.includes("repo 名"));
      }));
    it("changes nothing and exits 1 when the answer is not y", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        const id = await addOne(deps);
        const head = execFileSync("git", [
          "-C",
          store(deps),
          "rev-parse",
          "HEAD",
        ]).toString();
        const r = await runLearningsCli(["promote", id], {
          ...deps,
          confirm: async () => false,
        });
        strictEqual(r.exitCode, 1);
        deepStrictEqual(entryIds((await paths(deps)).repo), [id]);
        strictEqual(
          execFileSync("git", [
            "-C",
            store(deps),
            "rev-parse",
            "HEAD",
          ]).toString(),
          head,
        );
      }));
    it("is human-only: no TTY or an agent environment exits 1 without asking", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        const id = await addOne(deps);
        let asked = 0;
        const confirm = async () => {
          asked += 1;
          return true;
        };
        for (const over of [{ isTty: false }, { agentEnv: true }]) {
          const r = await runLearningsCli(["promote", id], {
            ...deps,
            ...over,
            confirm,
          });
          strictEqual(r.exitCode, 1);
        }
        strictEqual(asked, 0);
        deepStrictEqual(entryIds((await paths(deps)).repo), [id]);
      }));
    it("exits 1 for an unknown id and for an id that lives in common.md", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        const commonId = (
          await runLearningsCli(
            ["add", "--common", "--title", "c", "--body", "b"],
            deps,
          )
        ).stdout.trim();
        strictEqual(
          (await runLearningsCli(["promote", "L-ffffffffffff"], deps)).exitCode,
          1,
        );
        strictEqual(
          (await runLearningsCli(["promote", commonId], deps)).exitCode,
          1,
        );
        strictEqual(
          (await runLearningsCli(["promote", "R-1"], deps)).exitCode,
          1,
        );
      }));
    it("exits 1 when the current repo matches no-promote", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        const id = await addOne(deps);
        writeFileSync(
          join(store(deps), "no-promote"),
          "local/*\ngithub.com/foo/*\n",
        );
        const r = await runLearningsCli(["promote", id], deps);
        strictEqual(r.exitCode, 1);
        deepStrictEqual(entryIds((await paths(deps)).repo), [id]);
      }));
    it("exits 2 when a live process holds the lock", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        const id = await addOne(deps);
        writeFileSync(
          join(store(deps), ".state/lock"),
          `${process.pid} ${Date.now()}`,
        );
        strictEqual((await runLearningsCli(["promote", id], deps)).exitCode, 2);
      }));
    it("status says promotion is stopped when no-promote is oversized", () =>
      withEnv(async (deps) => {
        await runLearningsCli(["init"], deps);
        writeFileSync(
          join(store(deps), "no-promote"),
          `# ${"x".repeat(17 * 1024)}`,
        );
        const r = await runLearningsCli(["status"], deps);
        strictEqual(r.exitCode, 0);
        ok(
          r.stdout
            .split("\n")
            .some(
              (l) => l.startsWith("no-promote:") && l.includes("昇格しない"),
            ),
        );
        writeFileSync(join(store(deps), "no-promote"), "local/*\n");
        ok(
          !(await runLearningsCli(["status"], deps)).stdout.includes(
            "no-promote:",
          ),
        );
      }));
  });
});
