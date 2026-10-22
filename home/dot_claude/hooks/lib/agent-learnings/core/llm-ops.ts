import { normalizeHeading, preprocessText } from "./entry-text.ts";
import type { LearningOp } from "./ops.ts";
import { MAX_PROMOTES_PER_RESPONSE, type PromoteOp } from "./promote.ts";
import { parseTriggers, type ValidatedTriggers } from "./triggers.ts";

export const MAX_LLM_OPS = 20;
export const MAX_LLM_REMOVES = 5;
const ID_PATTERN = /^L-[0-9a-f]{12}$/;
const FENCE = /```json[^\S\n]*\n([\s\S]*?)```/;

export type LlmOpsResult =
  // ops は applyOps に、promotes は applyPromotes に渡す
  | { ok: true; ops: LearningOp[]; promotes: PromoteOp[] }
  | { ok: false; reason: string };

const fail = (reason: string): LlmOpsResult => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// キーの集合が required を全て含み、required と optional 以外を含まない
function hasKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

type ParsedOp = LearningOp | PromoteOp;

// `on` は worker の制限で検査する。外れたら応答全体を拒否する（null を返す）
function parseOn(
  value: Record<string, unknown>,
): { ok: true; on: ValidatedTriggers | undefined } | { ok: false } {
  if (!("on" in value)) return { ok: true, on: undefined };
  const raw = value["on"];
  if (!Array.isArray(raw)) return { ok: false };
  const parsed = parseTriggers(raw, "worker");
  return parsed.ok ? { ok: true, on: parsed.value } : { ok: false };
}

function parseOp(value: unknown): ParsedOp | null {
  if (!isRecord(value)) return null;
  const str = (key: string): string | null => {
    const v = value[key];
    return typeof v === "string" ? v : null;
  };
  switch (value["op"]) {
    case "add": {
      if (!hasKeys(value, ["op", "title", "body", "evidence"], ["on"]))
        return null;
      const title = str("title");
      const body = str("body");
      const evidence = str("evidence");
      if (title === null || body === null || evidence === null) return null;
      const on = parseOn(value);
      if (!on.ok) return null;
      return {
        op: "add",
        title,
        body,
        evidence,
        ...(on.on === undefined ? {} : { on: on.on }),
      };
    }
    case "update": {
      if (!hasKeys(value, ["op", "id", "evidence"], ["title", "body", "on"]))
        return null;
      const id = str("id");
      const evidence = str("evidence");
      if (id === null || !ID_PATTERN.test(id) || evidence === null) return null;
      const on = parseOn(value);
      if (!on.ok) return null;
      const op: LearningOp = {
        op: "update",
        id,
        evidence,
        ...(on.on === undefined ? {} : { on: on.on }),
      };
      for (const key of ["title", "body"] as const) {
        if (key in value) {
          const v = str(key);
          if (v === null) return null;
          op[key] = v;
        }
      }
      return op;
    }
    case "remove": {
      if (!hasKeys(value, ["op", "id", "reason"])) return null;
      const id = str("id");
      const reason = str("reason");
      if (id === null || !ID_PATTERN.test(id) || reason === null) return null;
      return { op: "remove", id, reason };
    }
    case "promote": {
      if (
        !hasKeys(value, ["op", "matchId", "title", "body", "evidence"], ["id"])
      )
        return null;
      const matchId = str("matchId");
      const title = str("title");
      const body = str("body");
      const evidence = str("evidence");
      if (
        matchId === null ||
        !ID_PATTERN.test(matchId) ||
        title === null ||
        body === null ||
        evidence === null
      )
        return null;
      const op: PromoteOp = { op: "promote", matchId, title, body, evidence };
      if ("id" in value) {
        const id = str("id");
        if (id === null || !ID_PATTERN.test(id)) return null;
        op.id = id;
      }
      return op;
    }
    default:
      // 未知の op は応答全体を拒否する
      return null;
  }
}

// LLM の出力文字列から操作列を厳密に取り出す。形だけを見る
// （見出し・本文・evidence の内容は applyOps が検査する）
export function parseLlmOps(response: string): LlmOpsResult {
  const text = FENCE.exec(response)?.[1] ?? response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("not json");
  }
  if (!isRecord(parsed) || !hasKeys(parsed, ["schemaVersion", "ops"]))
    return fail("top-level keys");
  if (parsed["schemaVersion"] !== 1) return fail("schemaVersion");
  const rawOps = parsed["ops"];
  if (!Array.isArray(rawOps)) return fail("ops is not an array");
  if (rawOps.length > MAX_LLM_OPS) return fail("too many ops");
  const ops: LearningOp[] = [];
  const promotes: PromoteOp[] = [];
  for (const raw of rawOps) {
    const op = parseOp(raw);
    if (op === null) return fail("invalid op");
    if (op.op === "promote") promotes.push(op);
    else ops.push(op);
  }
  if (ops.filter((op) => op.op === "remove").length > MAX_LLM_REMOVES)
    return fail("too many removes");
  if (promotes.length > MAX_PROMOTES_PER_RESPONSE)
    return fail("too many promotes");
  return { ok: true, ops, promotes };
}

// 2 つの群をまたぐ検査。applyOps の前に応答全体に対して行う。
// 候補の id への update / remove は現在の repo のファイルに無いので、applyOps では
// 黙って捨てられてしまう。ここで拒否する
export function checkOpGroups(
  ops: readonly LearningOp[],
  promotes: readonly PromoteOp[],
  candidateIds: ReadonlySet<string>,
  extraRedact: readonly RegExp[],
): { ok: true } | { ok: false; reason: string } {
  if (promotes.length === 0) return { ok: true };
  const promoted = new Set<string>();
  const headings = new Set<string>();
  for (const promote of promotes) {
    promoted.add(promote.matchId);
    if (promote.id !== undefined) promoted.add(promote.id);
    headings.add(normalizeHeading(preprocessText(promote.title, extraRedact)));
  }
  for (const op of ops) {
    if (op.op === "add") {
      if (headings.has(normalizeHeading(preprocessText(op.title, extraRedact))))
        return { ok: false, reason: "add heading collides with a promote" };
    } else if (promoted.has(op.id) || candidateIds.has(op.id)) {
      return { ok: false, reason: `${op.op} of a promoted or candidate id` };
    }
  }
  return { ok: true };
}
