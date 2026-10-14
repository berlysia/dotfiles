import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSessionLearningsContext } from "../../lib/agent-learnings/claude/session-context.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import {
  initStore,
  defaultStoreDir,
} from "../../lib/agent-learnings/core/store.ts";
import { writeInboxRequest } from "../../lib/agent-learnings/core/inbox.ts";

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
