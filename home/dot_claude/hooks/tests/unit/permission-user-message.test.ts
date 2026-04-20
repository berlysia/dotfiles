#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildUserMessage,
  CLAUDE_DENY_MESSAGE,
  MAX_COMMAND_SUMMARY_LEN,
} from "../../lib/permission-user-message.ts";
import type {
  LLMEvaluationResult,
  PermissionRequestInput,
} from "../../lib/structured-llm-evaluator.ts";

const baseInput: PermissionRequestInput = {
  session_id: "test-session",
  tool_name: "Bash",
  tool_input: { command: "rm -rf .tmp/foo" },
  cwd: "/home/user/project",
};

describe("buildUserMessage", () => {
  it("uses the fixed CLAUDE_DENY_MESSAGE for claudeMessage on deny", () => {
    const result: LLMEvaluationResult = {
      kind: "deny",
      reason: "potentially destructive",
      confidence: "high",
    };

    const parts = buildUserMessage(result, baseInput);
    strictEqual(parts.claudeMessage, CLAUDE_DENY_MESSAGE);
  });

  it("includes confidence and reason in userMessage for deny", () => {
    const result: LLMEvaluationResult = {
      kind: "deny",
      reason: "rm -rf risk",
      confidence: "medium",
    };
    const parts = buildUserMessage(result, baseInput);
    ok(parts.userMessage.includes("Confidence: medium"));
    ok(parts.userMessage.includes("Reason: rm -rf risk"));
    ok(parts.userMessage.includes("Target: rm -rf .tmp/foo"));
    ok(parts.userMessage.includes("Bash"));
  });

  it("masks ENV=value in command summaries", () => {
    const input: PermissionRequestInput = {
      session_id: "s",
      tool_name: "Bash",
      tool_input: {
        command: "API_KEY=s3cret PATH=/evil rm -rf /",
      },
    };
    const result: LLMEvaluationResult = {
      kind: "deny",
      reason: "env prefixed rm -rf",
      confidence: "high",
    };
    const parts = buildUserMessage(result, input);
    ok(!parts.userMessage.includes("s3cret"), "secret value must not leak");
    ok(!parts.userMessage.includes("/evil"), "PATH value must not leak");
    ok(parts.userMessage.includes("API_KEY=***"));
    ok(parts.userMessage.includes("PATH=***"));
  });

  it("truncates command summaries longer than MAX_COMMAND_SUMMARY_LEN", () => {
    const longCommand = `echo ${"x".repeat(MAX_COMMAND_SUMMARY_LEN + 200)}`;
    const input: PermissionRequestInput = {
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: longCommand },
    };
    const result: LLMEvaluationResult = {
      kind: "deny",
      reason: "too long",
      confidence: "low",
    };
    const parts = buildUserMessage(result, input);
    // Truncated summary ends with ellipsis; total length should not exceed
    // MAX_COMMAND_SUMMARY_LEN + 1 (for the ellipsis char).
    const summaryLine = parts.userMessage
      .split("\n")
      .find((line) => line.startsWith("Target: "));
    ok(summaryLine, "userMessage must have Target line");
    if (summaryLine) {
      const summary = summaryLine.slice("Target: ".length);
      ok(
        summary.length <= MAX_COMMAND_SUMMARY_LEN + 1,
        `summary length ${summary.length} should be <= ${MAX_COMMAND_SUMMARY_LEN + 1}`,
      );
      ok(summary.endsWith("…"), "summary should end with ellipsis");
    }
  });

  it("renders parse-error with fail-safe phrasing", () => {
    const result: LLMEvaluationResult = {
      kind: "parse-error",
      rawText: "garbage",
    };
    const parts = buildUserMessage(result, baseInput);
    strictEqual(parts.claudeMessage, CLAUDE_DENY_MESSAGE);
    ok(parts.userMessage.includes("Confidence: n/a"));
    ok(parts.userMessage.includes("automated review"));
  });

  it("summarizes file_path inputs for Edit-style tools", () => {
    const input: PermissionRequestInput = {
      session_id: "s",
      tool_name: "Edit",
      tool_input: { file_path: "/home/user/project/.env" },
    };
    const result: LLMEvaluationResult = {
      kind: "deny",
      reason: "dotenv risk",
      confidence: "high",
    };
    const parts = buildUserMessage(result, input);
    ok(parts.userMessage.includes("/home/user/project/.env"));
    ok(parts.userMessage.includes("Edit"));
  });

  it("handles missing tool_input safely", () => {
    const input: PermissionRequestInput = {
      session_id: "s",
      tool_name: "Bash",
    };
    const result: LLMEvaluationResult = {
      kind: "deny",
      reason: "empty",
      confidence: "low",
    };
    const parts = buildUserMessage(result, input);
    ok(parts.userMessage.includes("(no input)"));
  });

  it("serializes generic object inputs and masks env-like assignments", () => {
    const input: PermissionRequestInput = {
      session_id: "s",
      tool_name: "MysteryTool",
      tool_input: { other_field: "value" },
    };
    const result: LLMEvaluationResult = {
      kind: "deny",
      reason: "unknown tool",
      confidence: "low",
    };
    const parts = buildUserMessage(result, input);
    ok(parts.userMessage.includes("MysteryTool"));
    ok(parts.userMessage.includes("other_field"));
  });

  it("provides consistent shape for allow results too", () => {
    const result: LLMEvaluationResult = {
      kind: "allow",
      reason: "safe",
    };
    const parts = buildUserMessage(result, baseInput);
    deepStrictEqual(Object.keys(parts).sort(), [
      "claudeMessage",
      "userMessage",
    ]);
  });
});
