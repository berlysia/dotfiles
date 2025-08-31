/**
 * Helper functions for creating proper hook responses
 * Based on cc-hooks-ts library type definitions
 */

import type { PreToolUseHookOutput, PermissionDecision } from "../types/hooks-types.ts";

/**
 * Type for cc-hooks-ts JSON response format
 */
type HookJSONResponse = {
  event: "PreToolUse";
  output: PreToolUseHookOutput;
};

/**
 * Create a properly formatted PreToolUse response for cc-hooks-ts
 */
export function createPreToolUseResponse(
  decision: PermissionDecision,
  reason: string
): HookJSONResponse {
  return {
    event: "PreToolUse",
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    },
  };
}

/**
 * Helper to create an "ask" response (user confirmation required)
 * This should be used when manual review is needed
 */
export function createAskResponse(reason: string): HookJSONResponse {
  return createPreToolUseResponse("ask", reason);
}

/**
 * Helper to create a "deny" response (block the operation)
 * This should be used for security violations or prohibited operations
 */
export function createDenyResponse(reason: string): HookJSONResponse {
  return createPreToolUseResponse("deny", reason);
}

/**
 * Helper to create an "allow" response (auto-approve)
 * This should be used for safe operations
 */
export function createAllowResponse(reason: string): HookJSONResponse {
  return createPreToolUseResponse("allow", reason);
}

