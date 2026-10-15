import {
  normalizeHeading,
  preprocessText,
  validateBody,
  validateTitle,
} from "./entry-text.ts";
import type { LearningEntry, LearningsFile } from "./learnings-file.ts";
import { matchesNoPromote, type NoPromoteResult } from "./no-promote.ts";
import { evictEntries, MAX_ENTRIES } from "./ops.ts";

// 公開する形式（spec の契約）。`id` を省くと「このセッションで初めて得た学び」で、
// 現在の repo のファイルには何も書かずに common へ入れる
export type PromoteOp = {
  op: "promote";
  id?: string;
  matchId: string;
  title: string;
  body: string;
  evidence: string;
};

export type PromoteFailure = {
  ok: false;
  // read-only は common が書けない場合。呼び出し側は「学びファイルが読めない」として扱う
  kind: "rejected" | "read-only";
  reason: string;
};

// 1 回の応答で受け付ける昇格の数（調整用の定数。common は全 repo の文脈に入るため抑える）
export const MAX_PROMOTES_PER_RESPONSE = 3;
// 候補として LLM に見せる項目数と、本文の先頭の字数（spec K4。調整用の定数）
export const MAX_CANDIDATES = 200;
export const CANDIDATE_BODY_CHARS = 120;
// 昇格後の本文と元の項目の bigram の Jaccard 係数の下限（spec K4 の 0.2。調整用の定数）。
// 浮動小数の誤差で境界がぶれないよう、百分率の整数で持つ
export const MIN_OVERLAP_PERCENT = 20;

const EVIDENCE_MAX = 200;
const ID_PATTERN = /^L-[0-9a-f]{12}$/;

// --- repo 名の検査 -------------------------------------------------------

// 各キーの `/` 区切りの 2 番目以降の部分のうち 3 字以上のもの（spec K4）と、その部分を
// `-` `.` `_` で分けた語のうち 4 字以上のもの。語の検査は `kanbun-annotation` のうち
// `kanbun` だけが本文に出る場合を捕まえる。LLM が名前を言い換えれば抜けられる
export function repoNameTerms(keys: Iterable<string>): string[] {
  const terms = new Set<string>();
  for (const key of keys) {
    for (const part of key.split("/").slice(1)) {
      const normalized = part.normalize("NFKC").toLowerCase();
      if (normalized.length >= 3) terms.add(normalized);
      for (const word of normalized.split(/[-._]+/))
        if (word.length >= 4) terms.add(word);
    }
  }
  return [...terms];
}

export function findRepoNames(keys: Iterable<string>, text: string): string[] {
  const haystack = text.normalize("NFKC").toLowerCase();
  return repoNameTerms(keys).filter((term) => haystack.includes(term));
}

// --- 内容の重なり --------------------------------------------------------

function bigramsOf(texts: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    const chars = Array.from(
      text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
    );
    for (let i = 0; i + 1 < chars.length; i += 1)
      set.add(`${chars[i]}${chars[i + 1]}`);
  }
  return set;
}

// 係数 >= 0.2 を整数で比べる
function overlapsEnough(
  promoted: readonly string[],
  sources: readonly string[],
): boolean {
  const p = bigramsOf(promoted);
  const q = bigramsOf(sources);
  if (p.size === 0 || q.size === 0) return false;
  let intersection = 0;
  for (const gram of p) if (q.has(gram)) intersection += 1;
  const union = p.size + q.size - intersection;
  return intersection * 100 >= union * MIN_OVERLAP_PERCENT;
}

// --- 候補の組み立て ------------------------------------------------------

export type Candidates = {
  ids: Set<string>;
  // 1 行 1 項目 `<id>: <見出し> — <本文の先頭 120 字>`。repo-key は書かない
  text: string;
};

export function buildCandidates(input: {
  repoKey: string;
  others: ReadonlyMap<string, LearningsFile>;
  noPromote: NoPromoteResult;
}): Candidates {
  const empty: Candidates = { ids: new Set(), text: "" };
  if (!input.noPromote.ok) return empty;
  const patterns = input.noPromote.patterns;
  if (matchesNoPromote(patterns, input.repoKey)) return empty;
  const entries: LearningEntry[] = [];
  for (const file of input.others.values()) {
    if (file.readOnly || file.key === input.repoKey) continue;
    if (matchesNoPromote(patterns, file.key)) continue;
    entries.push(...file.entries);
  }
  // sort は安定。updated が同じなら読んだ順のまま
  const chosen = entries
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, MAX_CANDIDATES);
  return {
    ids: new Set(chosen.map((e) => e.id)),
    text: chosen
      .map(
        (e) =>
          `${e.id}: ${e.title} — ${Array.from(e.body).slice(0, CANDIDATE_BODY_CHARS).join("")}`,
      )
      .join("\n"),
  };
}

// --- common への追加・統合 ----------------------------------------------

const union = (...lists: Array<readonly string[]>): string[] => [
  ...new Set(lists.flat()),
];

type CommonWrite = { id: string; merged: boolean };

// 見出しが正規化して同じ項目があれば統合し、無ければ新しい項目を足す
function writeToCommon(
  common: LearningsFile,
  entry: Omit<LearningEntry, "id">,
  today: string,
  newId: () => string,
): CommonWrite {
  const heading = normalizeHeading(entry.title);
  const existing = common.entries.find(
    (e) => normalizeHeading(e.title) === heading,
  );
  if (existing) {
    existing.seen += entry.seen;
    existing.repos = union(existing.repos, entry.repos);
    existing.updated = today;
    return { id: existing.id, merged: true };
  }
  const taken = new Set(common.entries.map((e) => e.id));
  let id = newId();
  while (taken.has(id)) id = newId();
  common.entries.push({ ...entry, id, updated: today });
  return { id, merged: false };
}

function evictFromCommon(
  common: LearningsFile,
  protectedIds: ReadonlySet<string>,
): string[] {
  const evicted = evictEntries(common.entries, protectedIds, MAX_ENTRIES);
  common.entries = evicted.entries;
  return evicted.evictedIds;
}

// --- worker の昇格 -------------------------------------------------------

export type PromoteInput = {
  repoKey: string;
  today: string;
  // worker では applyOps を適用した後のメモリ上のファイル
  repoFile: LearningsFile;
  others: ReadonlyMap<string, LearningsFile>;
  common: LearningsFile;
  noPromote: NoPromoteResult;
  ops: readonly PromoteOp[];
  newId: () => string;
  extraRedact: readonly RegExp[];
  // lock の外で LLM に見せた後に消えた項目なら、拒否せず捨ててよい id
  droppableIds: ReadonlySet<string>;
  // LLM に見せた候補の id
  shownCandidateIds: ReadonlySet<string>;
};
export type PromoteResult =
  | {
      ok: true;
      value: {
        repoFile: LearningsFile;
        changedOthers: Map<string, LearningsFile>;
        common: LearningsFile;
        commitLines: string[];
        appliedCount: number;
        droppedCount: number;
      };
    }
  | PromoteFailure;

const rejected = (reason: string): PromoteFailure => ({
  ok: false,
  kind: "rejected",
  reason,
});

type Resolved = {
  op: PromoteOp;
  title: string;
  body: string;
  evidence: string;
  match: { entry: LearningEntry; file: LearningsFile };
  own: LearningEntry | null;
};

// 全部か無しか。どれか 1 つでも外れたら何も適用しない。ファイルは読み書きしない
export function applyPromotes(input: PromoteInput): PromoteResult {
  const unchanged: PromoteResult = {
    ok: true,
    value: {
      repoFile: input.repoFile,
      changedOthers: new Map(),
      common: input.common,
      commitLines: [],
      appliedCount: 0,
      droppedCount: 0,
    },
  };
  if (input.ops.length === 0) return unchanged;

  if (!input.noPromote.ok) return rejected(input.noPromote.reason);
  const patterns = input.noPromote.patterns;
  if (matchesNoPromote(patterns, input.repoKey))
    return rejected("current repo matches no-promote");
  if (input.common.readOnly || input.repoFile.readOnly)
    return { ok: false, kind: "read-only", reason: "read-only file" };

  // matchId と id は同じ名前空間
  const seenIds = new Set<string>();
  for (const op of input.ops) {
    for (const id of op.id === undefined ? [op.matchId] : [op.matchId, op.id]) {
      if (!ID_PATTERN.test(id)) return rejected("invalid id");
      if (seenIds.has(id)) return rejected("duplicate id across promotes");
      seenIds.add(id);
    }
  }

  const resolved: Resolved[] = [];
  let droppedCount = 0;
  for (const op of input.ops) {
    const title = preprocessText(op.title, input.extraRedact);
    const body = preprocessText(op.body, input.extraRedact);
    const evidence = preprocessText(op.evidence, input.extraRedact);
    const titleCheck = validateTitle(title, { allowUrl: false });
    if (!titleCheck.ok) return rejected(`title: ${titleCheck.reason}`);
    const bodyCheck = validateBody(body, { allowUrl: false });
    if (!bodyCheck.ok) return rejected(`body: ${bodyCheck.reason}`);
    if (evidence.length < 1 || evidence.length > EVIDENCE_MAX)
      return rejected("evidence length");

    if (!input.shownCandidateIds.has(op.matchId))
      return rejected(`matchId ${op.matchId} was not a shown candidate`);
    if (input.repoFile.entries.some((e) => e.id === op.matchId))
      return rejected("matchId is an entry of the current repo");
    let match: Resolved["match"] | null = null;
    for (const file of input.others.values()) {
      if (file.key === input.repoKey) continue;
      const entry = file.entries.find((e) => e.id === op.matchId);
      if (entry) {
        match = { entry, file };
        break;
      }
    }
    let own: LearningEntry | null = null;
    if (op.id !== undefined) {
      own = input.repoFile.entries.find((e) => e.id === op.id) ?? null;
      if (own === null && !input.droppableIds.has(op.id))
        return rejected(`unknown id ${op.id}`);
    }
    if (match === null && !input.droppableIds.has(op.matchId))
      return rejected(`unknown matchId ${op.matchId}`);
    // lock の外で見せた後に消えた項目: その昇格全体を捨てる
    if (match === null || (op.id !== undefined && own === null)) {
      droppedCount += 1;
      continue;
    }
    if (matchesNoPromote(patterns, match.file.key))
      return rejected("matchId repo matches no-promote");
    if (match.file.readOnly) return rejected("matchId file is read-only");

    const keys = union(
      match.entry.repos,
      [match.file.key, input.repoKey],
      own?.repos ?? [],
    );
    const leaked = findRepoNames(keys, `${title}\n${body}`);
    if (leaked.length > 0)
      return rejected(`repo name in the promoted text: ${leaked.join(", ")}`);
    const sources = [match.entry, ...(own ? [own] : [])].flatMap((e) => [
      e.title,
      e.body,
    ]);
    if (!overlapsEnough([title, body], sources))
      return rejected("content overlap below the threshold");
    resolved.push({ op, title, body, evidence, match, own });
  }

  const repoFile = structuredClone(input.repoFile);
  const common = structuredClone(input.common);
  const changedOthers = new Map<string, LearningsFile>();
  const editable = (file: LearningsFile): LearningsFile => {
    let copy = changedOthers.get(file.key);
    if (!copy) {
      copy = structuredClone(file);
      changedOthers.set(file.key, copy);
    }
    return copy;
  };
  const commitLines: string[] = [];
  const protectedIds = new Set<string>();

  for (const r of resolved) {
    const { match, own, op } = r;
    const write = writeToCommon(
      common,
      {
        title: r.title,
        body: r.body,
        seen: match.entry.seen + (own ? own.seen : 1),
        repos: union(
          match.entry.repos,
          [match.file.key, input.repoKey],
          own?.repos ?? [],
        ),
        updated: input.today,
        extra: [],
      },
      input.today,
      input.newId,
    );
    protectedIds.add(write.id);
    const source = `${op.matchId} (${match.file.key})${
      own ? `, ${own.id} (${input.repoKey})` : ""
    }`;
    commitLines.push(
      `promote ${write.merged ? "merge " : ""}${write.id} <- ${source}: ${r.evidence}`,
    );
    const matchFile = editable(match.file);
    matchFile.entries = matchFile.entries.filter((e) => e.id !== op.matchId);
    if (own) repoFile.entries = repoFile.entries.filter((e) => e.id !== own.id);
  }

  const evictedIds = evictFromCommon(common, protectedIds);
  if (evictedIds.length > 0)
    commitLines.push(`evicted ${evictedIds.join(",")}`);

  return {
    ok: true,
    value: {
      repoFile,
      changedOthers,
      common,
      commitLines,
      appliedCount: resolved.length,
      droppedCount,
    },
  };
}

// --- 手動の昇格 ----------------------------------------------------------

export type ManualPromoteInput = {
  repoKey: string;
  today: string;
  repoFile: LearningsFile;
  common: LearningsFile;
  noPromote: NoPromoteResult;
  id: string;
  newId: () => string;
};
export type ManualPromoteResult =
  | {
      ok: true;
      value: {
        repoFile: LearningsFile;
        common: LearningsFile;
        commonId: string;
        commitLines: string[];
        // repo 名の部分が本文に含まれている。拒否はしない（人の判断）
        warnings: string[];
      };
    }
  | PromoteFailure;

// 2 repo 条件・repo 名・内容の重なりは検査しない（人の判断）。no-promote と見出し・本文の検査はかける
export function promoteManually(
  input: ManualPromoteInput,
): ManualPromoteResult {
  if (!input.noPromote.ok) return rejected(input.noPromote.reason);
  if (matchesNoPromote(input.noPromote.patterns, input.repoKey))
    return rejected("current repo matches no-promote");
  if (input.common.readOnly || input.repoFile.readOnly)
    return { ok: false, kind: "read-only", reason: "read-only file" };
  const source = input.repoFile.entries.find((e) => e.id === input.id);
  if (!source)
    return rejected(`${input.id} is not an entry of the current repo`);
  // 人が端末で確認して移すので、`add --common` と同じく URL を許す。ほかの検査は worker と同じ
  const titleCheck = validateTitle(source.title, { allowUrl: true });
  if (!titleCheck.ok) return rejected(`title: ${titleCheck.reason}`);
  const bodyCheck = validateBody(source.body, { allowUrl: true });
  if (!bodyCheck.ok) return rejected(`body: ${bodyCheck.reason}`);

  const repoFile = structuredClone(input.repoFile);
  const common = structuredClone(input.common);
  const write = writeToCommon(
    common,
    {
      title: source.title,
      body: source.body,
      seen: source.seen,
      repos: [...source.repos],
      updated: input.today,
      extra: source.extra.map(([k, v]): [string, string] => [k, v]),
    },
    input.today,
    input.newId,
  );
  repoFile.entries = repoFile.entries.filter((e) => e.id !== input.id);
  const commitLines = [
    `promote ${write.merged ? "merge " : ""}${write.id} <- ${input.id} (${input.repoKey})`,
  ];
  const evictedIds = evictFromCommon(common, new Set([write.id]));
  if (evictedIds.length > 0)
    commitLines.push(`evicted ${evictedIds.join(",")}`);

  const leaked = findRepoNames(
    union(source.repos, [input.repoKey]),
    `${source.title}\n${source.body}`,
  );
  return {
    ok: true,
    value: {
      repoFile,
      common,
      commonId: write.id,
      commitLines,
      warnings:
        leaked.length > 0
          ? [`本文か見出しに repo 名の部分が含まれている: ${leaked.join(", ")}`]
          : [],
    },
  };
}
