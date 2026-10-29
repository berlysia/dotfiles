import { createHash } from "node:crypto";
import {
  FEEDBACK_AGENTS,
  MACHINE_NAME_PATTERN,
  MAX_VM_FILE_BYTES,
  SCHEMA_VERSION,
} from "./constants.ts";
import {
  normalizeField,
  validateItem,
  type FeedbackAgent,
  type FeedbackItemV1,
} from "./item.ts";

export type VmRewrite =
  | { kind: "ok"; item: FeedbackItemV1 }
  | { kind: "invalid" }
  | { kind: "unsupported-version" };

const ITEM_KEYS = [
  "schemaVersion",
  "id",
  "createdAt",
  "title",
  "target",
  "kind",
  "body",
  "source",
];
const SOURCE_KEYS = ["agent", "reportedAgent", "repoKey", "host", "vm"];

export const isMachineName = (name: string): boolean =>
  MACHINE_NAME_PATTERN.test(name);

// 同じ machine の同じ中身は同じ id になる。取り込みのやり直しと --retry の突き合わせに使う。
export function vmItemId(machine: string, bytes: Uint8Array): string {
  const hash = createHash("sha256")
    .update(machine)
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest("hex");
  return `vm-${hash.slice(0, 24)}`;
}

// BOM を落とさず、不正なバイト列で失敗する。落とすと JSON として読める別のバイト列と区別できなくなる。
export function decodeVmBytes(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// VM が書いた件を敵対的な入力として検査し直し、ホストが決める値で書き直す。例外は投げない。
export function rewriteVmItem(
  bytes: Uint8Array,
  machine: string,
  now: Date,
): VmRewrite {
  try {
    if (bytes.length > MAX_VM_FILE_BYTES || !isMachineName(machine))
      return { kind: "invalid" };
    const text = decodeVmBytes(bytes);
    if (text === null) return { kind: "invalid" };
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { kind: "invalid" };
    const version = parsed["schemaVersion"];
    if (Number.isInteger(version) && (version as number) > SCHEMA_VERSION)
      return { kind: "unsupported-version" };
    const source = parsed["source"];
    if (
      version !== SCHEMA_VERSION ||
      Object.keys(parsed).some((key) => !ITEM_KEYS.includes(key)) ||
      !isRecord(source) ||
      Object.keys(source).some((key) => !SOURCE_KEYS.includes(key))
    )
      return { kind: "invalid" };
    const reported = source["agent"];
    const reportedAgent = FEEDBACK_AGENTS.includes(reported as FeedbackAgent)
      ? (reported as FeedbackAgent)
      : undefined;
    const repoKey = source["repoKey"];
    const normalizedKey =
      typeof repoKey === "string" ? normalizeField(repoKey, "repoKey") : null;
    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      id: vmItemId(machine, bytes),
      createdAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      title: parsed["title"],
      target: parsed["target"],
      kind: parsed["kind"],
      body: parsed["body"],
      source: {
        agent: "unknown",
        ...(reportedAgent === undefined ? {} : { reportedAgent }),
        repoKey:
          normalizedKey?.ok && normalizedKey.value === repoKey
            ? normalizedKey.value
            : null,
        host: machine,
        vm: true,
      },
    };
    const validated = validateItem(candidate);
    return validated.kind === "ok"
      ? { kind: "ok", item: validated.item }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}
