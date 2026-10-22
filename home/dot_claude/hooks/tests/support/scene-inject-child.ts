import { createRunGit } from "../../lib/agent-learnings/core/git.ts";
import { injectScene } from "../../lib/agent-learnings/core/scene-inject.ts";
import { cmdSituations } from "../../lib/agent-learnings/core/scene.ts";
import { defaultStoreDir } from "../../lib/agent-learnings/core/store.ts";
import { sceneStateDir } from "../../lib/agent-learnings/core/scene-state.ts";

// heavy テストの子プロセス。HOME は親が子の env にだけ渡す（createRunGit は process.env.HOME を引き継ぐ）。
//   git <isolate> <cwd> <json args>   → runGit の結果を JSON で出す
//   inject <home> <cwd> <command>     → Codex の reader で injectScene を呼び、結果を JSON で出す
const [mode, ...rest] = process.argv.slice(2);
if (mode === "git") {
  const [isolate, cwd, args] = rest as [string, string, string];
  const runGit = createRunGit(60_000, {
    isolateGlobalConfig: isolate === "true",
  });
  process.stdout.write(
    `${JSON.stringify(runGit(JSON.parse(args) as string[], cwd))}\n`,
  );
} else if (mode === "inject") {
  const [home, cwd, command] = rest as [string, string, string];
  const text = injectScene({
    stateDir: sceneStateDir(home, "codex"),
    store: defaultStoreDir(home),
    cwd,
    sessionId: "sess1",
    agent: "main",
    reader: "codex",
    kind: "pre",
    situations: () => cmdSituations(command),
    hint: null,
    runGit: createRunGit(60_000, { isolateGlobalConfig: true }),
    now: new Date(),
    protectedPaths: [],
  });
  process.stdout.write(`${JSON.stringify({ text })}\n`);
}
