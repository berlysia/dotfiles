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
