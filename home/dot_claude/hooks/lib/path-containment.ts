import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Realpath as much of `path` as exists, then re-append the missing tail.
 *
 * Returns null when the path cannot be resolved for any reason other than a
 * component simply not existing yet -- `ELOOP`, `EACCES`, an invalid argument,
 * or a dangling symlink. Those all mean the verification did not run, which is
 * not the same as "there is nothing here", and the caller must not fall back to
 * comparing strings.
 *
 * Walking up is what separates the two: `realpathSync` throws `ENOENT` for the
 * whole path no matter which component is missing, so resolving only the full
 * path would accept `<sessions>/link-to-elsewhere/not-yet` -- lexically inside,
 * really outside.
 *
 * Precondition: `path` is absolute and already lexically normalised (every
 * caller here passes it through `resolve`). Node's `realpathSync` applies `..`
 * lexically before resolving, unlike POSIX `realpath(3)`, so a caller that
 * skips normalisation gets an answer about a different path than the kernel
 * would open.
 */
export function resolveWithMissingTail(path: string): string | null {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return null;
      }
    }
    // ENOENT with an entry present means a dangling symlink: it exists, it just
    // does not resolve. That is unresolvable, not absent.
    if (entryExists(current)) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    missing.unshift(basename(current));
    current = parent;
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function hasParentSegment(p: string): boolean {
  return p.split("/").includes("..");
}

export function isUnderRoot(p: string, root: string): boolean {
  // "/" is the only normalized root that already ends with a separator.
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}
