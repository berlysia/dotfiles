import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolve `absPath` through symlinks and ensure the resolved path stays
 * under `wfDir` (workflow directory). Returns null when:
 *   - the path does not exist (realpathSync throws ENOENT)
 *   - the resolved path escapes wfDir (symlink redirection / traversal)
 *
 * Used by P9 / P10 / P12 hooks (plan-1) to defend against unintended file
 * reads via symlinks pointing outside the workflow directory. Spec K7 / Sec3.
 *
 * Accepts `wfDir` itself, and returns null for a path that does not exist yet.
 * `isStrictlyUnderProjectSubdir` below is the opposite on both counts: it
 * rejects its base, and it accepts a not-yet-created descendant. Do not merge
 * them.
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

/**
 * Decide whether `candidate` lies strictly inside `<projectRoot>/<subdir>`.
 *
 * Deliberately NOT shared with `realpathInsideWorkflowDir` above: that one
 * ACCEPTS the base itself (writing to the workflow dir is legitimate), this one
 * REJECTS it (accepting `.tmp/sessions` as a workflow dir would make every
 * session share one directory). They are opposite on absence too: that one
 * returns null for a path that does not exist yet, this one accepts a
 * not-yet-created descendant, because a pin may name a session dir before
 * anything has been written to it. Merging them would flip both cases and
 * silently reopen the hole spec K11 names.
 *
 * Three escapes are closed, in the order the checks appear:
 *
 * 1. The base must be the literal `<root>/<subdir>` after resolution. If that
 *    path is a symlink, the containment basis has moved and the answer is
 *    meaningless -- whether it moved outside the project or merely to another
 *    directory inside it. Checking only "the base is still under the root"
 *    passes `.tmp/sessions -> docs/`.
 * 2. Both sides resolve against the same realpathed root, so a project reached
 *    through a symlink does not reject its own legitimate children, while a
 *    child that redirects out of the project does get rejected.
 * 3. The candidate must be a strict descendant: equal to the base is rejected,
 *    and the trailing separator stops `.tmp/sessions-evil` from matching.
 *
 * `ENOENT` is the only resolution failure that falls back to lexical
 * comparison, and it does so because a path that does not exist cannot host
 * anything. `ELOOP` and `EACCES` do not mean "absent" -- they mean the
 * verification did not run -- so they yield not-contained. Treating every
 * error as absent would report a symlink loop under the subdir as contained.
 *
 * Check-then-use is per invocation. A symlink swapped in afterwards redirects
 * later writes; that is accepted under the anti-drift threat model in spec.
 */
export function isStrictlyUnderProjectSubdir(
  projectRoot: string,
  subdir: string,
  candidate: string,
): boolean {
  const root = resolveWithMissingTail(resolve(projectRoot));
  if (root === null) {
    return false;
  }
  const lexicalBase = resolve(root, subdir);
  const base = resolveWithMissingTail(lexicalBase);
  if (base === null || base !== lexicalBase) {
    return false;
  }
  const resolved = resolveWithMissingTail(resolve(root, candidate));
  if (resolved === null) {
    return false;
  }
  return resolved !== base && resolved.startsWith(`${base}/`);
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
 * Precondition: `path` is absolute and already lexically normalised (every
 * caller here passes it through `resolve`). Node's `realpathSync` applies `..`
 * lexically before resolving, unlike POSIX `realpath(3)`, so a caller that
 * skips normalisation gets an answer about a different path than the kernel
 * would open.
 */
function resolveWithMissingTail(path: string): string | null {
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
