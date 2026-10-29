import { execFile } from "node:child_process";

/**
 * The only place the sessions code starts git. It runs git in directories that
 * other sessions chose, so everything that could make git run a program or read
 * a hostile config is closed here.
 *
 * Differences from run-git.ts (which is synchronous, drops stderr, and is also
 * used for store commits that need the global config's author):
 * - LANG and LC_ALL are not passed on; LC_ALL=C is set so the stderr text that
 *   decides "not a git repository" is stable.
 * - GIT_CONFIG_GLOBAL=/dev/null is always set.
 * - stderr is returned.
 * Whether to merge the two allowlists is left for when there are three callers.
 */

const ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "USER"] as const;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_BUFFER = 65536;

export type GitEnvSource = Readonly<Record<string, string | undefined>>;

export function gitEnv(
  source: GitEnvSource = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOW) {
    const value = source[name];
    if (value === undefined) continue;
    env[name] = name === "PATH" ? absolutePathEntries(value) : value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

// A relative or empty PATH entry resolves against the cwd, where a fake `git` can sit.
function absolutePathEntries(value: string): string {
  return value
    .split(":")
    .filter((entry) => entry.startsWith("/"))
    .join(":");
}

// safe.bareRepository=explicit: with the global config ignored, this would fall
// back to "all", which lets a bare repo planted under the cwd supply any config key.
export function gitSafetyArgs(): string[] {
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "safe.bareRepository=explicit",
  ];
}

export type ExecGitResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
};

type ExecFileError = {
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
};
export type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: {
    env: Record<string, string>;
    timeout: number;
    killSignal: NodeJS.Signals;
    maxBuffer: number;
    signal?: AbortSignal;
  },
  callback: (
    error: ExecFileError | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

export type ExecGitOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  execFileImpl?: ExecFileImpl;
};

const failed = (): ExecGitResult => ({
  code: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  overflow: false,
});

export function execGit(
  args: readonly string[],
  cwd: string,
  opts: ExecGitOptions = {},
): Promise<ExecGitResult> {
  if (cwd.includes("\0")) return Promise.resolve(failed());
  const run = opts.execFileImpl ?? (execFile as unknown as ExecFileImpl);
  return new Promise((resolve) => {
    try {
      run(
        "git",
        [...gitSafetyArgs(), "-C", cwd, ...args],
        {
          env: gitEnv(),
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (error, stdout, stderr) => {
          const out = typeof stdout === "string" ? stdout : "";
          const err = typeof stderr === "string" ? stderr : "";
          if (!error) {
            resolve({
              code: 0,
              stdout: out,
              stderr: err,
              timedOut: false,
              overflow: false,
            });
            return;
          }
          resolve({
            code: typeof error.code === "number" ? error.code : null,
            stdout: out,
            stderr: err,
            timedOut:
              error.killed === true &&
              error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            overflow: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          });
        },
      );
    } catch {
      resolve(failed());
    }
  });
}
