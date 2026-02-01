/**
 * Helper functions for creating PermissionRequest hook responses
 * Based on Claude Code hook specification
 */

/**
 * PermissionRequest allow response structure
 */
type PermissionRequestAllowResponse = {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Array<{ type: string; tool?: string }>;
    };
  };
};

/**
 * PermissionRequest deny response structure
 */
type PermissionRequestDenyResponse = {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "deny";
      message: string;
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
  updatedPermissions?: Array<{ type: string; tool?: string }>,
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
 * @param message - Message explaining why the request was denied
 * @param interrupt - If true, stops Claude's current task (default: false)
 */
export function createPermissionRequestDenyResponse(
  message: string,
  interrupt = false,
): PermissionRequestDenyResponse {
  return {
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
