import { sanitize } from "../redact-secrets.ts";
import { containsKeyLike } from "../key-like.ts";
import { stripInvisible } from "../invisible-chars.ts";
import {
  FEEDBACK_AGENTS,
  FEEDBACK_KINDS,
  FIELD_LIMITS,
  LOCAL_ID_PATTERN,
  VM_ID_PATTERN,
  UTC_TIMESTAMP_PATTERN,
  LOCAL_ID_RANDOM_BYTES,
} from "./constants.ts";
import type { FeedbackDeps } from "./deps.ts";

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackAgent = (typeof FEEDBACK_AGENTS)[number];
export type FeedbackItemV1 = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  title: string;
  target: string;
  kind: FeedbackKind;
  body: string;
  source: {
    agent: FeedbackAgent;
    reportedAgent?: FeedbackAgent;
    repoKey: string | null;
    host: string;
    vm: boolean;
  };
};
export type NormalizedField =
  | { ok: true; value: string; redacted: boolean }
  | { ok: false; reason: string };
export type ItemResult =
  | { kind: "ok"; item: FeedbackItemV1 }
  | { kind: "invalid"; reason: string };

export function normalizeField(
  raw: string,
  field: keyof typeof FIELD_LIMITS,
): NormalizedField {
  let value = raw;
  let redacted = false;
  // 除去で隣り合った結合文字や秘密の断片も、同じ順の検査で収束させる。
  for (;;) {
    const normalized = value.normalize("NFKC");
    if (field !== "body" && /[\r\n]/.test(normalized))
      return { ok: false, reason: `${field}: newline` };
    const visible = stripInvisible(normalized, {
      keepNewlines: field === "body",
    });
    let sanitized: ReturnType<typeof sanitize>;
    try {
      sanitized = sanitize(visible);
    } catch {
      return { ok: false, reason: `${field}: sanitize` };
    }
    redacted ||= sanitized.hits > 0;
    if (sanitized.text === value) break;
    value = sanitized.text;
  }
  if (containsKeyLike(value))
    return { ok: false, reason: `${field}: key-like` };
  const length =
    field === "body" ? Buffer.byteLength(value, "utf8") : value.length;
  if (length === 0 || length > FIELD_LIMITS[field])
    return { ok: false, reason: `${field}: length` };
  return { ok: true, value, redacted };
}

export function isFeedbackId(id: string): boolean {
  return LOCAL_ID_PATTERN.test(id) || VM_ID_PATTERN.test(id);
}

export function validateItem(input: object | null): ItemResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { kind: "invalid", reason: "shape" };
  const item = input as Partial<FeedbackItemV1>;
  if (
    item.schemaVersion !== 1 ||
    Object.keys(item).some(
      (key) =>
        ![
          "schemaVersion",
          "id",
          "createdAt",
          "title",
          "target",
          "kind",
          "body",
          "source",
        ].includes(key),
    )
  )
    return { kind: "invalid", reason: "schema" };
  if (typeof item.id !== "string" || !isFeedbackId(item.id))
    return { kind: "invalid", reason: "id" };
  if (
    typeof item.createdAt !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(item.createdAt)
  )
    return { kind: "invalid", reason: "createdAt" };
  const timestamp = new Date(item.createdAt);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString().replace(".000Z", "Z") !== item.createdAt
  )
    return { kind: "invalid", reason: "createdAt" };
  if (!FEEDBACK_KINDS.includes(item.kind as FeedbackKind))
    return { kind: "invalid", reason: "kind" };
  const source = item.source;
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    Object.keys(source).some(
      (key) =>
        !["agent", "reportedAgent", "repoKey", "host", "vm"].includes(key),
    )
  )
    return { kind: "invalid", reason: "source" };
  if (
    !FEEDBACK_AGENTS.includes(source.agent) ||
    ("reportedAgent" in source &&
      !FEEDBACK_AGENTS.includes(source.reportedAgent as FeedbackAgent)) ||
    typeof source.vm !== "boolean" ||
    VM_ID_PATTERN.test(item.id) !== source.vm
  )
    return { kind: "invalid", reason: "source" };
  if (source.repoKey !== null && typeof source.repoKey !== "string")
    return { kind: "invalid", reason: "repoKey" };
  for (const [field, value] of [
    ["title", item.title],
    ["target", item.target],
    ["body", item.body],
    ["host", source.host],
    ...(source.repoKey === null ? [] : [["repoKey", source.repoKey]]),
  ] as const) {
    if (typeof value !== "string")
      return { kind: "invalid", reason: `${field}: type` };
    const normalized = normalizeField(
      value,
      field as keyof typeof FIELD_LIMITS,
    );
    if (normalized.ok && normalized.value !== value)
      return { kind: "invalid", reason: "not-normalized" };
    if (!normalized.ok) return { kind: "invalid", reason: normalized.reason };
  }
  return { kind: "ok", item: item as FeedbackItemV1 };
}

export function parseItem(json: string): ItemResult | { kind: "newer" } {
  try {
    const value = JSON.parse(json) as Partial<FeedbackItemV1> | null;
    if (
      value &&
      Number.isInteger(value.schemaVersion) &&
      typeof value.schemaVersion === "number" &&
      value.schemaVersion > 1
    )
      return { kind: "newer" };
    return validateItem(value);
  } catch {
    return { kind: "invalid", reason: "json" };
  }
}

export function newLocalId(
  now: Date,
  randomBytes: FeedbackDeps["randomBytes"],
): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${Buffer.from(randomBytes(LOCAL_ID_RANDOM_BYTES)).toString("hex")}`;
}
