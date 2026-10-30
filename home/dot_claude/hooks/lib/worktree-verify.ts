import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { errnoOf, isUnderRoot, type PathFs } from "./path-containment.ts";
import { isUnderManagedRoot, repoName } from "./worktree-locations.ts";

export type WorktreeVerifyFs = PathFs & { readFile(path: string): string };

export type WorktreePathCheck =
  | { candidate: false }
  | { candidate: true; root: string | null };

type CandidateRoot = { base: string; repoGit: string | null };
type Probe = "absent" | "file" | "other" | "error";

const LEGACY_WORKTREE_ROOT = "/.git/worktree/";
const LEGACY_WORKTREE_PATTERN = /\/\.git\/worktree\//i;

function probe(fs: WorktreeVerifyFs, path: string): Probe {
  try {
    return (fs.lstat(path) as { isFile(): boolean }).isFile()
      ? "file"
      : "other";
  } catch (error) {
    const code = errnoOf(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error";
  }
}

function candidateRoot(path: string, home: string): CandidateRoot | null {
  const legacyIndex = LEGACY_WORKTREE_PATTERN.exec(path)?.index ?? -1;
  if (legacyIndex >= 0) {
    return {
      base: path.slice(0, legacyIndex + LEGACY_WORKTREE_ROOT.length),
      repoGit: path.slice(0, legacyIndex + "/.git".length),
    };
  }

  const worktreesRoot = resolve(home, "worktrees");
  if (!isUnderRoot(path, worktreesRoot)) return null;
  const beneathWorktrees = relative(worktreesRoot, path);
  if (beneathWorktrees === "") return null;
  const [repo] = beneathWorktrees.split(sep);
  if (!repo || repo === "." || repo === "..") return null;
  return { base: join(worktreesRoot, repo), repoGit: null };
}

function isRegularFile(fs: WorktreeVerifyFs, path: string): boolean {
  try {
    return (fs.lstat(path) as { isFile(): boolean }).isFile();
  } catch {
    return false;
  }
}

function isDirectory(fs: WorktreeVerifyFs, path: string): boolean {
  try {
    return (fs.lstat(path) as { isDirectory(): boolean }).isDirectory();
  } catch {
    return false;
  }
}

function verifiedRoot(
  worktree: string,
  repoGitPath: string | null,
  home: string,
  fs: WorktreeVerifyFs,
): string | null {
  const gitFile = join(worktree, ".git");
  try {
    const match = /^gitdir: ([^\r\n]+)\n?$/.exec(fs.readFile(gitFile));
    const pointer = match?.[1];
    if (!pointer) return null;

    const adminDir = fs.realpath(resolve(worktree, pointer));
    const commonDir = dirname(dirname(adminDir));
    if (
      basename(commonDir) !== ".git" ||
      dirname(adminDir) !== join(commonDir, "worktrees") ||
      !isRegularFile(fs, join(commonDir, "HEAD")) ||
      !isDirectory(fs, join(commonDir, "objects"))
    ) {
      return null;
    }

    const reversePointer = /^([^\r\n]+)\n?$/.exec(
      fs.readFile(join(adminDir, "gitdir")),
    )?.[1];
    if (!reversePointer) return null;
    const reversePath = isAbsolute(reversePointer)
      ? reversePointer
      : resolve(adminDir, reversePointer);
    const physicalGitFile = fs.realpath(gitFile);
    if (fs.realpath(reversePath) !== physicalGitFile) return null;

    const physicalWorktree = fs.realpath(worktree);
    if (!isUnderManagedRoot(physicalWorktree, commonDir, home)) return null;
    if (repoGitPath !== null && fs.realpath(repoGitPath) !== commonDir) {
      return null;
    }
    // currentRoot also validates that the common dir has the supported shape.
    repoName(commonDir);
    return worktree;
  } catch {
    return null;
  }
}

/** Finds the shallowest worktree root for a path and validates its gitfile. */
export function inspectWorktreePath(
  absPath: string,
  home: string,
  fs: WorktreeVerifyFs,
): WorktreePathCheck {
  if (!isAbsolute(absPath) || absPath.includes("\0"))
    return { candidate: false };
  const path = resolve(absPath);
  const candidate = candidateRoot(path, home);
  if (!candidate) return { candidate: false };

  const rel = relative(candidate.base, path);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return { candidate: true, root: null };
  }
  const segments = rel.split(sep);
  for (let index = 1; index <= segments.length; index += 1) {
    const worktree = join(candidate.base, ...segments.slice(0, index));
    const found = probe(fs, join(worktree, ".git"));
    if (found === "absent") continue;
    if (found !== "file") return { candidate: true, root: null };
    return {
      candidate: true,
      root: verifiedRoot(worktree, candidate.repoGit, home, fs),
    };
  }
  return { candidate: true, root: null };
}
