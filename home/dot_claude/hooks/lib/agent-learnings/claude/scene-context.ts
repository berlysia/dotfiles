import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isSafeSessionId } from "../../session-id.ts";
import type { RunGit } from "../core/git.ts";
import { COMMON_KEY } from "../core/learnings-file.ts";
import { feedbackHint, renderSituation } from "../core/render.ts";
import { resolveRepoKey } from "../core/repo-key.ts";
import {
  cmdSituations,
  collectCandidates,
  pathSituation,
} from "../core/scene.ts";
import {
  appendCache,
  appendInjected,
  hasControlChars,
  isValidAgentId,
  MAX_CACHE_LINES,
  readCache,
  readInjected,
  type SceneCacheEntry,
} from "../core/scene-state.ts";
import { selectInjectable, type InjectionKind } from "../core/select.ts";
import { defaultStoreDir, readLearnings } from "../core/store.ts";
import { recordClaudeInjections } from "./inject-log.ts";
import { isWorkerSession } from "./worker-guard.ts";

export const MAIN_AGENT = "main";

export const sceneStateDir = (home: string): string =>
  join(home, ".claude/state/agent-learnings");

// cwd → repoKey / toplevel はセッション内でキャッシュし、git は初回の 1 回だけ起動する。
// 起動する git は rev-parse と resolveRepoKey が使う読み取りのサブコマンドだけ
// （status や diff のような作業ツリーを触るものは使わない）。timeout・fsmonitor 無効・
// GIT_OPTIONAL_LOCKS・stdin を閉じる、は runGit（createRunGit(1000)）の側が持つ
function resolveRepo(
  cwd: string,
  runGit: RunGit,
): Omit<SceneCacheEntry, "cwd"> | null {
  const top = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok || !isAbsolute(top.stdout)) return null;
  const repoKey = resolveRepoKey(cwd, runGit);
  return repoKey === null ? null : { repoKey, toplevel: top.stdout };
}

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
    if (!isSafeSessionId(input.sessionId) || !isValidAgentId(agent))
      return null;
    if (!isAbsolute(input.cwd) || hasControlChars(input.cwd)) return null;
    const store = defaultStoreDir(input.home);
    if (!existsSync(join(store, ".git"))) return null;

    const stateDir = sceneStateDir(input.home);
    const cache = readCache(stateDir, input.sessionId);
    if (cache === null) return null;
    let repo: Omit<SceneCacheEntry, "cwd"> | null =
      cache.entries.find((e) => e.cwd === input.cwd) ?? null;
    if (repo === null) {
      if (cache.lineCount >= MAX_CACHE_LINES) return null;
      repo = resolveRepo(input.cwd, input.runGit);
      if (repo === null) return null;
      const entry = { cwd: input.cwd, ...repo };
      if (!appendCache(stateDir, input.sessionId, entry)) return null;
    }

    const situations =
      input.kind === "path"
        ? [
            pathSituation({
              cwd: input.cwd,
              toplevel: repo.toplevel,
              filePath: input.filePath,
            }),
          ].filter((s) => s !== null)
        : cmdSituations(input.command);
    if (situations.length === 0) return null;

    const repoFile = readLearnings(store, repo.repoKey);
    const commonFile = readLearnings(store, COMMON_KEY);
    const candidates = collectCandidates({
      repo: repoFile.ok ? repoFile.value : null,
      common: commonFile.ok ? commonFile.value : null,
      situations,
    });
    if (candidates.length === 0) return null;

    const injected = readInjected(stateDir, input.sessionId);
    if (injected === null) return null;
    const kind: InjectionKind = input.kind;
    const { selected, remainingBytes } = selectInjectable({
      candidates,
      injected,
      kind,
      agent,
    });
    const rendered = renderSituation(
      selected,
      kind,
      remainingBytes,
      feedbackHint(kind),
    );
    if (rendered.text === null) return null;

    // 文を返す前に記録する。書けなければ出さない（上限と重複抑止が外れるより、出さない方を選ぶ）
    for (const item of rendered.items) {
      if (
        !appendInjected(stateDir, input.sessionId, {
          agent,
          id: item.id,
          kind,
          bytes: item.bytes,
        })
      )
        return null;
    }
    // 記録は指標で安全の仕組みではない。書けなくても文は返す
    recordClaudeInjections(store, {
      at: input.now,
      repoKey: repo.repoKey,
      kind,
      items: rendered.items,
    });
    return rendered.text;
  } catch {
    return null;
  }
}
