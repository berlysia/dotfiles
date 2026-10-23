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
import { verifyAndRecordApprovalAnswer } from "../../lib/workflow-approval-record.ts";
import { APPROVAL_SUMMARY_RULE_LINES } from "../../lib/workflow-review-core.ts";
import { hasBun } from "../support/claude-worktree-entry-fixture.ts";
import {
  buildPlanContent,
  computeWorkflowRepoPlanHash,
} from "../support/test-helpers.ts";

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
    it("the recorder accepts the question the CLI process printed, for the same wfDir", () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-cli-entry-")));
      roots.push(root);
      const wf = join(root, ".tmp", "sessions", "abcd1234");
      mkdirSync(wf, { recursive: true });
      const options = {
        planStatus: "complete",
        approvalStatus: "pending",
        review: { verdict: "pass" },
      } as const;
      // The H1 sits inside the hashed text, so the marker hash covers it.
      const withoutMarker = buildPlanContent(options).replace(
        /\n\n<!-- auto-review:.*-->$/,
        "",
      );
      const body = `# Spec: 題 「x」\n\n${withoutMarker}`;
      const hash = computeWorkflowRepoPlanHash(body);
      writeFileSync(
        join(wf, "spec.md"),
        `${body}\n\n<!-- auto-review: verdict=pass; hash=${hash}; at=2026-02-19T00:00:00.000Z; reviewers=logic-validator -->`,
      );
      const r = spawnSync("bun", [ENTRY, "ask-approval", "--wf-dir", wf], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      const printed = JSON.parse(r.stdout) as {
        questions: { question: string }[];
      };
      const key = printed.questions[0]?.question as string;
      assert.ok(key.includes("abcd1234"));
      const result = verifyAndRecordApprovalAnswer(
        wf,
        { questions: printed.questions, answers: { [key]: "spec.md" } },
        "sess",
        new Date(),
        root,
      );
      assert.equal(result.kind, "recorded");
    });
  },
);
