/**
 * `## Files` section parsing shared by workflow-gate (which matches entries
 * against a target) and review selection (which only needs the raw paths).
 * One parser so the two never disagree on what a plan lists.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandTilde } from "./path-utils.ts";
import { resolveWithMissingTail } from "./workflow-fs.ts";

const PROSE_EXTENSIONS = [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"];

/**
 * Raw project-relative paths from the fenced code blocks under `## Files`.
 * `#` lines and blank lines are skipped. A block containing any line with
 * internal whitespace is dropped whole (conservative: a malformed block must
 * not partially authorize writes in the guard).
 */
export function parseFilesPaths(planContent: string): string[] {
  const sections = planContent.split(/^##\s+/m);
  const filesSection = sections.find((s) =>
    /^Files\s*$/m.test(s.split("\n")[0] ?? ""),
  );
  if (!filesSection) return [];
  const sectionBody = filesSection.replace(/^Files\s*\n/, "");
  const collected: string[] = [];
  for (const match of sectionBody.matchAll(/^```[^\n]*\n([\s\S]*?)\n```/gm)) {
    const block = match[1];
    if (block === undefined) continue;
    const blockPaths: string[] = [];
    let blockValid = true;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (/\s/.test(line)) {
        blockValid = false;
        break;
      }
      blockPaths.push(line);
    }
    if (blockValid) collected.push(...blockPaths);
  }
  return collected;
}

/**
 * True when `## Files` lists at least one path and every path is prose.
 * Code-quality reviewers (security, resilience, ...) have nothing to review
 * in such a change. Missing/empty Files returns false so the caller falls
 * back to keyword selection (spec.md never has Files).
 */
export function isProseOnlyChange(planContent: string): boolean {
  const paths = parseFilesPaths(planContent);
  if (paths.length === 0) return false;
  return paths.every((p) => {
    const lower = p.toLowerCase().replace(/\.tmpl$/, "");
    return PROSE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
}

/**
 * The checkout a target belongs to, for resolving relative `## Files`
 * entries (spec K2). Walks up from the target to the first dir holding
 * `.git`, and accepts it only when it is the project root or a linked
 * worktree of the same repository (its `.git` file points under
 * `<root>/.git/worktrees/`, where git keeps worktree metadata -- not
 * `<root>/.git/worktree/`, where this repo's convention puts the checkouts).
 * Anything else -- a nested clone, another repository, a sibling worktree
 * when the session itself started in a worktree -- falls back to the root,
 * so the same relative path elsewhere never matches. Both arguments are
 * realpaths; the walk stops at the root.
 */
export function findRepoToplevel(realTarget: string, realRoot: string): string {
  let dir = realTarget;
  for (;;) {
    if (dir === realRoot) return realRoot;
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      return isWorktreeOf(dir, dotGit, realRoot) ? dir : realRoot;
    }
    const parent = dirname(dir);
    if (parent === dir) return realRoot;
    dir = parent;
  }
}

function isWorktreeOf(dir: string, dotGit: string, realRoot: string): boolean {
  try {
    if (!statSync(dotGit).isFile()) return false;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
    if (!match?.[1]) return false;
    const gitdir = resolveWithMissingTail(resolve(dir, match[1]));
    return gitdir !== null && gitdir.startsWith(`${realRoot}/.git/worktrees/`);
  } catch {
    return false;
  }
}

/**
 * Whether the plan's `## Files` lists the target. Relative entries resolve
 * against the target's checkout (findRepoToplevel); absolute and `~/`
 * entries stand as written. Every side is compared as a realpath so a
 * lexical path is never compared with a physical one (workflow-resolve.ts
 * keeps the same rule). Returns false when the target or the root has no
 * realpath (a dangling symlink on the way).
 */
export function listsTarget(
  planContent: string,
  target: string,
  projectRoot: string,
): boolean {
  const realTarget = resolveWithMissingTail(resolve(target));
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realTarget === null || realRoot === null) return false;
  const toplevel = findRepoToplevel(realTarget, realRoot);
  return parseFilesPaths(planContent).some((entry) => {
    const expanded = expandTilde(entry);
    const absolute = expanded.startsWith("/")
      ? resolve(expanded)
      : resolve(toplevel, expanded);
    return resolveWithMissingTail(absolute) === realTarget;
  });
}
