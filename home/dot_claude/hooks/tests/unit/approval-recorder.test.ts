#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import hook from "../../implementations/approval-recorder.ts";
import {
  appendApproval,
  readLatestApprovals,
} from "../../lib/workflow-approval.ts";
import { evaluateTarget } from "../../lib/workflow-gate.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  buildPlanContent,
  buildPlanNContent,
  computeWorkflowRepoPlanHash,
  createUserPromptSubmitContext,
  EnvironmentHelper,
  invokeRun,
  recordApprovalsForTest,
  TEST_SESSION_ID,
  type WorkflowRepoOptions,
} from "./test-helpers.ts";

const REVIEWED: WorkflowRepoOptions = {
  planStatus: "complete",
  approvalStatus: "pending",
  review: { verdict: "pass" },
};
const APPROVED: WorkflowRepoOptions = {
  ...REVIEWED,
  approvalStatus: "approved",
};

describe("approval-recorder (spec K7)", () => {
  const envHelper = new EnvironmentHelper();
  let repo: string;
  let wf: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "approval-recorder-")));
    wf = join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID));
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "research.md"), "x");
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });

  afterEach(() => {
    envHelper.restore();
  });

  async function say(prompt: string, extra: Record<string, unknown> = {}) {
    const ctx = createUserPromptSubmitContext(prompt);
    Object.assign(ctx.input, extra);
    await invokeRun(hook, ctx);
    return { ctx, text: JSON.stringify(ctx.jsonCalls) };
  }

  it("records the only document awaiting approval and opens the gate", async () => {
    writeFileSync(join(wf, "plan.md"), buildPlanContent(REVIEWED));
    const { text } = await say("承認");
    const { latest } = readLatestApprovals(wf);
    assert.equal(
      latest.get("plan.md")?.hash,
      computeWorkflowRepoPlanHash(readFileSync(join(wf, "plan.md"), "utf-8")),
    );
    assert.equal(latest.get("plan.md")?.session, TEST_SESSION_ID);
    assert.equal(latest.get("plan.md")?.via, "utterance");
    assert.match(
      readFileSync(join(wf, "plan.md"), "utf-8"),
      /^- Approval Status: approved$/m,
    );
    assert.match(text, /plan\.md を hash=[0-9a-f]{12} で承認として記録/);
    assert.match(text, /"systemMessage"/);
    assert.equal(
      evaluateTarget({
        projectRoot: repo,
        wfDir: wf,
        target: join(repo, "src", "a.ts"),
      }).kind,
      "allow",
    );
  });

  it("records nothing and asks for a name when two plans await approval", async () => {
    const spec = buildPlanContent(APPROVED);
    writeFileSync(join(wf, "spec.md"), spec);
    recordApprovalsForTest(wf);
    const specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(
      join(wf, "plan-1.md"),
      buildPlanNContent(REVIEWED, ["src/a.ts"], specHash),
    );
    writeFileSync(
      join(wf, "plan-2.md"),
      buildPlanNContent(REVIEWED, ["src/b.ts"], specHash),
    );
    const before = readFileSync(join(wf, "approvals.log"), "utf-8");
    const { text } = await say("承認");
    assert.equal(readFileSync(join(wf, "approvals.log"), "utf-8"), before);
    assert.match(text, /承認を待っている文書が 2 件/);
    assert.match(text, /承認 plan-1\.md/);
  });

  it("records every named document, or none when one of them is not ready", async () => {
    const spec = buildPlanContent(REVIEWED);
    writeFileSync(join(wf, "spec.md"), spec);
    const specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(
      join(wf, "plan-1.md"),
      buildPlanNContent(REVIEWED, ["src/a.ts"], specHash),
    );
    writeFileSync(
      join(wf, "plan-2.md"),
      buildPlanNContent(
        { planStatus: "drafting", approvalStatus: "pending" },
        [],
        specHash,
      ),
    );

    await say("承認 spec.md plan-2.md");
    assert.equal(existsSync(join(wf, "approvals.log")), false);

    await say("承認 spec.md plan-1.md");
    assert.deepEqual([...readLatestApprovals(wf).latest.keys()].sort(), [
      "plan-1.md",
      "spec.md",
    ]);
  });

  it("completes a half-done approval when the user says it again", async () => {
    const plan = buildPlanContent(REVIEWED);
    writeFileSync(join(wf, "plan.md"), plan);
    appendApproval(wf, {
      doc: "plan.md",
      hash: computeWorkflowRepoPlanHash(plan),
      session: TEST_SESSION_ID,
      at: "t",
    });
    await say("承認");
    assert.match(
      readFileSync(join(wf, "plan.md"), "utf-8"),
      /^- Approval Status: approved$/m,
    );
    assert.equal(
      evaluateTarget({
        projectRoot: repo,
        wfDir: wf,
        target: join(repo, "src", "a.ts"),
      }).kind,
      "allow",
    );
  });

  it("does nothing for an ordinary prompt, inside a subagent, or for a prompt the user did not type", async () => {
    writeFileSync(join(wf, "plan.md"), buildPlanContent(REVIEWED));
    const ordinary = await say("T3 の方針を説明して");
    assert.deepEqual(ordinary.ctx.jsonCalls, []);
    const inSubagent = await say("承認", { agent_id: "agent-1" });
    assert.match(inSubagent.text, /記録していない/);
    for (const source of [
      "schedule_wakeup",
      "loop_wakeup",
      "poll_event",
      "system",
      "sdk",
    ]) {
      const { text } = await say("承認", { source });
      assert.match(text, new RegExp(`source=${source}.*記録していない`));
    }
    assert.equal(existsSync(join(wf, "approvals.log")), false);
    await say("承認", { source: "user" });
    assert.equal(readLatestApprovals(wf).latest.has("plan.md"), true);
  });

  it("does not append a probe line to a reply", async () => {
    writeFileSync(join(wf, "plan.md"), buildPlanContent(REVIEWED));
    const { text } = await say("承認", {
      source: "schedule_wakeup",
      prompt_id: "p1",
    });
    assert.match(text, /記録していない/);
    assert.doesNotMatch(text, /probe:/);
  });

  it("does not rewrite a document that is a symlink, and leaves no temp file", async () => {
    const outside = join(repo, "outside-plan.md");
    writeFileSync(outside, buildPlanContent(REVIEWED));
    symlinkSync(outside, join(wf, "plan.md"));
    const { text } = await say("承認");
    assert.match(
      readFileSync(outside, "utf-8"),
      /^- Approval Status: pending$/m,
    );
    assert.match(text, /log には記録したが承認行の書き換えに失敗した/);
    assert.deepEqual(
      readdirSync(wf).filter((name) => name.endsWith(".approval-tmp")),
      [],
    );
  });

  it("reports a failure instead of claiming success when the ledger cannot be written", async () => {
    writeFileSync(join(wf, "plan.md"), buildPlanContent(REVIEWED));
    mkdirSync(join(wf, "approvals.log"));
    const { text } = await say("承認");
    assert.match(text, /plan\.md は記録できなかった（何も書いていない）/);
    assert.doesNotMatch(text, /もう一度/);
    assert.match(
      readFileSync(join(wf, "plan.md"), "utf-8"),
      /^- Approval Status: pending$/m,
    );
  });
});
