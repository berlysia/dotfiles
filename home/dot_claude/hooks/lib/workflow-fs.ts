import { realpathSync } from "node:fs";

/**
 * Resolve `absPath` through symlinks and ensure the resolved path stays
 * under `wfDir` (workflow directory). Returns null when:
 *   - the path does not exist (realpathSync throws ENOENT)
 *   - the resolved path escapes wfDir (symlink redirection / traversal)
 *
 * Used by P9 / P10 / P12 hooks (plan-1) to defend against unintended file
 * reads via symlinks pointing outside the workflow directory. Spec K7 / Sec3.
 */
export function realpathInsideWorkflowDir(
  absPath: string,
  wfDir: string,
): string | null {
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    return null;
  }
  if (resolved !== wfDir && !resolved.startsWith(`${wfDir}/`)) {
    return null;
  }
  return resolved;
}
