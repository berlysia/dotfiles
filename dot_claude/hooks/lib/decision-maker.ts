/**
 * Decision making functions for permission handling
 * TypeScript conversion of decision-maker.sh
 */

import type {
  HookOutput,
  PermissionDecision,
  CommandAnalysisResult,
} from "../types/hooks-types.ts";

/**
 * Create hook output JSON with decision
 */
export function createHookOutput(
  decision: PermissionDecision,
  reason: string
): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Output JSON decision to stdout
 */
export function outputDecision(decision: PermissionDecision, reason: string): void {
  const output = createHookOutput(decision, reason);
  console.log(JSON.stringify(output, null, 2));
}


/**
 * Analyze individual command results for Bash tool
 */
export function analyzeBashCommandResults(
  results: string[],
  denyMatches: string[]
): CommandAnalysisResult {
  // If any command is denied, block the entire operation
  if (denyMatches.length > 0) {
    return {
      decision: "deny",
      reason: `One or more commands blocked: ${denyMatches.join(", ")}`,
    };
  }

  // Check if ALL commands are explicitly allowed
  const allAllowed = results.length > 0 && results.every((result) =>
    result.startsWith("ALLOW:")
  );

  if (allAllowed) {
    return {
      decision: "allow",
      reason: "All individual commands explicitly allowed",
    };
  }

  return {
    decision: "ask",
    reason: "Not all commands explicitly allowed",
  };
}

/**
 * Analyze pattern matches for non-Bash tools
 */
export function analyzePatternMatches(
  allowMatches: string[],
  denyMatches: string[]
): CommandAnalysisResult {
  if (denyMatches.length > 0) {
    return {
      decision: "deny",
      reason: `Matched deny patterns: ${denyMatches.join(", ")}`,
    };
  }

  if (allowMatches.length > 0) {
    return {
      decision: "allow",
      reason: `Matched allow patterns: ${allowMatches.join(", ")}`,
    };
  }

  return {
    decision: "ask",
    reason: "No patterns matched",
  };
}

/**
 * Generic decision analysis that combines results
 */
export function makeDecision(
  allowMatches: string[] = [],
  denyMatches: string[] = [],
  commandResults?: string[]
): CommandAnalysisResult {
  // For Bash tools with command results
  if (commandResults && commandResults.length > 0) {
    return analyzeBashCommandResults(commandResults, denyMatches);
  }

  // For other tools with pattern matching
  return analyzePatternMatches(allowMatches, denyMatches);
}

/**
 * Create final output for a decision
 */
export function finalizeDecision(result: CommandAnalysisResult): void {
  outputDecision(result.decision, result.reason);
}