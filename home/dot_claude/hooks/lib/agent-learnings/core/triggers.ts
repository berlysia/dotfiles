import { COMMON_KEY, type LearningEntry } from "./learnings-file.ts";

// 場面（`on`）の文法・読み直し・照合・絞り込み。依存の向きは ops → retag → triggers。
// 照合に正規表現は使わない（文法の検査に使う固定の正規表現だけが例外）

export type Trigger =
  | { kind: "session" }
  | { kind: "cmd"; words: [string] | [string, string] }
  | { kind: "path-prefix"; prefix: string } // 末尾の "/" を除いた形
  | { kind: "path-suffix"; suffix: string }; // 先頭の "*" を除いた形
declare const validatedBrand: unique symbol;
// parseTriggers を通った値だけが持つ印。ops はこの型しか受け取らない
export type ValidatedTriggers = readonly Trigger[] & {
  readonly [validatedBrand]: true;
};
export type TriggerError = "bad-grammar" | "too-many";
export type Situation =
  | { kind: "cmd"; words: readonly string[] }
  | { kind: "path"; relPath: string };

export const MAX_TRIGGERS = 4;

const WORD = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const PREFIX_CHARS = /^[A-Za-z0-9._/-]{1,80}$/;
const SUFFIX_CHARS = /^[A-Za-z0-9._-]{3,40}$/;

// ValidatedTriggers への cast はここ 1 か所だけ
const brand = (triggers: readonly Trigger[]): ValidatedTriggers =>
  triggers as ValidatedTriggers;

// `on` を外す操作に渡す空の値
export const NO_TRIGGERS: ValidatedTriggers = brand([]);

function parseOne(raw: unknown): Trigger | null {
  if (typeof raw !== "string") return null;
  if (raw === "session") return { kind: "session" };
  if (raw.startsWith("cmd:")) {
    const words = raw.slice(4).split(" ");
    if (words.length > 2 || !words.every((w) => WORD.test(w))) return null;
    return words.length === 1
      ? { kind: "cmd", words: [words[0] ?? ""] }
      : { kind: "cmd", words: [words[0] ?? "", words[1] ?? ""] };
  }
  if (raw.startsWith("path:")) {
    const rest = raw.slice(5);
    if (rest.startsWith("*")) {
      const suffix = rest.slice(1);
      if (!SUFFIX_CHARS.test(suffix) || !suffix.includes(".")) return null;
      return { kind: "path-suffix", suffix };
    }
    if (!PREFIX_CHARS.test(rest)) return null;
    const prefix = rest.endsWith("/") ? rest.slice(0, -1) : rest;
    const parts = prefix.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
    return { kind: "path-prefix", prefix };
  }
  return null;
}

export function formatTriggers(triggers: readonly Trigger[]): string {
  return triggers
    .map((t) => {
      switch (t.kind) {
        case "session":
          return "session";
        case "cmd":
          return `cmd:${t.words.join(" ")}`;
        case "path-prefix":
          return `path:${t.prefix}/`;
        case "path-suffix":
          return `path:*${t.suffix}`;
      }
    })
    .join(",");
}

// 文法（語の形・4 個まで・重複の除去）だけを検査する。誰が付けるかでは制限しない
export function parseTriggers(
  values: readonly unknown[],
): { ok: true; value: ValidatedTriggers } | { ok: false; error: TriggerError } {
  const parsed: Trigger[] = [];
  for (const raw of values) {
    const one = parseOne(raw);
    if (one === null) return { ok: false, error: "bad-grammar" };
    parsed.push(one);
  }
  const seen = new Set<string>();
  const unique = parsed.filter((t) => {
    const key = formatTriggers([t]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > MAX_TRIGGERS) return { ok: false, error: "too-many" };
  return { ok: true, value: brand(unique) };
}

export type OnState =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "valid"; triggers: ValidatedTriggers };

// 読む側の再検査はこの関数 1 つで行う。文法に合わない値（古い書き手・手での編集）は
// `on` が無いものとは区別しつつ、照合には使わない
export function readOn(entry: LearningEntry): OnState {
  const values = entry.extra.filter(([key]) => key === "on");
  if (values.length === 0) return { state: "absent" };
  if (values.length > 1) return { state: "invalid" };
  const parsed = parseTriggers((values[0]?.[1] ?? "").split(","));
  return parsed.ok
    ? { state: "valid", triggers: parsed.value }
    : { state: "invalid" };
}

export const allowedInCommon = (triggers: readonly Trigger[]): boolean =>
  triggers.every((t) => t.kind !== "path-prefix");

export const stripForCommon = (
  triggers: readonly Trigger[],
): ValidatedTriggers => brand(triggers.filter((t) => t.kind !== "path-prefix"));

// 照合と絞り込みが共有する。空なら「`on` が無い」扱い（開始時に流れる）
export function effectiveTriggers(
  entry: LearningEntry,
  fileKey: string,
): readonly Trigger[] {
  const on = readOn(entry);
  if (on.state !== "valid") return [];
  return fileKey === COMMON_KEY ? stripForCommon(on.triggers) : on.triggers;
}

function matches(trigger: Trigger, situation: Situation): boolean {
  if (trigger.kind === "cmd")
    return (
      situation.kind === "cmd" &&
      trigger.words.every((word, i) => situation.words[i] === word)
    );
  if (situation.kind !== "path") return false;
  if (trigger.kind === "path-prefix")
    return (
      situation.relPath === trigger.prefix ||
      situation.relPath.startsWith(`${trigger.prefix}/`)
    );
  if (trigger.kind === "path-suffix")
    return situation.relPath.endsWith(trigger.suffix);
  return false;
}

export function matchTriggers(
  entry: LearningEntry,
  fileKey: string,
  situation: Situation,
): Trigger | null {
  return (
    effectiveTriggers(entry, fileKey).find((t) => matches(t, situation)) ?? null
  );
}

export function filterByTrigger(
  entries: readonly LearningEntry[],
  fileKey: string,
  trigger: Trigger,
): LearningEntry[] {
  const wanted = formatTriggers([trigger]);
  return entries.filter((entry) => {
    const effective = effectiveTriggers(entry, fileKey);
    if (trigger.kind === "session")
      return (
        effective.length === 0 || effective.some((t) => t.kind === "session")
      );
    return effective.some((t) => formatTriggers([t]) === wanted);
  });
}
