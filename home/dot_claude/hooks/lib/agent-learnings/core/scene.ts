import { isAbsolute, relative, resolve } from "node:path";
import { leadingWords } from "../../command-words.ts";
import type { LearningsFile } from "./learnings-file.ts";
import type { Candidate } from "./select.ts";
import { matchTriggers, type Situation } from "./triggers.ts";

// 場面の組み立てと照合。I/O を持たず、Claude と Codex の入口、開始時の経路が同じ規則を使う。
// 入口はイベントを kind と生の入力に落とすところまでを持つ

export function cmdSituations(command: string): Situation[] {
  return leadingWords(command).map((words) => ({ kind: "cmd", words }));
}

// realpath は取らない（hook の中でファイルシステムを辿らない）ので、repo の中の
// symlink を辿った先は照合されない。toplevel の外・toplevel 自身は null
export function pathSituation(input: {
  cwd: string;
  toplevel: string;
  filePath: string;
}): Situation | null {
  const absolute = resolve(input.cwd, input.filePath);
  const rel = relative(resolve(input.toplevel), absolute);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    return null;
  return { kind: "path", relPath: rel };
}

export function collectCandidates(input: {
  repo: LearningsFile | null;
  common: LearningsFile | null;
  situations: readonly Situation[];
}): Candidate[] {
  const candidates: Candidate[] = [];
  for (const file of [input.repo, input.common]) {
    if (file === null) continue;
    for (const entry of file.entries) {
      for (const situation of input.situations) {
        const trigger = matchTriggers(entry, file.key, situation);
        if (trigger !== null) {
          candidates.push({ entry, fileKey: file.key, trigger });
          break;
        }
      }
    }
  }
  return candidates;
}
