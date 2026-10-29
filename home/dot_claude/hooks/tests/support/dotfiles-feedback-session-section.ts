// heavy テストが子プロセスとして起動する。runFeedbackSection を 1 回呼び、戻るまでの実時間と
// 段ごとの時間を JSON で 1 行出す。home の解決と repo-key の解決は本物を呼ぶが、spool の場所は
// 引数の一時ディレクトリに差し替える（実機の spool に触れない）。
// 使い方: bun dotfiles-feedback-session-section.ts <tmpHome> <cliPath> <cwd>
import { join } from "node:path";
import {
  createFeedbackSectionDeps,
  runFeedbackSection,
} from "../../implementations/session.ts";

const [tmpHome, cliPath, cwd] = process.argv.slice(2);
if (!tmpHome || !cliPath || !cwd)
  throw new Error("usage: <tmpHome> <cliPath> <cwd>");

const real = createFeedbackSectionDeps({ cwd, env: process.env });
const stages: Record<string, number> = {};
async function timed<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    stages[name] = performance.now() - start;
  }
}
// resolveHome / resolveRepoKey は同期なので、段の時間は呼び出しの前後で測る。
const syncTimed = <T>(name: string, run: () => T): T => {
  const start = performance.now();
  try {
    return run();
  } finally {
    stages[name] = performance.now() - start;
  }
};

const start = performance.now();
const result = await runFeedbackSection({
  ...real,
  cwd,
  cliPath,
  resolveRepoKey: (dir) => syncTimed("repoKey", () => real.resolveRepoKey(dir)),
  resolveHome: () =>
    syncTimed("home", () => {
      const resolved = real.resolveHome();
      return resolved.ok ? { ok: true, home: tmpHome } : resolved;
    }),
  spawnDetached: (argv) => timed("spawn", () => real.spawnDetached(argv)),
});
const ms = performance.now() - start;
process.stdout.write(
  `${JSON.stringify({ ms, stages, line: result.line, root: join(tmpHome, ".local/share/dotfiles-feedback") })}\n`,
);
