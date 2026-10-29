// Claude Code の Bash は CLAUDECODE を、Codex は AI_AGENT（home/dot_codex/.config.toml の
// shell_environment_policy.set）と CODEX_SANDBOX* を渡す。外すには `env -u` などをコマンドに書く
// 必要があり、権限の照合に見える。
export const AGENT_ENV =
  /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_SANDBOX.*|AI_AGENT)$/;

export function hasAgentEnv(names: readonly string[]): boolean {
  return names.some((name) => AGENT_ENV.test(name));
}

// 人の操作かの判定はここ 1 か所。曖昧なときは人ではない扱いにする。人だけの操作
// （--common、promote、rekey、init）は拒否し、tag では確認を省く（省いても付けられる
// 範囲は人と同じなので、曖昧さが広げるものは無い）。環境からの推定で、証明ではない
export function isHumanCaller(caller: {
  isTty: boolean;
  agentEnv: boolean;
}): boolean {
  return caller.isTty && !caller.agentEnv;
}
