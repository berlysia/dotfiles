import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  errnoOf,
  isUnderRoot,
  type PathFs,
  resolvePhysicalPath,
} from "./path-containment.ts";

// Copied from https://code.claude.com/docs/en/permission-modes.md "Protected paths",
// fetched 2026-10-06 for Claude Code 2.1.291. `ask` permission rules need this version or later.
// Inside a verified worktree core sees every path as under .git, so the hook judges with this copy.
export const CORE_PROTECTED_SOURCE =
  "permission-modes.md#protected-paths 2026-10-06 2.1.291";

// Lower case: APFS compares names without case.
const CORE_PROTECTED_DIRS = [
  ".git",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
  ".claude",
];
const CORE_PROTECTED_DIR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [".config", "git"],
];
const CORE_PROTECTED_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
];
// The dot rule outside worktrees covers every other core name.
export const CORE_PROTECTED_NON_DOT = CORE_PROTECTED_FILES.filter(
  (name) => !name.startsWith("."),
);

export type HoldRule = "outside" | "worktree";
export interface HoldNameContext {
  home: string;
  chezmoiSource: string;
}

function segmentsOf(path: string): string[] {
  return path
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

function chezmoiGitSourceReason(
  path: string,
  chezmoiSource: string,
): string | null {
  const prefix = `${chezmoiSource.toLowerCase()}/`;
  const lower = path.toLowerCase();
  if (!lower.startsWith(prefix)) return null;
  const [first, second] = segmentsOf(lower.slice(prefix.length));
  if (first?.includes("dot_gitconfig"))
    return "chezmoi source of the global git config";
  if (first?.endsWith("dot_config") && second?.endsWith("git"))
    return "chezmoi source of ~/.config/git";
  return null;
}

export function findHoldSegment(
  path: string,
  rule: HoldRule,
  ctx: HoldNameContext,
): string | null {
  const segs = segmentsOf(path);
  if (rule === "outside") {
    const dot = segs.find((s) => s.startsWith(".") && s !== "..");
    if (dot) return `dot segment ${dot}`;
    const nonDot = segs.find((s) => CORE_PROTECTED_NON_DOT.includes(s));
    if (nonDot) return `protected name ${nonDot}`;
    return chezmoiGitSourceReason(path, ctx.chezmoiSource);
  }
  for (const [i, s] of segs.entries()) {
    if (CORE_PROTECTED_DIRS.includes(s) || CORE_PROTECTED_FILES.includes(s))
      return `protected name ${s}`;
    const pair = CORE_PROTECTED_DIR_PAIRS.find(
      ([a, b]) => s === a && segs[i + 1] === b,
    );
    if (pair) return `protected name ${pair[0]}/${pair[1]}`;
  }
  return null;
}

export type HoldFs = PathFs & { readFile(p: string): string };
export const nodeHoldFs: HoldFs = {
  realpath: realpathSync,
  lstat: lstatSync,
  readFile: (p) => readFileSync(p, "utf8"),
};
export interface HoldContext extends HoldNameContext {
  fs: HoldFs;
}
export type WriteTarget =
  | { kind: "hold"; reason: string }
  | { kind: "worktree-content"; worktreeRoot: string }
  | { kind: "ordinary" };
export interface ClassifyOptions {
  // Bash words name directories too (`git add .` in a worktree); Edit targets never are the root.
  worktreeRootIsContent?: boolean;
  // The project root (CLAUDE_PROJECT_DIR, where the session started). For a Bash word under it, the
  // dot rule counts only the segments below it, so a root that sits under a dot directory (the
  // chezmoi source under ~/.local) does not hold every word. Core-protected names still apply to
  // the whole path. A path that leaves the root through a symlink is judged whole.
  trustedBase?: string;
}

const WORKTREE_DIR = "/.git/worktree/";
// APFS compares names without case, so match case-insensitively. The index must come from the
// original string: lower-casing first changes the length of some characters (U+0130) and shifts it.
const WORKTREE_DIR_PATTERN = /\/\.git\/worktree\//i;

// A `..` after the first segment folds a name that may be a symlink (`link/../x` is not `x`).
export function hasInnerParentSegment(word: string): boolean {
  return word.split("/").some((seg, i) => i > 0 && seg === "..");
}

type Probe = "absent" | "file" | "other" | "error";
function probe(fs: HoldFs, p: string): Probe {
  try {
    return (fs.lstat(p) as { isFile(): boolean }).isFile() ? "file" : "other";
  } catch (error) {
    const code = errnoOf(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error";
  }
}

// The worktree root W when every K3 condition holds, else null (callers then hold).
function findVerifiedWorktree(path: string, fs: HoldFs): string | null {
  const at = WORKTREE_DIR_PATTERN.exec(path)?.index ?? -1;
  if (at < 0) return null;
  const base = path.slice(0, at + WORKTREE_DIR.length);
  const repoGit = path.slice(0, at + "/.git".length);
  const rest = path.slice(base.length).split("/");
  // Shallowest first; the first .git found decides.
  for (let i = 1; i <= rest.length; i++) {
    const w = join(base, ...rest.slice(0, i));
    const found = probe(fs, join(w, ".git"));
    if (found === "absent") continue;
    if (found !== "file") return null;
    try {
      const pointer = /^gitdir: (.+)\n?$/.exec(
        fs.readFile(join(w, ".git")),
      )?.[1];
      if (!pointer) return null;
      const target = fs.realpath(resolve(w, pointer));
      if (dirname(target) !== join(fs.realpath(repoGit), "worktrees"))
        return null;
      const back = fs.readFile(join(target, "gitdir")).trim();
      if (fs.realpath(back) !== fs.realpath(join(w, ".git"))) return null;
      return w;
    } catch {
      return null;
    }
  }
  return null;
}

export function classifyWriteTarget(
  absPath: string,
  ctx: HoldContext,
  opts: ClassifyOptions = {},
): WriteTarget {
  if (!isAbsolute(absPath))
    return { kind: "hold", reason: "relative path reached the classifier" };
  const physical = resolvePhysicalPath(absPath, ctx.fs);
  if (!physical.ok)
    return { kind: "hold", reason: `unresolved path (${physical.code})` };
  try {
    const w = findVerifiedWorktree(absPath, ctx.fs);
    if (w !== null) {
      const realW = ctx.fs.realpath(w);
      if (physical.path === realW && opts.worktreeRootIsContent)
        return { kind: "worktree-content", worktreeRoot: w };
      if (physical.path === realW || !isUnderRoot(physical.path, realW)) {
        return {
          kind: "hold",
          reason:
            findHoldSegment(physical.path, "outside", ctx) ??
            "path leaves the worktree",
        };
      }
      const reason =
        findHoldSegment(relative(w, absPath), "worktree", ctx) ??
        findHoldSegment(relative(realW, physical.path), "worktree", ctx);
      return reason
        ? { kind: "hold", reason }
        : { kind: "worktree-content", worktreeRoot: w };
    }
  } catch (error) {
    return {
      kind: "hold",
      reason: `worktree check failed (${errnoOf(error)})`,
    };
  }
  const base = trustedBaseFor(absPath, physical.path, ctx, opts.trustedBase);
  const reason = base
    ? // Core-protected names on the whole path (a two-segment name such as .config/git may
      // straddle the root); only the dot rule is limited to the part below the root.
      (findHoldSegment(absPath, "worktree", ctx) ??
      findHoldSegment(physical.path, "worktree", ctx) ??
      findHoldSegment(relative(base.lexical, absPath), "outside", ctx) ??
      findHoldSegment(relative(base.physical, physical.path), "outside", ctx) ??
      chezmoiGitSourceReason(absPath, ctx.chezmoiSource))
    : (findHoldSegment(absPath, "outside", ctx) ??
      findHoldSegment(physical.path, "outside", ctx));
  return reason ? { kind: "hold", reason } : { kind: "ordinary" };
}

// The base to judge below, only when the path stays under it both lexically and physically,
// and only when the base itself is not inside something core protects (a cwd of ~/.claude or
// of a .git directory must not make its contents look ordinary).
function trustedBaseFor(
  absPath: string,
  physicalPath: string,
  ctx: HoldContext,
  trustedBase: string | undefined,
): { lexical: string; physical: string } | null {
  if (!trustedBase || !isUnderRoot(absPath, trustedBase)) return null;
  try {
    const physicalBase = ctx.fs.realpath(trustedBase);
    if (
      untrustedBaseReason(trustedBase, ctx) ??
      untrustedBaseReason(physicalBase, ctx)
    )
      return null;
    return isUnderRoot(physicalPath, physicalBase)
      ? { lexical: trustedBase, physical: physicalBase }
      : null;
  } catch {
    return null;
  }
}

// Why a base cannot be trusted, or null. Shared by classifyWriteTarget and the whole-text mask
// in bash-write-hold.ts so both use one rule.
export function untrustedBaseReason(
  base: string,
  ctx: HoldContext,
): string | null {
  return (
    findHoldSegment(base, "worktree", ctx) ??
    chezmoiGitSourceReason(base, ctx.chezmoiSource)
  );
}
