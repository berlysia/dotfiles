import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { APPROVAL_SUMMARY_RULE_LINES } from "../../lib/workflow-review-core.ts";
import { hasBun } from "../support/claude-worktree-entry-fixture.ts";
import { buildPlanContent } from "../support/test-helpers.ts";

// Starts the CLI as a process, so a broken entrypoint wiring fails here even
// when the exported functions pass their unit tests.

const ENTRY = join(import.meta.dirname, "..", "..", "cli", "workflow.ts");
const roots: string[] = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe(
  "workflow-cli entry",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("ask-approval prints the question JSON and the rule lines when started as a process", () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-cli-entry-")));
      roots.push(root);
      const wf = join(root, ".tmp", "sessions", "abcd1234");
      mkdirSync(wf, { recursive: true });
      writeFileSync(
        join(wf, "spec.md"),
        buildPlanContent({
          planStatus: "complete",
          approvalStatus: "pending",
          review: { verdict: "pass" },
        }),
      );
      const r = spawnSync("bun", [ENTRY, "ask-approval", "--wf-dir", wf], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout) as { questions?: unknown };
      assert.ok(Array.isArray(out.questions));
      assert.ok(r.stderr.includes(APPROVAL_SUMMARY_RULE_LINES[0] as string));
    });
  },
);
