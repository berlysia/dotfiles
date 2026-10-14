import {
  normalizeHeading,
  preprocessText,
  validateBody,
  validateTitle,
  type TextRules,
} from "./entry-text.ts";
import type { LearningEntry, LearningsFile } from "./learnings-file.ts";

export const MAX_ENTRIES = 40;
const EVIDENCE_MAX = 200;
const ID_PATTERN = /^L-[0-9a-f]{12}$/;

export type LearningOp =
  | { op: "add"; title: string; body: string; evidence: string }
  | { op: "remove"; id: string; reason: string };
export type OpsContext = {
  today: string;
  repoKey: string | null; // null は repo の外での `add --common`。足す項目の repos は []
  newId: () => string;
  rules: TextRules;
  extraRedact: readonly RegExp[];
};
export type OpsResult =
  | {
      ok: true;
      value: {
        file: LearningsFile;
        addedIds: string[];
        removedIds: string[];
        evictedIds: string[];
        evidence: string[];
      };
    }
  | { ok: false; reason: string };

const fail = (reason: string): OpsResult => ({ ok: false, reason });

// 全部か無しか。どれか 1 つでも不正なら何も適用しない
export function applyOps(
  file: LearningsFile,
  ops: readonly LearningOp[],
  ctx: OpsContext,
): OpsResult {
  if (file.readOnly) return fail("read-only file");

  const removeIds = new Set<string>();
  const addHeadings = new Set<string>();
  for (const op of ops) {
    if (op.op === "remove") {
      if (removeIds.has(op.id)) return fail("duplicate remove id");
      removeIds.add(op.id);
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
  const removedIds: string[] = [];
  const evidence: string[] = [];
  const touched = new Set<string>();

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

      const heading = normalizeHeading(title);
      const existing = next.entries.find(
        (e) => normalizeHeading(e.title) === heading,
      );
      if (existing) {
        if (removeIds.has(existing.id))
          return fail("add and remove on the same id");
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
          extra: [],
        };
        next.entries.push(created);
        touched.add(id);
        addedIds.push(id);
        evidence.push(`add ${id}: ${ev}`);
      }
    } else {
      if (!ID_PATTERN.test(op.id)) return fail("invalid id");
      const at = next.entries.findIndex((e) => e.id === op.id);
      if (at < 0) return fail(`unknown id ${op.id}`);
      const reason = preprocessText(op.reason, ctx.extraRedact);
      if (reason.length < 1 || reason.length > EVIDENCE_MAX)
        return fail("reason length");
      next.entries.splice(at, 1);
      removedIds.push(op.id);
      evidence.push(`remove ${op.id}: ${reason}`);
    }
  }

  const evictedIds: string[] = [];
  const excess = next.entries.length - MAX_ENTRIES;
  if (excess > 0) {
    const candidates = next.entries
      .map((entry, position) => ({ entry, position }))
      .filter(({ entry }) => !touched.has(entry.id))
      .sort(
        (a, b) =>
          a.entry.seen - b.entry.seen ||
          a.entry.updated.localeCompare(b.entry.updated) ||
          a.position - b.position,
      )
      .slice(0, excess);
    const drop = new Set(candidates.map((c) => c.entry.id));
    for (const c of candidates) evictedIds.push(c.entry.id);
    next.entries = next.entries.filter((e) => !drop.has(e.id));
  }

  return {
    ok: true,
    value: { file: next, addedIds, removedIds, evictedIds, evidence },
  };
}
