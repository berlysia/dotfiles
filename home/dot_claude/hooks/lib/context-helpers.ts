/**
 * Helper functions for creating proper hook responses
 * Based on cc-hooks-ts library type definitions
 */

import type { PreToolUseHookOutput } from "../types/project-types.ts";

/**
 * Type for cc-hooks-ts JSON response format
 */
type HookJSONResponse = {
  event: "PreToolUse";
  output: PreToolUseHookOutput;
};

/**
 * Type for explicit permission decisions (excludes "pass" since it doesn't use JSON responses)
 */
type ExplicitPermissionDecision = "allow" | "deny" | "ask";

/**
 * Create a properly formatted PreToolUse response for cc-hooks-ts
 * Note: "pass" decisions should use context.success() directly, not JSON responses
 */
function createPreToolUseResponse(
  decision: ExplicitPermissionDecision,
  reason: string,
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

const STOP_AND_REPORT =
  "stop and tell the user what you were trying to do and why";

/**
 * Appended to denies that protect a target, not to denies that redirect to an alternative.
 * The agent reads this at the moment it decides what to do next.
 */
export const BOUNDARY_DENY_GUIDANCE = `This is a protection boundary. Do not retry the same effect with a different command, tool, or language. If the operation is needed, ${STOP_AND_REPORT}.`;

export function createBoundaryDenyResponse(reason: string): HookJSONResponse {
  return createDenyResponse(`${reason}\n\n${BOUNDARY_DENY_GUIDANCE}`);
}

/**
 * For Bash denies whose reason carries a `Matched:` line for every denied
 * fragment. Those rules read the command's spelling, so they also fire on
 * text the agent only passed as data. The split is on what the matched text
 * is, which the agent can read off the reason, not on what the agent meant.
 * The text grants nothing by pointing at the reason: the reason quotes the
 * command, which the agent (or text the agent copied) controls.
 */
export const MATCHED_TEXT_DENY_GUIDANCE = `This is a protection boundary, and the guard read the spelling of your command, not what it would do. Read the Matched line above. If the matched text is part of what you meant to run, do not retry with a different command, tool, or language, and do not split or reword it: ${STOP_AND_REPORT}. Text handed to a shell, an interpreter, eval, xargs, ssh or a -c option, and text the shell itself expands (a command substitution or a process substitution), is something you meant to run, not data. If the matched text is only data you passed to a command that does not execute it (a search pattern, a commit message, a heredoc body for cat or tee), you may re-send once with the shape changed and nothing else: send each command of a \`;\` / \`&&\` chain as its own Bash call, unchanged, or move that text into a file with the Write tool and pass it through the command's own file option. Same executables, same targets. Never put anything that will be run in that file. If it is denied again, stop and tell the user.`;

export function createMatchedTextDenyResponse(
  reason: string,
): HookJSONResponse {
  return createDenyResponse(`${reason}\n\n${MATCHED_TEXT_DENY_GUIDANCE}`);
}

const REASON_QUOTE_LIMIT = 200;

/**
 * A piece of tool input quoted in a reason: the command in a deny reason that
 * carries a `Matched:` line, and every input line of an ask reason. Line
 * breaks become a literal `\n` so the quote cannot start a line that reads
 * like the guard's own, and a quote long enough to push the rest of the
 * reason out of view is cut. Unlike sanitizeForDisplay, the spelling is kept.
 */
export function shortenForReason(text: string): string {
  // Zl and Zp are the Unicode line and paragraph separators; a regex literal
  // cannot hold those two characters raw.
  const oneLine = text.replace(/\r\n|[\r\n\p{Zl}\p{Zp}]/gu, "\\n");
  return oneLine.length > REASON_QUOTE_LIMIT
    ? `${oneLine.slice(0, REASON_QUOTE_LIMIT)}… (${oneLine.length} characters)`
    : oneLine;
}

type AskInputLabel = "Command" | "File";

/**
 * The reason of an ask: the fixed message first, then one `<label>: <input>`
 * line per piece of tool input. Build every ask reason that shows tool input
 * with this, so the dialog reads the same whichever hook raised it and a
 * count keyed on the start of the message keeps working. Each input goes
 * through shortenForReason, so it stays on its own line and a long one cannot
 * push the message out of view.
 */
export function formatAskReason(
  message: string,
  label: AskInputLabel,
  inputs: readonly string[],
): string {
  return [
    message,
    ...inputs.map((input) => `${label}: ${shortenForReason(input)}`),
  ].join("\n");
}

/**
 * Helper to create an "allow" response (auto-approve)
 * This should be used for safe operations
 */
export function createAllowResponse(reason: string): HookJSONResponse {
  return createPreToolUseResponse("allow", reason);
}
