// heavy テストが子プロセスとして起動する。本番の spool には触れず、引数の root を使う。
// 使い方: bun dotfiles-feedback-child.ts <root> <home> <command...>
// send が起動する flush も、この同じスクリプトを同じ root で起動し直す。
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliDeps, runCli } from "../../cli/dotfiles-feedback.ts";

const [root, home, ...argv] = process.argv.slice(2);
if (!root || !home) throw new Error("usage: <root> <home> <command...>");
const self = fileURLToPath(import.meta.url);

function relaunchFlush(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [self, root!, home!, "flush"], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      // テストが終わりにプロセスグループを止めるため、pid を残す。
      appendFileSync(join(dirname(root!), "spawned.pids"), `${child.pid}\n`);
      child.unref();
      resolve(true);
    });
  });
}

const deps = buildCliDeps(home, {
  root,
  cliPath: self,
  spawnDetached: relaunchFlush,
  spawnFlush: relaunchFlush,
});
process.exitCode = await runCli(argv, deps);
