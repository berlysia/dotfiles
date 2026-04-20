/**
 * Type definitions for PermissionRequest hooks
 *
 * Note: LLM evaluation is handled by prompt-type hooks in settings.json
 * which uses Claude Code's internal LLM (no API key required)
 */

/**
 * Input structure for PermissionRequest evaluation
 */
export interface PermissionRequestInput {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/**
 * LLM evaluation result variants.
 * - `allow`: LLM approved the request
 * - `deny`: LLM denied the request with a confidence level that controls UI severity
 * - `parse-error`: LLM response could not be parsed; fail-safe to `interrupt: true`
 */
export type LLMEvaluationResult =
  | { kind: "allow"; reason: string }
  | {
      kind: "deny";
      reason: string;
      confidence: "high" | "medium" | "low";
    }
  | { kind: "parse-error"; rawText: string };
