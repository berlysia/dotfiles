import { WORKER_MARK } from "./worker-guard.ts";

// worker と、worker が起動する Claude の環境変数の許可リスト（1 か所だけに置く）。
// CLAUDE_CODE_PLUGIN_DIRS や CLAUDECODE は列挙しないので写らない
export const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
] as const;

// markWorker: worker が起動する Claude 用は true（hook が何もしない印を付ける）、
// hook が起動する worker のプロセス用は false（worker 自身は worker のセッションではない）
export function buildWorkerEnv(
  parent: Readonly<Record<string, string | undefined>>,
  opts: { markWorker: boolean },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of WORKER_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  if (opts.markWorker) env[WORKER_MARK] = "1";
  return env;
}
