import { ok, strictEqual } from "node:assert";
import {
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { runLearningsCli } from "../../cli/learnings.ts";
import { runWorker } from "../../../scripts/learnings-worker.ts";
import { buildSessionLearningsContext } from "../../lib/agent-learnings/claude/session-context.ts";
import { writeInboxRequest } from "../../lib/agent-learnings/core/inbox.ts";
import { enqueueJob } from "../../lib/agent-learnings/core/queue.ts";
import {
  defaultStoreDir,
  ensureStateDirs,
  readLearnings,
  storePaths,
} from "../../lib/agent-learnings/core/store.ts";
import type { RunGit } from "../../lib/agent-learnings/core/git.ts";
import * as redact from "../../lib/redact-secrets.ts";

const KEY = "github.com/a/b";
const NOW = new Date("2026-10-22T00:00:00Z");
const secret = "machine-private-marker";
const runGit: RunGit = (args) => ({
  ok: true,
  stdout:
    args[0] === "config" ? "https://github.com/a/b.git" : "/work/repo/.git",
});

for (const path of ["CLI add", "worker", "SessionStart"] as const) {
  it(`loads a temporary extra redact pattern through ${path}`, async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "redact-callers-")));
    try {
      const store = defaultStoreDir(home);
      mkdirSync(join(store, ".git"), { recursive: true });
      mkdirSync(join(store, "repos"));
      ensureStateDirs(store);
      mkdirSync(storePaths(store).inbox, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      const redactPath = join(home, ".claude/insight-distill-redact.txt");
      writeFileSync(redactPath, `# machine patterns\n\n${secret}\n[\n`);
      const loader = Reflect.get(redact, "loadRedactList") as
        | ((path: string) => RegExp[])
        | undefined;
      ok(loader, "redact-secrets exports the relocated loader");
      if (path === "CLI add") {
        const result = await runLearningsCli(
          ["add", "--title=custom pattern", `--body=retain ${secret}`],
          {
            cwd: "/work/repo",
            home,
            now: NOW,
            readerEnv: undefined,
            isTty: false,
            agentEnv: true,
            feedbackReader: "claude",
            lockWaitMs: 100,
            runGit,
            confirm: async () => false,
          },
        );
        strictEqual(result.exitCode, 0, result.stderr);
      } else if (path === "SessionStart") {
        writeInboxRequest(
          store,
          {
            op: "add",
            repoKey: KEY,
            title: "custom pattern",
            body: `retain ${secret}`,
            reader: "codex",
          },
          NOW,
        );
        const text = await buildSessionLearningsContext({
          cwd: "/work/repo",
          home,
          runGit,
          now: NOW,
          env: {},
        });
        ok(text?.includes("retain [REDACTED]"));
        ok(!text.includes(secret));
      } else {
        const sessionId = "0f0e0d0c-0000-4000-8000-000000000001";
        const dir = join(home, ".claude/projects/p");
        mkdirSync(dir, { recursive: true });
        const transcriptPath = join(dir, `${sessionId}.jsonl`);
        writeFileSync(
          transcriptPath,
          `${Array.from({ length: 3 }, () =>
            JSON.stringify({
              type: "user",
              message: { content: `retain ${secret}` },
            }),
          ).join("\n")}\n`,
        );
        strictEqual(
          enqueueJob(
            store,
            {
              sessionId,
              transcriptPath,
              cwd: "/work/repo",
              repoKey: KEY,
              reason: "other",
            },
            NOW,
          ).status,
          "enqueued",
        );
        const result = await runWorker({
          home,
          store,
          now: () => NOW,
          runGit,
          claudePath: undefined,
          env: {},
          extraRedact: loader(redactPath),
          queryFn: (args) =>
            (async function* () {
              ok(args.prompt.includes("[REDACTED]"));
              ok(!args.prompt.includes(secret));
              yield {
                type: "result",
                subtype: "success",
                result: JSON.stringify({
                  schemaVersion: 1,
                  ops: [
                    {
                      op: "add",
                      title: "custom pattern",
                      body: `retain ${secret}`,
                      evidence: "user correction",
                    },
                  ],
                }),
              };
            })(),
        });
        strictEqual(result.processed, 1);
      }
      const file = readLearnings(store, KEY);
      ok(file.ok);
      strictEqual(file.value.entries.length, 1);
      strictEqual(file.value.entries[0]?.body, "retain [REDACTED]");
      strictEqual(readFileSync(redactPath, "utf8").includes(secret), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
