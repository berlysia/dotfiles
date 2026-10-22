import { validateTitle } from "./entry-text.ts";
import {
  COMMON_KEY,
  type LearningEntry,
  type LearningsFile,
} from "./learnings-file.ts";
import {
  allowedInCommon,
  formatTriggers,
  parseTriggers,
  readOn,
  type TriggerError,
  type TriggerMode,
  type ValidatedTriggers,
} from "./triggers.ts";

// `on` の付け替え。依存の向きは ops → retag → triggers。
// ops.ts は retagEntry だけを import し、planRetag・applyRetag は CLI が使う

const ID_PATTERN = /^L-[0-9a-f]{12}$/;

// --- 1 項目の付け替え（seen と updated を動かさない規則はここ 1 か所） --------

const describeOn = (entry: LearningEntry): string => {
  const on = readOn(entry);
  if (on.state === "absent") return "none";
  if (on.state === "invalid") return "invalid";
  return formatTriggers(on.triggers);
};

function withOn(entry: LearningEntry, on: ValidatedTriggers): LearningEntry {
  const value = formatTriggers(on);
  const extra: Array<[string, string]> = [];
  let placed = false;
  for (const [key, v] of entry.extra) {
    if (key !== "on") extra.push([key, v]);
    // 元の位置を保つ（メタ行の並びを不必要に変えない）
    else if (!placed && on.length > 0) {
      extra.push(["on", value]);
      placed = true;
    }
  }
  if (!placed && on.length > 0) extra.push(["on", value]);
  return { ...entry, extra };
}

// `on` が空なら外す。無い `on` を外す呼び出しは行を返さない（変わらないため）
export function retagEntry(
  entry: LearningEntry,
  on: ValidatedTriggers,
  evidence?: string,
): { entry: LearningEntry; line: string | null } {
  const suffix = evidence === undefined ? "" : ` (${evidence})`;
  const current = describeOn(entry);
  if (on.length === 0) {
    const absent = readOn(entry).state === "absent";
    return {
      entry: withOn(entry, on),
      line: absent ? null : `untag ${entry.id}: ${current}${suffix}`,
    };
  }
  return {
    entry: withOn(entry, on),
    line: `retag ${entry.id}: ${current} -> ${formatTriggers(on)}${suffix}`,
  };
}

// --- 方針 -------------------------------------------------------------------

declare const policyBrand: unique symbol;
// 作れるのは policyFor だけ（矛盾した組み合わせを型で作らせない）
export type RetagPolicy = {
  readonly mode: TriggerMode;
  readonly scope: "repo-only" | "repo-and-common";
  readonly requireExpect: boolean;
  readonly maxLines: number;
  readonly [policyBrand]: true;
};

export function policyFor(mode: TriggerMode): RetagPolicy {
  return (
    mode === "human"
      ? {
          mode,
          scope: "repo-and-common",
          requireExpect: true,
          maxLines: 200,
        }
      : { mode, scope: "repo-only", requireExpect: false, maxLines: 200 }
  ) as RetagPolicy;
}

export type RetagOp = { id: string; on: ValidatedTriggers };

// --- ファイルの読み取り -------------------------------------------------------

export type ParseRetagError =
  | TriggerError
  | "bad-line"
  | "bad-id"
  | "duplicate-id";
export type ParseRetagResult =
  | { ok: true; ops: RetagOp[] }
  | { ok: false; line: number; error: ParseRetagError }
  | { ok: false; error: "too-many-lines" };

// 1 行 `<id>\t<on>`。行の内容は結果に含めない
export function parseRetagFile(
  text: string,
  policy: RetagPolicy,
): ParseRetagResult {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.filter((l) => l !== "").length > policy.maxLines)
    return { ok: false, error: "too-many-lines" };
  const ops: RetagOp[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const at = index + 1;
    const tab = line.indexOf("\t");
    if (tab < 0) return { ok: false, line: at, error: "bad-line" };
    const id = line.slice(0, tab);
    const onText = line.slice(tab + 1);
    if (!ID_PATTERN.test(id)) return { ok: false, line: at, error: "bad-id" };
    if (onText.includes("\t"))
      return { ok: false, line: at, error: "bad-line" };
    if (seen.has(id)) return { ok: false, line: at, error: "duplicate-id" };
    seen.add(id);
    const parsed = parseTriggers(
      onText === "" ? [] : onText.split(","),
      policy.mode,
    );
    if (!parsed.ok) return { ok: false, line: at, error: parsed.error };
    ops.push({ id, on: parsed.value });
  }
  return { ok: true, ops };
}

// --- 計画 -------------------------------------------------------------------

// 計画した時点の `on`（生の値。無ければ null）・title・body
export type RetagExpect = {
  id: string;
  on: string | null;
  title: string;
  body: string;
};
export type PlannedRetag = {
  id: string;
  fileKey: string;
  // "" は `on` が無い。文法に合わなければ "invalid"
  currentOn: string;
  nextOn: ValidatedTriggers;
  title: string; // validateTitle に通らなければ "invalid"
  expect: RetagExpect;
};
export type PlanRetagResult =
  | { ok: true; planned: PlannedRetag[] }
  | { ok: false; error: "common-not-allowed" | "missing"; count: number };

const rawOn = (entry: LearningEntry): string | null => {
  const values = entry.extra.filter(([key]) => key === "on");
  return values.length === 0 ? null : JSON.stringify(values.map(([, v]) => v));
};

// repo-only でも common を見るのは、common の id を「無い」ではなく「許されない」と区別するため
export function planRetag(
  files: { repo: LearningsFile; common: LearningsFile | null },
  ops: readonly RetagOp[],
  policy: RetagPolicy,
): PlanRetagResult {
  const planned: PlannedRetag[] = [];
  let commonHits = 0;
  let missing = 0;
  for (const op of ops) {
    const inRepo = files.repo.entries.find((e) => e.id === op.id);
    const inCommon = inRepo
      ? undefined
      : files.common?.entries.find((e) => e.id === op.id);
    const found = inRepo ?? inCommon;
    if (!found) {
      missing += 1;
      continue;
    }
    if (inCommon && policy.scope === "repo-only") {
      commonHits += 1;
      continue;
    }
    const on = readOn(found);
    planned.push({
      id: op.id,
      fileKey: inCommon ? COMMON_KEY : files.repo.key,
      currentOn:
        on.state === "absent"
          ? ""
          : on.state === "invalid"
            ? "invalid"
            : formatTriggers(on.triggers),
      nextOn: op.on,
      title: validateTitle(found.title, { allowUrl: true }).ok
        ? found.title
        : "invalid",
      expect: {
        id: op.id,
        on: rawOn(found),
        title: found.title,
        body: found.body,
      },
    });
  }
  if (commonHits > 0)
    return { ok: false, error: "common-not-allowed", count: commonHits };
  if (missing > 0) return { ok: false, error: "missing", count: missing };
  return { ok: true, planned };
}

// --- 適用 -------------------------------------------------------------------

export type ApplyRetagResult =
  | { ok: true; file: LearningsFile; lines: string[] }
  | {
      ok: false;
      reason:
        | "read-only"
        | "common-not-allowed"
        | "path-prefix-in-common"
        | "expect-required"
        | "changed"
        | "missing"
        | "duplicate-id";
    };

// 1 つのファイルに対する適用。複数のファイルにまたがる場合は、呼び出し側が 1 つの lock の
// 中で全ファイルの applyRetag が通ったときだけ書く
export function applyRetag(
  file: LearningsFile,
  ops: readonly RetagOp[],
  policy: RetagPolicy,
  expects?: readonly RetagExpect[],
): ApplyRetagResult {
  const fail = (
    reason: Extract<ApplyRetagResult, { ok: false }>["reason"],
  ): ApplyRetagResult => ({ ok: false, reason });
  if (file.readOnly) return fail("read-only");
  const isCommon = file.key === COMMON_KEY;
  if (isCommon && policy.scope === "repo-only")
    return fail("common-not-allowed");
  if (new Set(ops.map((o) => o.id)).size !== ops.length)
    return fail("duplicate-id");
  if (isCommon && !ops.every((o) => allowedInCommon(o.on)))
    return fail("path-prefix-in-common");
  if (policy.requireExpect && expects === undefined)
    return fail("expect-required");

  const entries = file.entries.map((e) => e);
  const lines: string[] = [];
  for (const op of ops) {
    const at = entries.findIndex((e) => e.id === op.id);
    const target = entries[at];
    if (target === undefined) return fail("missing");
    if (policy.requireExpect) {
      const expect = expects?.find((x) => x.id === op.id);
      if (expect === undefined) return fail("expect-required");
      if (
        expect.on !== rawOn(target) ||
        expect.title !== target.title ||
        expect.body !== target.body
      )
        return fail("changed");
    }
    const result = retagEntry(target, op.on);
    entries[at] = result.entry;
    if (result.line !== null) lines.push(result.line);
  }
  return { ok: true, file: { ...file, entries }, lines };
}
