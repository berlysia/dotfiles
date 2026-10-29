import { feedbackHint } from "../core/render.ts";
import type { RunGit } from "../../run-git.ts";
import { injectScene } from "../core/scene-inject.ts";
import { cmdSituations, pathSituation } from "../core/scene.ts";
import { sceneStateDir } from "../core/scene-state.ts";
import { defaultStoreDir } from "../core/store.ts";
import { isWorkerSession } from "./worker-guard.ts";

export const MAIN_AGENT = "main";

export type SceneEvent =
  | { kind: "pre" | "fail"; command: string }
  | { kind: "path"; filePath: string };

// 直前・失敗の直後に Claude の文脈へ足す文。null は「何も出さない」で、
// state・store・git のどれが失敗してもここへ畳む（hook は何も止めない）
export function buildSceneContext(
  input: SceneEvent & {
    home: string;
    cwd: string;
    sessionId: string;
    agentId?: string;
    runGit: RunGit;
    now: Date;
    env?: Readonly<Record<string, string | undefined>>; // 既定は process.env
  },
): string | null {
  try {
    if (isWorkerSession(input.env ?? process.env)) return null;
    const agent = input.agentId ?? MAIN_AGENT;
    return injectScene({
      stateDir: sceneStateDir(input.home, "claude"),
      store: defaultStoreDir(input.home),
      cwd: input.cwd,
      sessionId: input.sessionId,
      agent,
      reader: "claude",
      kind: input.kind,
      situations: (toplevel) =>
        input.kind === "path"
          ? [
              pathSituation({
                cwd: input.cwd,
                toplevel,
                filePath: input.filePath,
              }),
            ].filter((s) => s !== null)
          : cmdSituations(input.command),
      hint: feedbackHint(input.kind),
      runGit: input.runGit,
      now: input.now,
      // Claude の state と store は Claude の sandbox の外にあるので、cwd との重なりは検査しない
      protectedPaths: [],
    });
  } catch {
    return null;
  }
}
