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
function parseSectionPaths(content: string, heading: string): string[] {
  const sections = content.split(/^##\s+/m);
  const section = sections.find(
    (s) => (s.split("\n")[0] ?? "").trim() === heading,
  );
  if (!section) return [];
  const body = section.slice(section.indexOf("\n") + 1);
  const collected: string[] = [];
  for (const match of body.matchAll(/^```[^\n]*\n([\s\S]*?)\n```/gm)) {
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

export function parseFilesPaths(planContent: string): string[] {
  return parseSectionPaths(planContent, "Files");
}

/** The question from `workflow-cli ask-approval` shows every entry, so the count is capped. */
export const MAX_SCOPE_ENTRIES = 16;

// The question from `workflow-cli ask-approval` shows each entry as written,
// so an entry may only use characters and a length that read unambiguously.
const SCOPE_ENTRY_PATTERN = /^[A-Za-z0-9._/@+-]+$/;
const MAX_SCOPE_ENTRY_LENGTH = 120;

export type ScopeParse =
  | { valid: true; entries: string[] }
  | { valid: false; reason: "empty" | "too-many" | "invalid-entry" };

/**
 * spec.md's `## Scope`: the paths a delegated plan-N.md may write. An entry
 * ending in `/` is a directory, any other entry a file. One entry that could
 * reach outside the checkout invalidates the whole section.
 */
export function parseScope(specContent: string): ScopeParse {
  const entries = parseSectionPaths(specContent, "Scope");
  if (entries.length === 0) return { valid: false, reason: "empty" };
  if (entries.length > MAX_SCOPE_ENTRIES) {
    return { valid: false, reason: "too-many" };
  }
  const unsafe = (entry: string) => {
    if (entry.length > MAX_SCOPE_ENTRY_LENGTH) return true;
    if (!SCOPE_ENTRY_PATTERN.test(entry)) return true;
    // A directory entry ends in "/", which leaves one trailing empty
    // segment; every other segment must name something.
    const segments = entry.split("/");
    const named = entry.endsWith("/") ? segments.slice(0, -1) : segments;
    return (
      named.length === 0 ||
      named.some((s) => s === "" || s === "." || s === "..")
    );
  };
  return entries.some(unsafe)
    ? { valid: false, reason: "invalid-entry" }
    : { valid: true, entries };
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

const PROTECTED_LEADING: readonly (readonly string[])[] = [
  ["docs", "decisions"],
  [".skills"],
  [".github", "workflows"],
  [".git"],
  [".tmp", "sessions"],
];
const PROTECTED_DIR_NAMES = new Set([".claude", "dot_claude"]);
const PROTECTED_FILE_NAMES = new Set(["claude.md", "agents.md", "context.md"]);

/**
 * Whether a path is one a delegated plan-N.md may never write: the approval
 * mechanism, the decision records and the instructions the model follows.
 * Judged on the resolved path relative to its checkout, without case, so a
 * symlink or a differently-cased spelling does not get around it. null when
 * the path cannot be resolved; the caller must not treat that as "not
 * protected".
 */
export function isProtectedPath(
  absolute: string,
  projectRoot: string,
  kind: "file" | "dir",
): boolean | null {
  const real = resolveWithMissingTail(resolve(absolute));
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (real === null || realRoot === null) return null;
  const toplevel = findRepoToplevel(real, realRoot);
  if (real === toplevel) return false;
  // Resolved out of the checkout (a symlink to somewhere else): the rules
  // below are about paths inside it, so this is "cannot tell", not "no".
  if (!real.startsWith(`${toplevel}/`)) return null;
  const segments = real
    .slice(toplevel.length + 1)
    .toLowerCase()
    .split("/");
  if (
    PROTECTED_LEADING.some((prefix) =>
      prefix.every((s, i) => segments[i] === s),
    )
  ) {
    return true;
  }
  const dirSegments = kind === "dir" ? segments : segments.slice(0, -1);
  if (dirSegments.some((s) => PROTECTED_DIR_NAMES.has(s))) return true;
  if (kind === "dir") return false;
  return PROTECTED_FILE_NAMES.has(
    (segments.at(-1) ?? "").replace(/\.tmpl$/, ""),
  );
}

/**
 * A Scope entry's path, when no component of it is a symlink. A link could
 * point the entry at the checkout root or another directory, and a directory
 * inside the Scope could be swapped for one after the approval; either way
 * the entry would cover more than the user was shown. `base` is a realpath.
 */
function resolveScopeEntry(base: string, entry: string): string | null {
  const lexical = resolve(base, entry);
  return resolveWithMissingTail(lexical) === lexical ? lexical : null;
}

function scopeContains(
  entries: readonly string[],
  realTarget: string,
  base: string,
): boolean {
  return entries.some((entry) => {
    const real = resolveScopeEntry(base, entry);
    if (real === null) return false;
    return entry.endsWith("/")
      ? realTarget.startsWith(`${real}/`)
      : realTarget === real;
  });
}

export type ScopeVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "scope-invalid"
        | "no-files"
        | "outside-scope"
        | "protected"
        | "unresolvable";
    };

/** Whether every `## Files` entry of a plan-N.md lies within spec.md's `## Scope` and none is protected. */
export function planFilesWithinScope(
  planContent: string,
  specContent: string,
  projectRoot: string,
): ScopeVerdict {
  const scope = parseScope(specContent);
  if (!scope.valid) return { ok: false, reason: "scope-invalid" };
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realRoot === null) return { ok: false, reason: "unresolvable" };
  const files = parseFilesPaths(planContent);
  if (files.length === 0) return { ok: false, reason: "no-files" };
  for (const entry of files) {
    // `resolve` would fold `..` lexically, which is not the path the kernel
    // opens when a component before it is a symlink.
    if (
      entry.startsWith("/") ||
      entry.startsWith("~") ||
      entry.split("/").includes("..")
    ) {
      return { ok: false, reason: "outside-scope" };
    }
    const real = resolveWithMissingTail(resolve(realRoot, entry));
    if (real === null) return { ok: false, reason: "unresolvable" };
    const isProtected = isProtectedPath(real, realRoot, "file");
    if (isProtected === null) return { ok: false, reason: "unresolvable" };
    if (isProtected) return { ok: false, reason: "protected" };
    if (!scopeContains(scope.entries, real, realRoot)) {
      return { ok: false, reason: "outside-scope" };
    }
  }
  return { ok: true };
}

/** Whether one write target lies within spec.md's `## Scope` and is not protected. */
export function targetWithinScope(
  specContent: string,
  target: string,
  projectRoot: string,
): boolean {
  const scope = parseScope(specContent);
  if (!scope.valid) return false;
  const realTarget = resolveWithMissingTail(resolve(target));
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realTarget === null || realRoot === null) return false;
  if (isProtectedPath(realTarget, realRoot, "file") !== false) return false;
  return scopeContains(
    scope.entries,
    realTarget,
    findRepoToplevel(realTarget, realRoot),
  );
}

export interface ScopeRow {
  entry: string;
  /** Delegation never covers this row (or it could not be resolved). */
  protected: boolean;
}

/**
 * The `## Scope` rows as the delegation question shows them. null when the
 * Scope is invalid or no row can be delegated: there is nothing to offer.
 */
export function scopeRowsForOffer(
  specContent: string,
  projectRoot: string,
): ScopeRow[] | null {
  const scope = parseScope(specContent);
  if (!scope.valid) return null;
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realRoot === null) return null;
  const rows = scope.entries.map((entry) => ({
    entry,
    protected:
      resolveScopeEntry(realRoot, entry) === null ||
      isProtectedPath(
        resolve(realRoot, entry),
        realRoot,
        entry.endsWith("/") ? "dir" : "file",
      ) !== false,
  }));
  return rows.every((row) => row.protected) ? null : rows;
}
