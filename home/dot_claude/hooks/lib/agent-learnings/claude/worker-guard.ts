// worker が起動した Claude のセッションかどうか。SessionStart / SessionEnd の hook が
// 再帰（worker のセッションの終了が新しいジョブを作る）を断つために見る。厳密に "1" のときだけ
export const WORKER_MARK = "AGENT_LEARNINGS_WORKER";

export function isWorkerSession(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[WORKER_MARK] === "1";
}
