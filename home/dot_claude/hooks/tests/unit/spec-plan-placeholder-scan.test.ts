#!/usr/bin/env node --test

import { doesNotMatch, match, strictEqual } from "node:assert";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import placeholderScanHook from "../../implementations/spec-plan-placeholder-scan.ts";
import {
  ConsoleCapture,
  createPostToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";

function setupWfDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "spps-")));
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
    const wfDir = setupWfDir();
    env.set("DOCUMENT_WORKFLOW_DIR", wfDir);
    env.set("CLAUDE_TEST_CWD", wfDir);
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
    const wfDir = setupWfDir();
    env.set("DOCUMENT_WORKFLOW_DIR", wfDir);
    env.set("CLAUDE_TEST_CWD", wfDir);
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
    const wfDir = setupWfDir();
    env.set("DOCUMENT_WORKFLOW_DIR", wfDir);
    env.set("CLAUDE_TEST_CWD", wfDir);
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

  it("returns success when no placeholders found", async () => {
    const wfDir = setupWfDir();
    env.set("DOCUMENT_WORKFLOW_DIR", wfDir);
    env.set("CLAUDE_TEST_CWD", wfDir);
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
