import { execFileSync } from "node:child_process";

export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; status: number | null };
export type RunGit = (args: readonly string[], cwd: string) => GitResult;

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER"] as const;

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOW) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_CONFIG_* は許可リストに無いので渡らない
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// 他人の repo の .git/config を読むことがあるので、プログラムを起動しうる設定を無効にする。
export const runGit: RunGit = (args, cwd) => {
  try {
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      {
        cwd,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: gitEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return { ok: true, stdout: out.toString("utf8").trimEnd() };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return { ok: false, status: typeof status === "number" ? status : null };
  }
};
