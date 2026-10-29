import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isSafeSessionId } from "../../session-id.ts";
import type { RunGit } from "../../run-git.ts";
import { COMMON_KEY } from "./learnings-file.ts";
import { recordInjections } from "./metrics-log.ts";
import { renderSituation } from "./render.ts";
import { resolveRepoKey } from "../../repo-key.ts";
import { collectCandidates } from "./scene.ts";
import {
  appendCache,
  appendInjected,
  hasControlChars,
  isValidAgentId,
  MAX_CACHE_LINES,
  readCache,
  readInjected,
  type SceneCacheEntry,
  type SceneReader,
} from "./scene-state.ts";
import { selectInjectable, type InjectionKind } from "./select.ts";
import { readLearnings } from "./store.ts";
import type { Situation } from "./triggers.ts";

// 場面の注入の組み立て（Claude と Codex の入口が共有する）。入口ごとに違うのは
// 入力の形・state の置き場・situations の作り方だけで、ここは選んで描いて記録するところまで持つ

export type InjectSceneInput = {
  stateDir: string;
  store: string;
  cwd: string;
  sessionId: string;
  agent: string;
  reader: SceneReader;
  kind: InjectionKind;
  // cwd の toplevel から場面を作る。空配列は「何も出さない」
  situations: (toplevel: string) => Situation[];
  hint: string | null;
  runGit: RunGit;
  now: Date;
  // cwd がこれらと重なるとき（同じ・上・下）は注入しない。空なら検査しない
  protectedPaths: readonly string[];
};

// cwd → repoKey / toplevel はセッション内でキャッシュし、git は初回の 1 回だけ起動する。
// 起動する git は rev-parse と resolveRepoKey が使う読み取りのサブコマンドだけ
// （status や diff のような作業ツリーを触るものは使わない）。timeout・fsmonitor 無効・
// GIT_OPTIONAL_LOCKS・stdin を閉じる、は runGit（createRunGit）の側が持つ
function resolveRepo(
  cwd: string,
  runGit: RunGit,
): Omit<SceneCacheEntry, "cwd"> | null {
  const top = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok || !isAbsolute(top.stdout)) return null;
  const repoKey = resolveRepoKey(cwd, runGit);
  return repoKey === null ? null : { repoKey, toplevel: top.stdout };
}

// まだ無いパスは、最も近い既存の親を realpath し、無い区間をその後ろにつなぐ。
// 親そのもので比べると、`~/.codex/other` のような無関係の cwd まで弾いてしまう
function realpathAllowMissing(path: string): string {
  const missing: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync(at), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(at);
      if (parent === at) throw error;
      missing.push(basename(at));
      at = parent;
    }
  }
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
  );
};

// 解決に失敗したら true（= 注入しない）
function overlapsProtected(cwd: string, protectedPaths: readonly string[]) {
  try {
    const real = realpathSync(cwd);
    return protectedPaths.some((path) => {
      const protectedReal = realpathAllowMissing(path);
      return isInside(real, protectedReal) || isInside(protectedReal, real);
    });
  } catch {
    return true;
  }
}

// 描いた文を返す。null は「何も出さない」で、state・store・git のどれが失敗してもここへ畳む
// （hook は何も止めない）
export function injectScene(input: InjectSceneInput): string | null {
  try {
    if (!isSafeSessionId(input.sessionId) || !isValidAgentId(input.agent))
      return null;
    if (!isAbsolute(input.cwd) || hasControlChars(input.cwd)) return null;
    if (
      input.protectedPaths.length > 0 &&
      overlapsProtected(input.cwd, input.protectedPaths)
    )
      return null;
    if (!existsSync(join(input.store, ".git"))) return null;

    const { stateDir, store, sessionId, agent, kind } = input;
    const cache = readCache(stateDir, sessionId);
    if (cache === null) return null;
    let repo: Omit<SceneCacheEntry, "cwd"> | null =
      cache.entries.find((e) => e.cwd === input.cwd) ?? null;
    if (repo === null) {
      if (cache.lineCount >= MAX_CACHE_LINES) return null;
      repo = resolveRepo(input.cwd, input.runGit);
      if (repo === null) return null;
      const entry = { cwd: input.cwd, ...repo };
      if (!appendCache(stateDir, sessionId, entry)) return null;
    }

    const situations = input.situations(repo.toplevel);
    if (situations.length === 0) return null;

    const repoFile = readLearnings(store, repo.repoKey);
    const commonFile = readLearnings(store, COMMON_KEY);
    const candidates = collectCandidates({
      repo: repoFile.ok ? repoFile.value : null,
      common: commonFile.ok ? commonFile.value : null,
      situations,
    });
    if (candidates.length === 0) return null;

    const injected = readInjected(stateDir, sessionId);
    if (injected === null) return null;
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
      input.hint,
    );
    if (rendered.text === null) return null;

    // 文を返す前に記録する。書けなければ出さない（上限と重複抑止が外れるより、出さない方を選ぶ）
    for (const item of rendered.items) {
      if (
        !appendInjected(stateDir, sessionId, {
          agent,
          id: item.id,
          kind,
          bytes: item.bytes,
        })
      )
        return null;
    }
    // 記録は指標で安全の仕組みではない。書けなくても文は返す
    recordInjections(store, {
      at: input.now,
      repoKey: repo.repoKey,
      kind,
      items: rendered.items,
      reader: input.reader,
    });
    return rendered.text;
  } catch {
    return null;
  }
}
