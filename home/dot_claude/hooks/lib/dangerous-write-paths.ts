/**
 * Path fragments a file-writing tool is never auto-approved for. Both the
 * PreToolUse hook (auto-approve) and the PermissionRequest hook
 * (permission-auto-approve) consult this one list, so a PreToolUse "allow"
 * cannot skip a check the second layer would have applied.
 */
const DANGEROUS_WRITE_PATH_PARTS = [
  "/etc/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/.ssh/",
  "/.gnupg/",
  "/.aws/",
  "/credentials",
  "/.env",
] as const;

export function isDangerousWritePath(filePath: string): boolean {
  return DANGEROUS_WRITE_PATH_PARTS.some((part) => filePath.includes(part));
}
