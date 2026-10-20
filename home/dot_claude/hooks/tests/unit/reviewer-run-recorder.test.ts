#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import hook, {
  REVIEWER_SLUGS,
} from "../../implementations/reviewer-run-recorder.ts";
import {
  createPostToolUseContextFor,
  createWorkflowRepo,
  EnvironmentHelper,
  invokeRun,
  pendingWorkflowRepo,
  TEST_WORKFLOW_DIR,
} from "../support/test-helpers.ts";

describe("reviewer-run-recorder.ts", () => {
  const envHelper = new EnvironmentHelper();

  it("REVIEWER_SLUGS derives from the shared spec/plan/catalog rosters", () => {
    assert.ok(REVIEWER_SLUGS.has("logic-validator"));
    assert.ok(REVIEWER_SLUGS.has("scope-justification-reviewer"));
    assert.ok(REVIEWER_SLUGS.has("security-vulnerability-analyzer"));
    assert.ok(!REVIEWER_SLUGS.has("Explore"));
    assert.ok(!REVIEWER_SLUGS.has("general-purpose"));
  });

  it("records a reviewer Agent run to the ledger", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "logic-validator",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    const log = readFileSync(
      join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
      "utf-8",
    );
    assert.match(log, /logic-validator/);
    envHelper.restore();
  });

  it("counts a plugin-namespaced run of a reviewer slug (accepted behaviour)", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "some-plugin:review:security-vulnerability-analyzer",
    });
    await invokeRun(hook, ctx);
    const log = readFileSync(
      join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
      "utf-8",
    );
    assert.match(log, /some-plugin:review:security-vulnerability-analyzer/);
    envHelper.restore();
  });

  for (const subagentType of [
    "review-reframer",
    "some-plugin:review-reframer",
  ]) {
    it(`records a ${subagentType} launch as one ledger line`, async () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const ctx = createPostToolUseContextFor(hook, "Agent", {
        subagent_type: subagentType,
      });
      await invokeRun(hook, ctx);
      ctx.assertSuccess({});
      const lines = readFileSync(
        join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
        "utf-8",
      )
        .split("\n")
        .filter((l) => l.length > 0);
      assert.equal(lines.length, 1);
      // column 2 keeps the value as launched (normalized only at lookup time)
      assert.equal(lines[0]?.split("\t")[1], subagentType);
      envHelper.restore();
    });
  }

  it("still ignores general-purpose", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "general-purpose",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    assert.equal(
      existsSync(join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log")),
      false,
    );
    envHelper.restore();
  });

  it("ignores non-reviewer subagents (Explore)", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "Explore",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    assert.equal(
      existsSync(join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log")),
      false,
    );
    envHelper.restore();
  });

  it("ignores non-Agent tools", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Bash", {
      command: "echo hi",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    envHelper.restore();
  });

  it("does nothing when the workflow dir is unresolvable", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    envHelper.set("CLAUDE_TEST_CWD", "/tmp");
    const ctx = createPostToolUseContextFor(
      hook,
      "Agent",
      { subagent_type: "logic-validator" },
      {},
      { session_id: "" },
    );
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    envHelper.restore();
  });

  it("keeps every line (no cap: stamp filters by round baseline, not by tail)", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    for (let i = 0; i < 205; i++) {
      const ctx = createPostToolUseContextFor(hook, "Agent", {
        subagent_type: "logic-validator",
      });
      await invokeRun(hook, ctx);
    }
    const log = readFileSync(
      join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
      "utf-8",
    );
    const lines = log.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 205);
    envHelper.restore();
  });

  it("refuses to write through a symlinked ledger", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const target = join(repo, "elsewhere.log");
    writeFileSync(target, "");
    symlinkSync(target, join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"));
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "logic-validator",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    assert.equal(readFileSync(target, "utf-8"), "");
    envHelper.restore();
  });
});

const hasBun =
  spawnSync("sh", ["-c", "command -v bun"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).status === 0;

const recorderEntry = join(
  import.meta.dirname,
  "..",
  "..",
  "implementations",
  "reviewer-run-recorder.ts",
);

function runRecorderProcess(repo: string, slug: string): Promise<number> {
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "concurrent-session",
    transcript_path: join(repo, "transcript.jsonl"),
    cwd: repo,
    tool_name: "Agent",
    tool_use_id: `toolu-${slug}`,
    tool_input: { subagent_type: slug, prompt: "p", description: "d" },
    tool_response: {},
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bun", [recorderEntry], {
      env: {
        ...process.env,
        CLAUDE_TEST_CWD: repo,
        DOCUMENT_WORKFLOW_DIR: TEST_WORKFLOW_DIR,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise(code ?? -1));
    child.stdin.end(payload);
  });
}

describe(
  "reviewer-run-recorder.ts as concurrent processes",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    // Reviewers launched in one message fire their PostToolUse hooks as
    // separate processes at the same time. A read-modify-write ledger loses
    // lines under that interleaving; the race is timing-dependent, so several
    // rounds of many processes are run to make a regression likely to show.
    it("keeps one line per launch when hooks run at the same time", async () => {
      const slugs = [...REVIEWER_SLUGS].slice(0, 12);
      for (let round = 0; round < 3; round++) {
        const repo = createWorkflowRepo(pendingWorkflowRepo());
        const codes = await Promise.all(
          slugs.map((slug) => runRecorderProcess(repo, slug)),
        );
        assert.deepEqual(
          codes,
          slugs.map(() => 0),
        );
        const recorded = readFileSync(
          join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
          "utf-8",
        )
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => l.split("\t")[1]);
        assert.deepEqual(recorded.sort(), [...slugs].sort());
      }
    });
  },
);
