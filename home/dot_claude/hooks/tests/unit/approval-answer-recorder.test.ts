#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import hook from "../../implementations/approval-answer-recorder.ts";
import {
  APPROVALS_LOG,
  APPROVAL_QUESTION_TEXT,
  buildApprovalQuestions,
} from "../../lib/workflow-approval.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  buildPlanContent,
  buildPlanNContent,
  computeWorkflowRepoPlanHash,
  createPostToolUseContext,
  EnvironmentHelper,
  invokeRun,
  TEST_SESSION_ID,
  type WorkflowRepoOptions,
} from "./test-helpers.ts";

const REVIEWED: WorkflowRepoOptions = {
  planStatus: "complete",
  approvalStatus: "pending",
  review: { verdict: "pass" },
};

interface Output {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

describe("approval-answer-recorder (spec K2/K3)", () => {
  const envHelper = new EnvironmentHelper();
  let repo: string;
  let wf: string;
  let specHash: string;
  let plan1Hash: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "approval-answer-")));
    wf = join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID));
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "research.md"), "x");
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const spec = buildPlanContent(REVIEWED);
    specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(join(wf, "spec.md"), spec);
    const plan1 = buildPlanNContent(REVIEWED, ["src/a.ts"], specHash);
    plan1Hash = computeWorkflowRepoPlanHash(plan1);
    writeFileSync(join(wf, "plan-1.md"), plan1);
  });

  afterEach(() => {
    envHelper.restore();
  });

  const questionsFor = (docs = ["spec.md", "plan-1.md"]) =>
    buildApprovalQuestions(
      docs.map((name) => ({
        name,
        hash: name === "spec.md" ? specHash : plan1Hash,
      })),
    );

  const answerResponse = (answer: string, docs?: string[]) => ({
    questions: questionsFor(docs),
    answers: { [APPROVAL_QUESTION_TEXT]: answer },
  });

  const logText = () =>
    existsSync(join(wf, APPROVALS_LOG))
      ? readFileSync(join(wf, APPROVALS_LOG), "utf-8")
      : "";

  async function fire(
    response: unknown,
    {
      input = {},
      extra = {},
    }: { input?: unknown; extra?: Record<string, unknown> } = {},
  ) {
    const ctx = createPostToolUseContext(
      "AskUserQuestion",
      input as never,
      response as never,
    );
    Object.assign(ctx.input, extra);
    await invokeRun(hook, ctx);
    const output = ctx.jsonCalls[0] as unknown as Output | undefined;
    return {
      ctx,
      output,
      text: output === undefined ? "" : JSON.stringify(output),
    };
  }

  it("records the approved documents and reports them", async () => {
    const { output } = await fire(answerResponse("spec.md"));
    assert.ok(output);
    assert.match(output.systemMessage, /\[approval-answer-recorder\]/);
    assert.match(
      output.systemMessage,
      new RegExp(
        `spec\\.md を hash=${specHash.slice(0, 12)} で承認として記録した`,
      ),
    );
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(logText(), /"doc":"spec\.md"/);
  });

  it("reads tool_response only, never tool_input", async () => {
    const decline = await fire(answerResponse("承認しない"), {
      input: { answers: { [APPROVAL_QUESTION_TEXT]: "spec.md, plan-1.md" } },
    });
    assert.match(decline.text, /承認しなかった/);
    assert.equal(logText(), "");

    const recorded = await fire(answerResponse("spec.md"), { input: {} });
    assert.match(recorded.text, /承認として記録した/);
  });

  it("writes via=ask as a constant, whatever tool_input says", async () => {
    await fire(answerResponse("spec.md"), {
      input: { via: "utterance", answers: { x: "y" } },
    });
    const line = JSON.parse(logText().trim().split("\n")[0] ?? "{}");
    assert.equal(line.via, "ask");
  });

  it("ignores a tool whose name only resembles AskUserQuestion", async () => {
    const { ctx } = await fire(answerResponse("spec.md"), {
      extra: { tool_name: "mcp__x__AskUserQuestion" },
    });
    assert.equal(ctx.jsonCalls.length, 0);
    assert.equal(logText(), "");
  });

  it("does not record inside a subagent, and only speaks for an approval question", async () => {
    const approval = await fire(answerResponse("spec.md"), {
      extra: { agent_id: "sub" },
    });
    assert.match(approval.text, /subagent/);
    assert.equal(logText(), "");

    const general = await fire(
      {
        questions: [
          {
            question: "進めてよいか",
            header: "確認",
            multiSelect: false,
            options: [{ label: "はい" }, { label: "いいえ" }],
          },
        ],
        answers: { 進めてよいか: "はい" },
      },
      { extra: { agent_id: "sub" } },
    );
    assert.equal(general.ctx.jsonCalls.length, 0);
  });

  it("refuses to record when the workflow dir cannot be resolved", async () => {
    const approval = await fire(answerResponse("spec.md"), {
      extra: { session_id: "../bad" },
    });
    assert.match(approval.text, /workflow dir を解決できない/);
    assert.equal(logText(), "");

    const general = await fire(
      { questions: [{ question: "x", options: [{ label: "a" }] }] },
      { extra: { session_id: "../bad" } },
    );
    assert.equal(general.ctx.jsonCalls.length, 0);
  });

  it("reports an away user and does not ask again", async () => {
    const { text } = await fire({
      ...answerResponse("spec.md"),
      afkTimeoutMs: 1000,
    });
    assert.match(text, /離席/);
    assert.match(text, /出し直さない/);
    assert.equal(logText(), "");
  });

  it("treats a decline as a decision, not a failure", async () => {
    const { text } = await fire(answerResponse("承認しない"));
    assert.match(text, /承認しなかった/);
    assert.doesNotMatch(text, /ask-approval/);
    assert.equal(logText(), "");
  });

  it("returns the notes and records nothing", async () => {
    const { text } = await fire({
      ...answerResponse("spec.md"),
      annotations: { [APPROVAL_QUESTION_TEXT]: { notes: "ここ直して" } },
    });
    assert.match(text, /ここ直して/);
    assert.equal(logText(), "");
  });

  it("returns free text as the user's words and records nothing", async () => {
    const { text } = await fire(answerResponse("やっぱり待って"));
    assert.match(text, /やっぱり待って/);
    assert.equal(logText(), "");
  });

  it("reports a malformed question with the way to retry", async () => {
    const { output } = await fire({ ...answerResponse("spec.md"), extra: 1 });
    assert.ok(output);
    assert.match(output.hookSpecificOutput.additionalContext, /形と違う/);
    assert.match(output.hookSpecificOutput.additionalContext, /ask-approval/);
    assert.match(output.systemMessage, /approve /);
    assert.equal(logText(), "");
  });

  it("reports a document that is no longer awaiting approval", async () => {
    writeFileSync(
      join(wf, "plan-2.md"),
      buildPlanNContent(
        { ...REVIEWED, review: { verdict: "needs-work" } },
        ["src/b.ts"],
        specHash,
      ),
    );
    const { text } = await fire({
      questions: buildApprovalQuestions([
        { name: "plan-2.md", hash: plan1Hash },
      ]),
      answers: { [APPROVAL_QUESTION_TEXT]: "plan-2.md" },
    });
    assert.match(text, /承認待ちでなくなった/);
    assert.equal(logText(), "");
  });

  it("reports each document's state when only some are recorded", async () => {
    renameSync(join(wf, "plan-1.md"), join(wf, "real-plan-1.md"));
    symlinkSync(join(wf, "real-plan-1.md"), join(wf, "plan-1.md"));
    const { output } = await fire(answerResponse("spec.md, plan-1.md"));
    assert.ok(output);
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /spec\.md を hash=/,
    );
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /plan-1\.md は log には記録したが承認行の書き換えに失敗した/,
    );
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /ask-approval` をもう一度呼ぶとこの文書が質問に出る/,
    );
    assert.match(output.systemMessage, /approve plan-1\.md/);
  });

  it("says nothing for an ordinary question", async () => {
    const { ctx } = await fire({
      questions: [
        {
          question: "この方針で進めてよいか",
          header: "確認",
          multiSelect: false,
          options: [{ label: "はい" }, { label: "いいえ" }],
        },
      ],
      answers: { この方針で進めてよいか: "はい" },
    });
    assert.equal(ctx.jsonCalls.length, 0);
  });

  it("reports a possible failure when verification throws", async () => {
    const response = {
      questions: questionsFor(),
      get answers(): never {
        throw new Error("boom");
      },
    };
    const { text } = await fire(response);
    assert.match(text, /記録できなかった可能性/);
    assert.match(text, /workflow-cli status/);
  });
});
