import type { LearningOp } from "./ops.ts";

export const MAX_LLM_OPS = 20;
export const MAX_LLM_REMOVES = 5;
const ID_PATTERN = /^L-[0-9a-f]{12}$/;
const FENCE = /```json[^\S\n]*\n([\s\S]*?)```/;

export type LlmOpsResult =
  | { ok: true; ops: LearningOp[] }
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

function parseOp(value: unknown): LearningOp | null {
  if (!isRecord(value)) return null;
  const str = (key: string): string | null => {
    const v = value[key];
    return typeof v === "string" ? v : null;
  };
  switch (value["op"]) {
    case "add": {
      if (!hasKeys(value, ["op", "title", "body", "evidence"])) return null;
      const title = str("title");
      const body = str("body");
      const evidence = str("evidence");
      if (title === null || body === null || evidence === null) return null;
      return { op: "add", title, body, evidence };
    }
    case "update": {
      if (!hasKeys(value, ["op", "id", "evidence"], ["title", "body"]))
        return null;
      const id = str("id");
      const evidence = str("evidence");
      if (id === null || !ID_PATTERN.test(id) || evidence === null) return null;
      const op: LearningOp = { op: "update", id, evidence };
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
    default:
      // promote（plan-3 まで）と未知の op は応答全体を拒否する
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
  for (const raw of rawOps) {
    const op = parseOp(raw);
    if (op === null) return fail("invalid op");
    ops.push(op);
  }
  if (ops.filter((op) => op.op === "remove").length > MAX_LLM_REMOVES)
    return fail("too many removes");
  return { ok: true, ops };
}
