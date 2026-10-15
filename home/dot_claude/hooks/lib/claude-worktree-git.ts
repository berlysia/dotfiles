import { spawnSync } from "node:child_process";

// git execution layer for lib/claude-worktree.ts.
// Hardening is copied from lib/agent-learnings/core/git.ts (env allow-list,
// fsmonitor / hooksPath / gpgsign off) on purpose instead of imported: that
// runner has a 5 s timeout and discards stderr, which does not fit writes.

export type GitKind = "read" | "branch" | "update-ref" | "add" | "remove";
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; status: number | null; stderr: string; timedOut: boolean };
export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; kind: GitKind; timeoutMs: number },
) => GitResult;
export type Deps = { runGit: GitRunner; now: () => number };

// Must stay below the hook timeout (240 s in .settings.hooks.json.tmpl).
export const DEADLINE_MS = 200_000;

const KIND_LIMIT_MS: Record<GitKind, number> = {
  read: 10_000,
  branch: 10_000,
  "update-ref": 10_000,
  add: 120_000,
  remove: 120_000,
};

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER"] as const;

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOW) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_* / GIT_SSH_COMMAND are not on the
  // allow-list, so they never reach git.
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// The repository's own .git/config may name programs git would start.
const HARDENING_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
] as const;

export const defaultRunGit: GitRunner = (args, { cwd, timeoutMs }) => {
  const result = spawnSync("git", [...HARDENING_ARGS, ...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      status: null,
      stderr: result.error.message,
      timedOut: code === "ETIMEDOUT",
    };
  }
  // A signal means git did not finish on its own, so the outcome is unknown.
  if (result.signal) {
    return {
      ok: false,
      status: null,
      stderr: `git terminated by ${result.signal}`,
      timedOut: true,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stderr: result.stderr,
      timedOut: false,
    };
  }
  // Strip exactly one trailing newline: -z output has none, and a path that
  // itself ends in a newline must keep it so callers can reject it.
  const stdout = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1)
    : result.stdout;
  return { ok: true, stdout };
};

export function defaultDeps(): Deps {
  return { runGit: defaultRunGit, now: Date.now };
}

// One call to create / remove / cleanup owns one deadline. Every git call goes
// through the function returned here, so the budget is shared.
export function createGit(
  deps: Deps,
  startedAt: number,
): (args: readonly string[], kind: GitKind, cwd: string) => GitResult {
  return (args, kind, cwd) => {
    const remaining = DEADLINE_MS - (deps.now() - startedAt);
    if (remaining <= 0) {
      return {
        ok: false,
        status: null,
        stderr: "deadline exceeded before running git",
        timedOut: true,
      };
    }
    return deps.runGit(args, {
      cwd,
      kind,
      timeoutMs: Math.min(KIND_LIMIT_MS[kind], remaining),
    });
  };
}

// C0 controls except "\n", plus DEL. C1 and U+2028/2029 are accepted (ADR).
// Apply at the boundary where text reaches stderr.
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}
