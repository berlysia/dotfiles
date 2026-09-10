#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import hook from "../../implementations/resume-incomplete-work.ts";
import {
  createStopContextFor,
  createUserPromptSubmitContext,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";

const COUNTER_PATH = join(process.cwd(), ".tmp", ".resume-incomplete-retries");

function cleanupCounter(): void {
  try {
    if (existsSync(COUNTER_PATH)) rmSync(COUNTER_PATH);
  } catch {
    // ignore
  }
}

describe("resume-incomplete-work.ts: announce-then-stop (K7)", () => {
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
    cleanupCounter();
    // This repo itself runs under an active Document Workflow session, so
    // DOCUMENT_WORKFLOW_DIR is set in the ambient environment; unset it so
    // resolveWorkflowDir derives from the test's own session_id instead of
    // pointing at the real session running this test.
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });
  afterEach(() => {
    cleanupCounter();
    envHelper.restore();
  });

  it("blocks a Stop that only announces an action", async () => {
    envHelper.set("CLAUDE_TEST_CWD", process.cwd());
    const wfDir = join(process.cwd(), ".tmp", "sessions", "test-ses");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "research.md"), "research");
    try {
      const ctx = createStopContextFor(hook, {
        last_assistant_message: "では round 3 のレビューを走らせます。",
        stop_hook_active: false,
        session_id: "test-session",
      });
      await invokeRun(hook, ctx);
      const out = ctx.jsonCalls.at(-1);
      assert.equal(out?.decision, "block");
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });

  it("allows a Stop that says it is waiting for approval", async () => {
    envHelper.set("CLAUDE_TEST_CWD", process.cwd());
    const wfDir = join(process.cwd(), ".tmp", "sessions", "test-ses");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "research.md"), "research");
    try {
      const ctx = createStopContextFor(hook, {
        last_assistant_message:
          "レビュー結果をまとめ、変更点を一通り確認しました。承認をお願いします。",
        stop_hook_active: false,
        session_id: "test-session",
      });
      await invokeRun(hook, ctx);
      ctx.assertSuccess({});
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });

  it("allows an announce-only message when stop_hook_active is true", async () => {
    envHelper.set("CLAUDE_TEST_CWD", process.cwd());
    const wfDir = join(process.cwd(), ".tmp", "sessions", "test-ses");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "research.md"), "research");
    try {
      const ctx = createStopContextFor(hook, {
        last_assistant_message:
          "調査結果を確認し、必要な修正点をまとめました。それでは反映します。",
        stop_hook_active: true,
        session_id: "test-session",
      });
      await invokeRun(hook, ctx);
      ctx.assertSuccess({});
    } finally {
      rmSync(wfDir, { recursive: true, force: true });
    }
  });

  it("allows an announce-only message when there is no active workflow (no research.md)", async () => {
    envHelper.set("CLAUDE_TEST_CWD", process.cwd());
    const ctx = createStopContextFor(hook, {
      last_assistant_message:
        "詳細な調査の後に必要な変更を洗い出しました。それでは直します。",
      stop_hook_active: false,
      session_id: "no-such-session-dir",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });

  it("resets the retry counter on UserPromptSubmit", async () => {
    const ctx = createUserPromptSubmitContext("next turn");
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    assert.equal(existsSync(COUNTER_PATH), false);
  });
});
