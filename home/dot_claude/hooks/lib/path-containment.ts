import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface PathFs {
  realpath(p: string): string;
  lstat(p: string): unknown;
}

const nodeFs: PathFs = { realpath: realpathSync, lstat: lstatSync };

export type ParentSegmentCheck =
  | { ok: true }
  | { ok: false; kind: "absolute" | "relative" };

/**
 * An absolute path may not contain `..` at all. A relative path may only
 * start with `..` segments: from a physical cwd, going up never crosses a
 * symlink, while `sub/sym/..` resolves differently depending on whether the
 * opener collapses it lexically or lets the kernel walk it.
 */
export function checkParentSegments(path: string): ParentSegmentCheck {
  const segments = path.split("/");
  if (path.startsWith("/")) {
    return segments.includes("..")
      ? { ok: false, kind: "absolute" }
      : { ok: true };
  }
  let seenName = false;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      seenName = true;
      continue;
    }
    if (seenName) return { ok: false, kind: "relative" };
  }
  return { ok: true };
}

export type PhysicalPath =
  | { ok: true; path: string }
  | { ok: false; code: string };

export function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "EUNKNOWN";
}

/**
 * Where an absolute, `..`-free path lands after every symlink is followed.
 * A path that does not exist yet resolves through its nearest existing
 * ancestor. Never throws: anything that prevents the check from running is
 * returned as a code, so the caller can deny with a reason instead of
 * crashing.
 */
export function resolvePhysicalPath(
  absPath: string,
  fs: PathFs = nodeFs,
): PhysicalPath {
  if (!absPath.startsWith("/") || absPath.includes("\0")) {
    return { ok: false, code: "EINVAL" };
  }
  if (hasParentSegment(absPath)) {
    return { ok: false, code: "EPARENT" };
  }
  const missing: string[] = [];
  let current = absPath;
  for (;;) {
    try {
      const real = fs.realpath(current);
      return {
        ok: true,
        path: missing.length === 0 ? real : join(real, ...missing),
      };
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT") return { ok: false, code };
    }
    // ENOENT with an entry present means a dangling symlink.
    try {
      fs.lstat(current);
      return { ok: false, code: "EDANGLING" };
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT") return { ok: false, code };
    }
    const parent = dirname(current);
    if (parent === current) return { ok: false, code: "ENOENT" };
    missing.unshift(basename(current));
    current = parent;
  }
}

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
 * Also null: a path that is not absolute or contains a `..` segment (Node's
 * `realpathSync` applies `..` lexically before resolving, unlike POSIX
 * `realpath(3)`, so the answer would be about a different path than the kernel
 * would open), and a failed `lstat` of any kind other than `ENOENT`.
 */
export function resolveWithMissingTail(path: string): string | null {
  const resolved = resolvePhysicalPath(path);
  return resolved.ok ? resolved.path : null;
}

export function hasParentSegment(p: string): boolean {
  return p.split("/").includes("..");
}

export function isUnderRoot(p: string, root: string): boolean {
  // "/" is the only normalized root that already ends with a separator.
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}
