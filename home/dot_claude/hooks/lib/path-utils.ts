/**
 * Path utilities for the hooks: resolving the home directory, and resolving
 * permission path patterns and tool-supplied target paths onto one absolute,
 * normalized form so they can be compared segment by segment.
 */

import { homedir } from "node:os";
import { join, posix } from "node:path";

/**
 * Home directory resolved at call time.
 *
 * Bun's os.homedir() keeps returning the HOME captured at process startup even
 * after process.env.HOME is reassigned (Node re-reads it), so tests that swap
 * HOME in beforeEach would not isolate code calling homedir() under `bun test`
 * and could touch the developer's real home. Reading process.env.HOME first
 * restores isolation; on POSIX it equals the startup value otherwise, so
 * production behavior is unchanged. Never cache the result at module load.
 */
export function getHomeDir(): string {
  return process.env.HOME || homedir();
}

/**
 * Expand tilde (~/) to absolute home directory path
 *
 * @param path - Path that may start with ~/
 * @returns Path with tilde expanded to home directory, or original path if no tilde
 *
 * @example
 * expandTilde("~/workspace/project") // → "/home/user/workspace/project"
 * expandTilde("/absolute/path")      // → "/absolute/path"
 * expandTilde("./relative/path")     // → "./relative/path"
 */
export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(getHomeDir(), path.slice(2));
  }
  return path;
}

/** Where relative patterns and relative targets anchor. Built once per hook run. */
export interface MatchContext {
  cwd: string;
  home: string;
}

/** grant: a match widens permission (allow list). restrict: a match narrows it (deny list). */
export type MatchKind = "grant" | "restrict";

/** A pattern resolved to a literal directory plus a glob relative to it. */
export interface ResolvedPattern {
  base: string;
  glob: string;
}

// A base and a target only line up when both went through the same
// normalization, so cwd and home are normalized here too: a deny anchored at
// "/repo/." would otherwise miss "/repo/.env".
function normalizeAbsolute(path: string): string {
  const stripped = posix.normalize(path).replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/** Absolute, posix-normalized form of a tool-supplied path. `..` is folded, never rejected. */
export function resolveTargetPath(raw: string, ctx: MatchContext): string {
  const home = normalizeAbsolute(ctx.home);
  const cwd = normalizeAbsolute(ctx.cwd);
  let path = raw;
  if (path === "~") path = home;
  else if (path.startsWith("~/")) path = `${home}/${path.slice(2)}`;
  else if (!path.startsWith("/")) path = `${cwd}/${path}`;
  return normalizeAbsolute(path);
}

/**
 * Resolve a permission path pattern (the text inside `Tool(...)`). `//x` and
 * `/x` are read from the filesystem root, `~/x` from home and everything else
 * from cwd; relative patterns follow the depth rules Claude Code documents for
 * them. A bare name matches at any depth; a
 * single directory (`src/**`) matches only `<cwd>/src` for grant and at any
 * depth under cwd for restrict. An empty array matches nothing.
 */
export function resolvePathPattern(
  body: string,
  ctx: MatchContext,
  kind: MatchKind,
): ResolvedPattern[] {
  // Claude Code gives `!` no meaning in allow rules; the deny carve-out is not implemented.
  if (body.startsWith("!")) return [];
  const home = normalizeAbsolute(ctx.home);
  const cwd = normalizeAbsolute(ctx.cwd);

  if (body === "") return [];
  if (body === "~")
    return kind === "restrict" ? [{ base: home, glob: "" }] : [];
  if (body.split("/").includes("..")) {
    // Claude Code: an allow rule with an unusable pattern approves nothing,
    // while a deny rule still guards that exact path. A glob cannot express
    // "..", so the folded path is guarded as a literal.
    if (kind === "grant") return [];
    const anchored = body.startsWith("/")
      ? body
      : body.startsWith("~/")
        ? `${home}/${body.slice(2)}`
        : `${cwd}/${body}`;
    return [{ base: normalizeAbsolute(anchored), glob: "" }];
  }

  const pattern = body.endsWith("/") ? `${body}**` : body;
  if (pattern.startsWith("/"))
    return [{ base: "/", glob: pattern.replace(/^\/+/, "") }];
  if (pattern.startsWith("~/")) return [{ base: home, glob: pattern.slice(2) }];
  if (pattern.startsWith("./")) return [{ base: cwd, glob: pattern.slice(2) }];

  const name = pattern.startsWith("**/") ? pattern.slice(3) : pattern;
  if (!name.includes("/")) {
    if (name === "**") return [{ base: cwd, glob: "**" }];
    const anyDepth = { base: cwd, glob: `**/${name}` };
    return kind === "grant"
      ? [anyDepth]
      : [anyDepth, { base: cwd, glob: `**/${name}/**` }];
  }
  const directory = pattern.endsWith("/**") ? pattern.slice(0, -3) : null;
  if (directory !== null && !directory.includes("/")) {
    return [{ base: cwd, glob: kind === "grant" ? pattern : `**/${pattern}` }];
  }
  return [{ base: cwd, glob: pattern }];
}
