import {
  normalizeHeading,
  preprocessText,
  validateBody,
  validateTitle,
  type TextRules,
} from "./entry-text.ts";
import {
  COMMON_KEY,
  type LearningEntry,
  type LearningsFile,
} from "./learnings-file.ts";
import { retagEntry } from "./retag.ts";
import {
  allowedInCommon,
  formatTriggers,
  NO_TRIGGERS,
  type ValidatedTriggers,
} from "./triggers.ts";

export const MAX_ENTRIES = 40;
const EVIDENCE_MAX = 200;
const ID_PATTERN = /^L-[0-9a-f]{12}$/;

export type LearningOp =
  | {
      op: "add";
      title: string;
      body: string;
      evidence: string;
      on?: ValidatedTriggers;
    }
  | {
      op: "update";
      id: string;
      title?: string;
      body?: string;
      evidence: string;
      // 渡せば付け替える（空なら外す）。文を変える update で渡さなければ外れる
      on?: ValidatedTriggers;
    }
  | { op: "remove"; id: string; reason: string };
export type OpsContext = {
  today: string;
  repoKey: string | null; // null は repo の外での `add --common`。足す項目の repos は []
  newId: () => string;
  rules: TextRules;
  extraRedact: readonly RegExp[];
  // ファイルに無くても拒否せず捨ててよい id（worker が LLM に見せた後に消えた項目）。
  // ここに無い存在しない id への update / remove は応答全体を拒否する
  droppableIds?: ReadonlySet<string>;
};
export type OpsResult =
  | {
      ok: true;
      value: {
        file: LearningsFile;
        addedIds: string[];
        updatedIds: string[];
        removedIds: string[];
        evictedIds: string[];
        evidence: string[];
        droppedCount: number;
      };
    }
  | { ok: false; reason: string };

// 上限を超えた分を、守る id 以外から seen の少ない順（同数なら updated の古い順、
// それも同じなら位置の早い順）に追い出す。applyOps と昇格が同じ規則を使う
export function evictEntries(
  entries: readonly LearningEntry[],
  protectedIds: ReadonlySet<string>,
  limit: number,
): { entries: LearningEntry[]; evictedIds: string[] } {
  const excess = entries.length - limit;
  if (excess <= 0) return { entries: [...entries], evictedIds: [] };
  const candidates = entries
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => !protectedIds.has(entry.id))
    .sort(
      (a, b) =>
        a.entry.seen - b.entry.seen ||
        a.entry.updated.localeCompare(b.entry.updated) ||
        a.position - b.position,
    )
    .slice(0, excess);
  const drop = new Set(candidates.map((c) => c.entry.id));
  return {
    entries: entries.filter((e) => !drop.has(e.id)),
    evictedIds: candidates.map((c) => c.entry.id),
  };
}

const fail = (reason: string): OpsResult => ({ ok: false, reason });

// 全部か無しか。どれか 1 つでも不正なら何も適用しない
export function applyOps(
  file: LearningsFile,
  ops: readonly LearningOp[],
  ctx: OpsContext,
): OpsResult {
  if (file.readOnly) return fail("read-only file");

  // update と remove は同じ id 名前空間（add の見出し一致もここに衝突する）
  const removeIds = new Set<string>();
  const targetIds = new Set<string>();
  const addHeadings = new Set<string>();
  for (const op of ops) {
    if (op.op === "remove" || op.op === "update") {
      if (targetIds.has(op.id)) return fail("duplicate op on the same id");
      targetIds.add(op.id);
      if (op.op === "remove") removeIds.add(op.id);
    } else {
      const heading = normalizeHeading(
        preprocessText(op.title, ctx.extraRedact),
      );
      if (addHeadings.has(heading)) return fail("duplicate heading in batch");
      addHeadings.add(heading);
    }
  }

  const next = structuredClone(file);
  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  const removedIds: string[] = [];
  const evidence: string[] = [];
  const touched = new Set<string>();
  let droppedCount = 0;

  for (const op of ops) {
    if (op.op === "add") {
      const title = preprocessText(op.title, ctx.extraRedact);
      const body = preprocessText(op.body, ctx.extraRedact);
      const ev = preprocessText(op.evidence, ctx.extraRedact);
      const titleCheck = validateTitle(title, ctx.rules);
      if (!titleCheck.ok) return fail(`title: ${titleCheck.reason}`);
      const bodyCheck = validateBody(body, ctx.rules);
      if (!bodyCheck.ok) return fail(`body: ${bodyCheck.reason}`);
      if (ev.length < 1 || ev.length > EVIDENCE_MAX)
        return fail("evidence length");
      if (
        file.key === COMMON_KEY &&
        op.on !== undefined &&
        !allowedInCommon(op.on)
      )
        return fail("path-prefix is not allowed in common");

      const heading = normalizeHeading(title);
      const existing = next.entries.find(
        (e) => normalizeHeading(e.title) === heading,
      );
      if (existing) {
        if (targetIds.has(existing.id))
          return fail("add and another op on the same id");
        // この add は本文を変えないので、既存の `on` は変えず渡された `on` は捨てる
        existing.seen += 1;
        existing.updated = ctx.today;
        touched.add(existing.id);
        addedIds.push(existing.id);
        evidence.push(`add ${existing.id}: ${ev}`);
      } else {
        const taken = new Set(next.entries.map((e) => e.id));
        let id = ctx.newId();
        while (taken.has(id)) id = ctx.newId();
        const created: LearningEntry = {
          id,
          title,
          body,
          seen: 1,
          repos: ctx.repoKey === null ? [] : [ctx.repoKey],
          updated: ctx.today,
          extra:
            op.on !== undefined && op.on.length > 0
              ? [["on", formatTriggers(op.on)]]
              : [],
        };
        next.entries.push(created);
        touched.add(id);
        addedIds.push(id);
        evidence.push(`add ${id}: ${ev}`);
      }
    } else if (op.op === "update") {
      if (!ID_PATTERN.test(op.id)) return fail("invalid id");
      const target = next.entries.find((e) => e.id === op.id);
      if (!target) {
        if (ctx.droppableIds?.has(op.id)) {
          droppedCount += 1;
          continue;
        }
        return fail(`unknown id ${op.id}`);
      }
      const ev = preprocessText(op.evidence, ctx.extraRedact);
      if (ev.length < 1 || ev.length > EVIDENCE_MAX)
        return fail("evidence length");
      if (
        file.key === COMMON_KEY &&
        op.on !== undefined &&
        !allowedInCommon(op.on)
      )
        return fail("path-prefix is not allowed in common");
      let title = target.title;
      let body = target.body;
      if (op.title !== undefined) {
        title = preprocessText(op.title, ctx.extraRedact);
        const titleCheck = validateTitle(title, ctx.rules);
        if (!titleCheck.ok) return fail(`title: ${titleCheck.reason}`);
        const heading = normalizeHeading(title);
        if (
          next.entries.some(
            (e) => e.id !== target.id && normalizeHeading(e.title) === heading,
          ) ||
          addHeadings.has(heading)
        )
          return fail("title collides with another heading");
      }
      if (op.body !== undefined) {
        body = preprocessText(op.body, ctx.extraRedact);
        const bodyCheck = validateBody(body, ctx.rules);
        if (!bodyCheck.ok) return fail(`body: ${bodyCheck.reason}`);
      }
      const textChanged = title !== target.title || body !== target.body;
      const at = next.entries.findIndex((e) => e.id === target.id);
      touched.add(target.id);
      updatedIds.push(target.id);

      if (!textChanged && op.on !== undefined) {
        // 場面だけの付け替えは seen と updated を動かさない
        const retagged = retagEntry(target, op.on, ev);
        next.entries[at] = retagged.entry;
        if (retagged.line !== null) evidence.push(retagged.line);
        continue;
      }
      target.title = title;
      target.body = body;
      target.seen += 1;
      target.updated = ctx.today;
      evidence.push(`update ${target.id}: ${ev}`);
      if (textChanged) {
        // 文を変えたら、渡されなければ `on` を外す（人が付けた広い場面に書き換えた文を載せない）
        const retagged =
          op.on !== undefined
            ? retagEntry(target, op.on, ev)
            : retagEntry(target, NO_TRIGGERS, "updated by worker");
        next.entries[at] = retagged.entry;
        if (retagged.line !== null) evidence.push(retagged.line);
      }
    } else {
      if (!ID_PATTERN.test(op.id)) return fail("invalid id");
      const at = next.entries.findIndex((e) => e.id === op.id);
      if (at < 0) {
        if (ctx.droppableIds?.has(op.id)) {
          droppedCount += 1;
          continue;
        }
        return fail(`unknown id ${op.id}`);
      }
      const reason = preprocessText(op.reason, ctx.extraRedact);
      if (reason.length < 1 || reason.length > EVIDENCE_MAX)
        return fail("reason length");
      next.entries.splice(at, 1);
      removedIds.push(op.id);
      evidence.push(`remove ${op.id}: ${reason}`);
    }
  }

  const evicted = evictEntries(next.entries, touched, MAX_ENTRIES);
  next.entries = evicted.entries;
  const evictedIds = evicted.evictedIds;

  return {
    ok: true,
    value: {
      file: next,
      addedIds,
      updatedIds,
      removedIds,
      evictedIds,
      evidence,
      droppedCount,
    },
  };
}
