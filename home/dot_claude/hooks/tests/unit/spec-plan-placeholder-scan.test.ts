#!/usr/bin/env node --test

import { doesNotMatch, match, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import placeholderScanHook from "../../implementations/spec-plan-placeholder-scan.ts";
import {
  ConsoleCapture,
  createPostToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
  TEST_SESSION_ID,
} from "./test-helpers.ts";

function setupWfDir(): { cwd: string; wfDir: string } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spps-")));
  const wfDir = join(cwd, ".tmp", "sessions", TEST_SESSION_ID.slice(0, 8));
  mkdirSync(wfDir, { recursive: true });
  return { cwd, wfDir };
}

describe("spec-plan-placeholder-scan hook", () => {
  const env = new EnvironmentHelper();
  const cap = new ConsoleCapture();

  beforeEach(() => cap.start());
  afterEach(() => {
    cap.stop();
    env.restore();
  });

  it("warns on TBD/適切に in spec.md, omits body content", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const specPath = join(wfDir, "spec.md");
    writeFileSync(
      specPath,
      "# Goal\nTBD\n## K1\n適切にエラー処理\n## K2\n通常記述",
    );
    const ctx = createPostToolUseContextFor(
      placeholderScanHook,
      "Edit",
      { file_path: specPath, old_string: "x", new_string: "y" },
      { filePath: specPath, oldString: "x", newString: "y" },
    );
    await invokeRun(placeholderScanHook, ctx);
    strictEqual(ctx.jsonCalls.length, 1);
    const additional = ctx.jsonCalls[0].hookSpecificOutput
      .additionalContext as string;
    match(additional, /placeholder-scan/);
    match(additional, /line 2/); // TBD
    match(additional, /line 4/); // 適切に
    doesNotMatch(additional, /通常記述/); // body should NOT be echoed
  });

  it("respects ignore comment range", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const specPath = join(wfDir, "spec.md");
    writeFileSync(
      specPath,
      "# Goal\n<!-- placeholder-scan: ignore -->\nTBD\n<!-- /placeholder-scan: ignore -->",
    );
    const ctx = createPostToolUseContextFor(
      placeholderScanHook,
      "Edit",
      { file_path: specPath, old_string: "x", new_string: "y" },
      { filePath: specPath, oldString: "x", newString: "y" },
    );
    await invokeRun(placeholderScanHook, ctx);
    strictEqual(ctx.successCalls.length, 1);
    strictEqual(ctx.jsonCalls.length, 0);
  });

  it("early-returns for unrelated files", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const ctx = createPostToolUseContextFor(
      placeholderScanHook,
      "Edit",
      { file_path: "/tmp/other.ts", old_string: "TBD", new_string: "y" },
      { filePath: "/tmp/other.ts", oldString: "TBD", newString: "y" },
    );
    await invokeRun(placeholderScanHook, ctx);
    strictEqual(ctx.successCalls.length, 1);
    strictEqual(ctx.jsonCalls.length, 0);
  });

  it("honours an env pin that sits under the sessions root", async () => {
    const { cwd } = setupWfDir();
    const pinned = join(cwd, ".tmp", "sessions", "pinned01");
    mkdirSync(pinned, { recursive: true });
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", pinned);
    const specPath = join(pinned, "spec.md");
    writeFileSync(specPath, "# Goal\nTBD\n## K1\n適切にエラー処理");
    const ctx = createPostToolUseContextFor(
      placeholderScanHook,
      "Edit",
      { file_path: specPath, old_string: "x", new_string: "y" },
      { filePath: specPath, oldString: "x", newString: "y" },
    );
    await invokeRun(placeholderScanHook, ctx);
    strictEqual(ctx.jsonCalls.length, 1);
    const additional = ctx.jsonCalls[0].hookSpecificOutput
      .additionalContext as string;
    match(additional, /placeholder-scan/);
  });

  it("returns success when no placeholders found", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const specPath = join(wfDir, "spec.md");
    writeFileSync(specPath, "# Goal\n## K1\n通常記述\n## K2\n別の記述");
    const ctx = createPostToolUseContextFor(
      placeholderScanHook,
      "Edit",
      { file_path: specPath, old_string: "x", new_string: "y" },
      { filePath: specPath, oldString: "x", newString: "y" },
    );
    await invokeRun(placeholderScanHook, ctx);
    strictEqual(ctx.successCalls.length, 1);
    strictEqual(ctx.jsonCalls.length, 0);
  });
});
