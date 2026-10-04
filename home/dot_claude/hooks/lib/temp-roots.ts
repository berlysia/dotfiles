import { resolve } from "node:path";
import { hasParentSegment } from "./path-containment.ts";

// os.tmpdir() follows $TMPDIR, which a project's .claude/settings.json `env` can
// override. Accepting only the exact macOS per-user shape keeps a hostile value
// (`/`, `/var`, `~/.ssh`, the `C/` cache dir, ...) from becoming a writable root.
const MACOS_USER_TMPDIR_SHAPE = /^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/T$/;

/**
 * Directories the OS hands out for temporary files: `/tmp` and the per-user
 * tmpdir, each in literal and realpath form (macOS: /tmp -> /private/tmp,
 * /var -> /private/var), so a path is recognised however it was spelled.
 */
export function collectTempRoots(
  tmpdir: string,
  realpath: (p: string) => string,
): string[] {
  const roots = new Set<string>(["/tmp"]);
  const addRealpath = (p: string, accept: (form: string) => boolean): void => {
    try {
      const real = realpath(p);
      if (accept(real)) roots.add(real);
    } catch {
      // Only the literal form is kept when the path cannot be resolved.
    }
  };

  // /tmp is OS-owned, so its realpath is trusted without a shape check.
  addRealpath("/tmp", () => true);

  // Checked before resolve(): resolve("") / resolve("tmp") would silently become the cwd.
  if (tmpdir.startsWith("/") && !hasParentSegment(tmpdir)) {
    const literal = resolve(tmpdir); // strips the trailing slash macOS $TMPDIR carries
    const accepted = (form: string): boolean =>
      MACOS_USER_TMPDIR_SHAPE.test(form);
    if (accepted(literal)) roots.add(literal);
    addRealpath(literal, accepted);
  }

  return [...roots];
}
