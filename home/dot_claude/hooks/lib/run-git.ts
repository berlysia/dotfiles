import { execFileSync } from "node:child_process";

export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; status: number | null };
export type RunGit = (args: readonly string[], cwd: string) => GitResult;

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER"] as const;

function gitEnv(isolateGlobalConfig: boolean): Record<string, string> {
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
    ...(isolateGlobalConfig ? { GIT_CONFIG_GLOBAL: "/dev/null" } : {}),
  };
}

// 他人の repo の .git/config を読むことがあるので、プログラムを起動しうる設定を無効にする。
// 上限を引数にしているのは、並列で負荷の高いテスト実行が本番の上限に縛られないようにするため
// isolateGlobalConfig は場面の注入の git 用: sandbox の中のエージェントが書ける global 設定
// （~/.gitconfig 等）を読ませない。store の commit は global 設定の author を使うので既定は false
export const createRunGit =
  (
    timeoutMs: number,
    options: { isolateGlobalConfig?: boolean } = {},
  ): RunGit =>
  (args, cwd) => {
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
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: gitEnv(options.isolateGlobalConfig === true),
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return { ok: true, stdout: out.toString("utf8").trimEnd() };
    } catch (error) {
      const status = (error as { status?: number | null }).status;
      return { ok: false, status: typeof status === "number" ? status : null };
    }
  };

export const runGit: RunGit = createRunGit(5_000);
