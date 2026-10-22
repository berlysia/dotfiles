import { isSafeSessionId } from "../../session-id.ts";
import type { RunGit } from "../core/git.ts";
import { feedbackHint } from "../core/render.ts";
import { injectScene } from "../core/scene-inject.ts";
import { cmdSituations, pathSituation } from "../core/scene.ts";
import { sceneStateDir } from "../core/scene-state.ts";
import { defaultStoreDir } from "../core/store.ts";
import type { Situation } from "../core/triggers.ts";
import { patchTargetPaths } from "./patch-paths.ts";

// Codex の PreToolUse（Bash・apply_patch）から、直前の場面の学びを文脈に足す。
// 入力の形の検査と situations の組み立てだけを持ち、選択・描画・記録は core の injectScene。
// 失敗の直後は扱わない: Codex の PostToolUse の tool_response は出力の文字列だけで終了コードが無く、
// 失敗を判定できない（実機で確認）

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_PATH_SITUATIONS = 16;
// Codex の入力に subagent の印が無いので、どの呼び出しも main として扱う
const AGENT = "main";

export type CodexSceneDeps = { home: string; runGit: RunGit; now: Date };

export type CodexSceneOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext: string;
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (obj: Record<string, unknown> | null, key: string) => {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
};

export function run(
  input: unknown,
  deps: CodexSceneDeps,
): CodexSceneOutput | null {
  try {
    const root = asRecord(input);
    if (str(root, "hook_event_name") !== "PreToolUse") return null;
    const tool = str(root, "tool_name");
    if (tool !== "Bash" && tool !== "apply_patch") return null;
    const command = str(asRecord(root?.tool_input ?? null), "command");
    const sessionId = str(root, "session_id");
    const cwd = str(root, "cwd");
    if (command === undefined || sessionId === undefined || cwd === undefined)
      return null;
    // session id はファイル名になる。長さはファイル名の上限より手前で弾く
    if (sessionId.length > MAX_SESSION_ID_LENGTH || !isSafeSessionId(sessionId))
      return null;

    let situations: (toplevel: string) => Situation[];
    if (tool === "Bash") {
      if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) return null;
      situations = () => cmdSituations(command);
    } else {
      // toplevel の外・自身と重複を先に落としてから 16 件にする。外のパスで枠を食わせない
      situations = (toplevel) => {
        const seen = new Set<string>();
        const result: Situation[] = [];
        for (const filePath of patchTargetPaths(command)) {
          const s = pathSituation({ cwd, toplevel, filePath });
          if (s === null || s.kind !== "path" || seen.has(s.relPath)) continue;
          seen.add(s.relPath);
          result.push(s);
          if (result.length >= MAX_PATH_SITUATIONS) break;
        }
        return result;
      };
    }

    const kind = tool === "Bash" ? "pre" : "path";
    const additionalContext = injectScene({
      stateDir: sceneStateDir(deps.home, "codex"),
      store: defaultStoreDir(deps.home),
      cwd,
      sessionId,
      agent: AGENT,
      reader: "codex",
      kind,
      situations,
      hint: feedbackHint(kind),
      runGit: deps.runGit,
      now: deps.now,
      // Codex の sandbox は cwd の下を書けるので、cwd が state・store と重なる注入はしない
      protectedPaths: [
        sceneStateDir(deps.home, "codex"),
        defaultStoreDir(deps.home),
      ],
    });
    if (additionalContext === null) return null;
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext },
    };
  } catch {
    return null;
  }
}
