/**
 * User-facing message formatting for PermissionRequest deny responses.
 *
 * Separates the message shown to Claude (`claudeMessage`, fixed boilerplate to
 * avoid leaking decision heuristics) from the message shown to the user
 * (`userMessage`, detailed threat summary for informed review).
 */

import type {
  LLMEvaluationResult,
  PermissionRequestInput,
} from "./structured-llm-evaluator.ts";

export const CLAUDE_DENY_MESSAGE =
  "Denied by automated review. See user for details.";

export const MAX_COMMAND_SUMMARY_LEN = 500;

const ENV_VAR_ASSIGNMENT = /([A-Z_][A-Z0-9_]*)=\S+/g;

export interface UserMessageParts {
  claudeMessage: string;
  userMessage: string;
}

function maskEnvValues(text: string): string {
  return text.replace(ENV_VAR_ASSIGNMENT, (_match, key) => `${key}=***`);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function summarizeToolInput(input: PermissionRequestInput): string {
  const toolInput = input.tool_input;
  if (!toolInput) return "(no input)";

  if ("command" in toolInput && typeof toolInput.command === "string") {
    return truncate(maskEnvValues(toolInput.command), MAX_COMMAND_SUMMARY_LEN);
  }

  if ("file_path" in toolInput && typeof toolInput.file_path === "string") {
    return truncate(toolInput.file_path, MAX_COMMAND_SUMMARY_LEN);
  }

  const serialized = JSON.stringify(toolInput);
  return truncate(maskEnvValues(serialized), MAX_COMMAND_SUMMARY_LEN);
}

/**
 * Build both Claude-facing and user-facing messages for a deny decision.
 *
 * The Claude-facing message is intentionally fixed so that Claude cannot
 * exploit variance in rejection text. The user-facing message carries the
 * detailed threat breakdown for informed manual review.
 */
export function buildUserMessage(
  result: LLMEvaluationResult,
  input: PermissionRequestInput,
): UserMessageParts {
  const summary = summarizeToolInput(input);
  const header = `🚨 Permission blocked: ${input.tool_name}`;
  const target = `Target: ${summary}`;

  let body: string;
  if (result.kind === "deny") {
    body = [
      `Confidence: ${result.confidence}`,
      `Reason: ${result.reason}`,
    ].join("\n");
  } else if (result.kind === "parse-error") {
    body = [
      "Confidence: n/a (automated review unavailable)",
      "Reason: LLM response could not be parsed; failing safe.",
    ].join("\n");
  } else {
    // Allow results should not flow through the deny formatter, but keep the
    // shape consistent so callers cannot produce a partial message by mistake.
    body = `Confidence: n/a (allow)\nReason: ${result.reason}`;
  }

  const userMessage = [header, target, body].join("\n");

  return {
    claudeMessage: CLAUDE_DENY_MESSAGE,
    userMessage,
  };
}
