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
