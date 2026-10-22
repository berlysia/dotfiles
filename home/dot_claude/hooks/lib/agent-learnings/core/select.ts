import type { LearningEntry } from "./learnings-file.ts";
import type { Trigger } from "./triggers.ts";

// 場面での注入の上限（spec K6・K7 の暫定値。配備後に実測で見直す）。ここ 1 か所に置く
export const INJECTION_MAX_ITEMS = 3;
export const INJECTION_MAX_BYTES = 2048;
export const SESSION_MAX_ITEMS = 12;
export const SESSION_MAX_BYTES = 16384;

export type InjectionKind = "pre" | "fail" | "path";
export type InjectedRecord = {
  agent: string;
  id: string;
  kind: InjectionKind;
  bytes: number;
};
export type Candidate = {
  entry: LearningEntry;
  fileKey: string;
  trigger: Trigger;
};
// scene-state の読み取りの返り値。records は重複抑止に使える正しい形の行だけ、
// totalCount / totalBytes は知らない形の行も含めた合計（上限が黙って外れないように）
export type InjectedState = {
  records: readonly InjectedRecord[];
  totalCount: number;
  totalBytes: number;
};

// 件数と重複抑止だけを受け持つ。バイト数の打ち切りは renderSituation が行う
export function selectInjectable(input: {
  candidates: readonly Candidate[];
  injected: InjectedState;
  kind: InjectionKind;
  agent: string;
}): { selected: Candidate[]; remainingBytes: number } {
  const { injected, kind, agent } = input;
  const remainingBytes = Math.max(0, SESSION_MAX_BYTES - injected.totalBytes);
  const sessionRoom = SESSION_MAX_ITEMS - injected.totalCount;
  if (sessionRoom <= 0) return { selected: [], remainingBytes };

  // pre と path は同じ「直前」の注入なので互いに数える。fail は別枠（失敗の後にもう一度出す）
  const blocking: readonly InjectionKind[] =
    kind === "fail" ? ["fail"] : ["pre", "path"];
  const already = new Set(
    injected.records
      .filter((r) => r.agent === agent && blocking.includes(r.kind))
      .map((r) => r.id),
  );
  const seenIds = new Set<string>();
  const unique: Candidate[] = [];
  for (const candidate of input.candidates) {
    const id = candidate.entry.id;
    if (seenIds.has(id) || already.has(id)) continue;
    seenIds.add(id);
    unique.push(candidate);
  }
  unique.sort(
    (a, b) =>
      b.entry.seen - a.entry.seen ||
      b.entry.updated.localeCompare(a.entry.updated),
  );
  return {
    selected: unique.slice(0, Math.min(INJECTION_MAX_ITEMS, sessionRoom)),
    remainingBytes,
  };
}
