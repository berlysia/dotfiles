import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { RunGit } from "./run-git.ts";

// 各 segment は英数字で始まる（"." や ".." や "-x" を通さない）
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._~-]*)+$/;
const KEY_MAX = 200;

export function isValidRepoKey(key: string): boolean {
  return key.length <= KEY_MAX && KEY_PATTERN.test(key);
}

const sha8 = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 8);

// scheme / user@ / port / 末尾の / と .git を除き、scp 形式 host:path を host/path にし、小文字化
export function normalizeOriginUrl(url: string): string | null {
  let s = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
  if (!/^[a-z]+:\/\//i.test(s) && scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z]+:\/\//i, "").replace(/^[^@/]*@/, "");
    s = s.replace(/^([^/:]+):\d*(?=\/)/, "$1");
  }
  s = s
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return isValidRepoKey(s) ? s : null;
}

export function localRepoKey(commonDirRealpath: string): string {
  const raw = basename(dirname(commonDirRealpath))
    .normalize("NFKC")
    .toLowerCase();
  const name =
    raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "") ||
    "repo";
  return `local/${name}-${sha8(commonDirRealpath)}`;
}

export function keyToFileName(key: string): string {
  const slug = key
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 80)
    .replace(/\.+$/, "");
  return `${slug}.${sha8(key)}.md`;
}

export function resolveRepoKey(cwd: string, runGit: RunGit): string | null {
  const common = runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  if (!common.ok || common.stdout === "") return null;
  const origin = runGit(["config", "--get", "remote.origin.url"], cwd);
  const fromOrigin = origin.ok ? normalizeOriginUrl(origin.stdout) : null;
  if (fromOrigin) return fromOrigin;
  let commonReal: string;
  try {
    commonReal = realpathSync(common.stdout);
  } catch {
    return null;
  }
  const local = localRepoKey(commonReal);
  return isValidRepoKey(local) ? local : null;
}
