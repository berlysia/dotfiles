import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export function repoName(commonDir: string): string {
  if (basename(commonDir) !== ".git") {
    throw new Error("unsupported common dir");
  }
  const name = basename(dirname(commonDir));
  if (name === "" || name === "." || name === "..") {
    throw new Error("unsupported common dir");
  }
  return name;
}

export function currentRoot(commonDir: string, home: string): string {
  return `${join(home, "worktrees", repoName(commonDir))}${sep}`;
}

export function legacyRoot(commonDir: string): string {
  return `${join(commonDir, "worktree")}${sep}`;
}

export function isUnderManagedRoot(
  path: string,
  commonDir: string,
  home: string,
): boolean {
  const candidate = resolve(path);
  const roots = [currentRoot(commonDir, home), legacyRoot(commonDir)];
  for (const root of roots) {
    const child = relative(resolve(root), candidate);
    if (child === "" || child === ".." || child.startsWith(`..${sep}`)) {
      continue;
    }
    if (isAbsolute(child)) continue;
    const first = child.split(sep, 1)[0];
    if (
      first !== undefined &&
      first !== "" &&
      first !== ".common-dir" &&
      !first.startsWith(".common-dir.tmp.")
    ) {
      return true;
    }
  }
  return false;
}
