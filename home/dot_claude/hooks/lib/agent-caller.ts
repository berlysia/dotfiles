// Claude Code の Bash は CLAUDECODE を、Codex は AI_AGENT（home/dot_codex/.config.toml の
// shell_environment_policy.set）と CODEX_SANDBOX* を、OpenCode は OPENCODE* を渡す。外すには
// `env -u` などをコマンドに書く必要があり、権限の照合に見える。
// detectAgent の優先順位は表の順。Claude Code の子にも AI_AGENT があるので、AI_AGENT は
// Claude Code の印が無いときだけ codex とみなす。
const AGENT_TABLE = [
  { pattern: "OPENCODE.*", agent: "opencode" },
  { pattern: "CODEX_SANDBOX.*", agent: "codex" },
  { pattern: "CLAUDECODE|CLAUDE_CODE_.*", agent: "claude" },
  { pattern: "AI_AGENT", agent: "codex" },
] as const;

export const AGENT_ENV = new RegExp(
  `^(${AGENT_TABLE.map((row) => row.pattern).join("|")})$`,
);

export function detectAgent(
  envNames: readonly string[],
): "claude" | "codex" | "opencode" | "human" {
  for (const row of AGENT_TABLE) {
    const pattern = new RegExp(`^(${row.pattern})$`);
    if (envNames.some((name) => pattern.test(name))) return row.agent;
  }
  return "human";
}

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
