/**
 * Message formatting for PermissionRequest deny responses.
 *
 * Both messages carry the same detailed rationale. `systemMessage` is the
 * top-level CommonHookOutputs field (rendered by the CLI when supported);
 * `claudeMessage` is `decision.message` (delivered to Claude, who relays the
 * reason to the user in its next response). Duplicating the content is
 * intentional so the user always sees the rationale regardless of which
 * channel the CLI honors.
 */

import type {
  LLMEvaluationResult,
  PermissionRequestInput,
} from "./structured-llm-evaluator.ts";

export const CLAUDE_DENY_MESSAGE_PREFIX =
  "Denied by automated review. Please relay this reason to the user verbatim so they can decide whether to retry or modify the command:";

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
 * Build the messages used for a deny decision.
 *
 * `userMessage` is the detailed rationale surfaced via `systemMessage` (CLI
 * top-level) for direct UI rendering when supported. `claudeMessage` is the
 * same rationale prefixed with an instruction asking Claude to forward it
 * verbatim, guaranteeing the user sees the reason even if the CLI does not
 * render `systemMessage` for PermissionRequest denies.
 */
export function buildUserMessage(
  result: LLMEvaluationResult,
  input: PermissionRequestInput,
): UserMessageParts {
  const summary = summarizeToolInput(input);
  const header = `Permission blocked: ${input.tool_name}`;
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
    body = `Confidence: n/a (allow)\nReason: ${result.reason}`;
  }

  const userMessage = [header, target, body].join("\n");
  const claudeMessage = `${CLAUDE_DENY_MESSAGE_PREFIX}\n\n${userMessage}`;

  return {
    claudeMessage,
    userMessage,
  };
}
