/**
 * Helper functions for creating PermissionRequest hook responses
 * Based on Claude Code hook specification and cc-hooks-ts types
 */

/**
 * Permission update structure (matches cc-hooks-ts PermissionUpdate)
 */
type PermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      behavior: "allow" | "deny" | "ask";
      destination:
        | "userSettings"
        | "projectSettings"
        | "localSettings"
        | "session"
        | "cliArg";
      rules: Array<{ toolName: string; ruleContent?: string }>;
    }
  | {
      type: "setMode";
      destination:
        | "userSettings"
        | "projectSettings"
        | "localSettings"
        | "session"
        | "cliArg";
      mode:
        | "acceptEdits"
        | "bypassPermissions"
        | "default"
        | "dontAsk"
        | "plan";
    }
  | {
      type: "addDirectories" | "removeDirectories";
      destination:
        | "userSettings"
        | "projectSettings"
        | "localSettings"
        | "session"
        | "cliArg";
      directories: string[];
    };

/**
 * PermissionRequest allow response structure (matches cc-hooks-ts PermissionRequestHookOutput)
 */
type PermissionRequestAllowResponse = {
  hookSpecificOutput?: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    };
  };
};

/**
 * PermissionRequest deny response structure (matches cc-hooks-ts PermissionRequestHookOutput)
 *
 * `systemMessage` lives on the CommonHookOutputs mixin, not inside
 * `hookSpecificOutput`. Claude Code renders it to the user.
 */
type PermissionRequestDenyResponse = {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };
  };
};

/**
 * Union type for all PermissionRequest responses
 */
export type PermissionRequestResponse =
  | PermissionRequestAllowResponse
  | PermissionRequestDenyResponse;

/**
 * Create an allow response for PermissionRequest hook
 *
 * @param updatedInput - Optional modified tool input
 * @param updatedPermissions - Optional permission updates to apply
 */
export function createPermissionRequestAllowResponse(
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: PermissionUpdate[],
): PermissionRequestAllowResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        ...(updatedInput && { updatedInput }),
        ...(updatedPermissions && { updatedPermissions }),
      },
    },
  };
}

/**
 * Create a deny response for PermissionRequest hook
 *
 * @param message - Message explaining why the request was denied (visible to Claude)
 * @param interrupt - If true, stops Claude's current task (default: false)
 * @param systemMessage - Optional user-facing detailed message rendered by the UI
 */
export function createPermissionRequestDenyResponse(
  message: string,
  interrupt = false,
  systemMessage?: string,
): PermissionRequestDenyResponse {
  return {
    ...(systemMessage !== undefined && { systemMessage }),
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message,
        ...(interrupt && { interrupt }),
      },
    },
  };
}
