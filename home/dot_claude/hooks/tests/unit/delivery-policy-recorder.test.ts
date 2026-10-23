#!/usr/bin/env node --test

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRecorderHook } from "../../implementations/delivery-policy-recorder.ts";
import {
  buildDeliveryPolicyQuestion,
  type Gh,
  ledgerPath,
  readLedger,
} from "../../lib/delivery-policy.ts";
import {
  createPostToolUseContext,
  invokeRun,
} from "../support/test-helpers.ts";

interface Output {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

const VIEW = JSON.stringify({
  nameWithOwner: "berlysia/dotfiles",
  owner: { id: "x", login: "berlysia" },
  isInOrganization: false,
  defaultBranchRef: { name: "main" },
  url: "https://github.com/berlysia/dotfiles",
});

describe("delivery-policy-recorder", () => {
  let home: string;
  let ghCalls: Array<{ cwd: string; args: string[] }>;
  let ghStatus: number;
  let repoView: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delivery-policy-recorder-"));
    ghCalls = [];
    ghStatus = 0;
    repoView = VIEW;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const hook = () =>
    createRecorderHook({
      home,
      ghFor:
        (cwd): Gh =>
        async (args) => {
          ghCalls.push({ cwd, args });
          return { status: ghStatus, stdout: repoView, stderr: "boom" };
        },
      now: () => new Date("2026-10-23T01:02:03.000Z"),
    });

  const questions = (repo = "berlysia/dotfiles") =>
    buildDeliveryPolicyQuestion(repo, "https://github.com/berlysia/dotfiles");
  const key = () => (questions()[0] as { question: string }).question;

  async function fire(response: unknown, extra: Record<string, unknown> = {}) {
    const ctx = createPostToolUseContext(
      "AskUserQuestion",
      {} as never,
      response as never,
    );
    Object.assign(ctx.input, extra);
    await invokeRun(hook(), ctx);
    const output = ctx.jsonCalls[0] as unknown as Output | undefined;
    return { ctx, output };
  }

  const answered = (answer: unknown) => ({
    questions: questions(),
    answers: { [key()]: answer },
  });

  const ledgerLines = () =>
    existsSync(ledgerPath(home))
      ? readFileSync(ledgerPath(home), "utf-8").split("\n").filter(Boolean)
      : [];

  it("records commit, pr and merge answers as one ledger line each", async () => {
    for (const scope of ["commit", "pr", "merge"]) {
      const { output } = await fire(answered(scope));
      assert.ok(output);
      assert.match(output.systemMessage, /^\[delivery-policy-recorder\] /);
      assert.match(
        output.systemMessage,
        new RegExp(`berlysia/dotfiles を ${scope} と記録した`),
      );
      assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
      assert.match(
        output.hookSpecificOutput.additionalContext,
        /^\[delivery-policy-recorder\] /,
      );
    }
    const lines = ledgerLines().map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.scope),
      ["commit", "pr", "merge"],
    );
    assert.deepEqual(lines[2], {
      v: 1,
      repo: "berlysia/dotfiles",
      scope: "merge",
      at: "2026-10-23T01:02:03.000Z",
    });
    assert.equal(
      readLedger(home).latest.get("berlysia/dotfiles")?.scope,
      "merge",
    );
  });

  it("resolves the repo in the hook's cwd", async () => {
    await fire(answered("pr"), { cwd: "/some/checkout" });
    assert.equal(ghCalls[0]?.cwd, "/some/checkout");
  });

  it("does not record inside a subagent, and says nothing", async () => {
    const { ctx } = await fire(answered("merge"), { agent_id: "sub" });
    assert.equal(ctx.jsonCalls.length, 0);
    assert.deepEqual(ledgerLines(), []);
  });

  it("does not record when the passwd home is unknown", async () => {
    const noHome = createRecorderHook({
      home: null,
      ghFor: () => async () => ({ status: 0, stdout: VIEW, stderr: "" }),
      now: () => new Date(),
    });
    const ctx = createPostToolUseContext(
      "AskUserQuestion",
      {} as never,
      answered("merge") as never,
    );
    await invokeRun(noHome, ctx);
    const output = ctx.jsonCalls[0] as unknown as Output | undefined;
    assert.match(output?.systemMessage ?? "", /passwd の home/);
    assert.deepEqual(ledgerLines(), []);
  });

  it("each case that must not record says a different reason", async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["afk", { ...answered("merge"), afkTimeoutMs: 1000 }, /afk/],
      ["free text", { ...answered("merge"), response: "やめて" }, /自由記述/],
      [
        "annotations",
        { ...answered("merge"), annotations: { x: { notes: "n" } } },
        /annotations/,
      ],
      ["unknown key", { ...answered("merge"), extra: 1 }, /未知のキー/],
      ["outside choice", answered("all"), /選択肢.*外/],
      ["array answer", answered(["merge"]), /選択肢.*外/],
    ];
    const reasons = new Set<string>();
    for (const [name, response, pattern] of cases) {
      const { output } = await fire(response);
      assert.ok(output, name);
      assert.match(output.systemMessage, /記録していない/, name);
      assert.match(output.systemMessage, pattern, name);
      reasons.add(output.systemMessage);
    }
    assert.equal(reasons.size, 5);
    assert.deepEqual(ledgerLines(), []);
  });

  it("does not record when the question names another repo than the cwd's", async () => {
    const other = questions("someone/else");
    const { output } = await fire({
      questions: other,
      answers: { [(other[0] as { question: string }).question]: "merge" },
    });
    assert.match(output?.systemMessage ?? "", /一致しない/);
    assert.deepEqual(ledgerLines(), []);
  });

  it("does not record when gh fails", async () => {
    ghStatus = 1;
    const { output } = await fire(answered("merge"));
    assert.match(output?.systemMessage ?? "", /repo を決められなかった/);
    assert.deepEqual(ledgerLines(), []);
  });

  it("says nothing for an ordinary question and never calls gh", async () => {
    const { ctx } = await fire({
      questions: [{ question: "進めてよいか", options: [] }],
      answers: { 進めてよいか: "はい" },
    });
    assert.equal(ctx.jsonCalls.length, 0);
    assert.equal(ghCalls.length, 0);
  });

  it("ignores a tool whose name only resembles AskUserQuestion", async () => {
    const { ctx } = await fire(answered("merge"), {
      tool_name: "mcp__x__AskUserQuestion",
    });
    assert.equal(ctx.jsonCalls.length, 0);
    assert.deepEqual(ledgerLines(), []);
  });
});
