/**
 * Decision making functions for permission handling
 * TypeScript conversion of decision-maker.sh
 */

import type { CommandAnalysisResult } from "../types/project-types.ts";

/**
 * Analyze pattern matches for non-Bash tools
 */
export function analyzePatternMatches(
  allowMatches: string[],
  denyMatches: string[],
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

