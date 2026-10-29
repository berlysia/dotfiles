import { createHash } from "node:crypto";
import {
  INVOCATION_MAX_WORDS,
  KNOWN_MODELS,
  MAX_COUNT,
  MAX_DURATION_MS,
  NOTE_DISPLAY_CHARS,
  NOTE_MAX_BYTES,
  NOTE_MAX_CHARS,
  ROW_MAX_BYTES,
} from "./constants.ts";

export const HARNESSES = [
  "claude-code-agent",
  "codex-cli",
  "opencode",
  "cursor",
  "other",
] as const;
export const EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "unknown",
] as const;
export const KINDS = [
  "research",
  "impl",
  "mechanical",
  "review",
  "triage",
  "draft",
] as const;
export const SIZES = ["S", "M", "L"] as const;
export const VERDICTS = ["adopted", "patched", "redone", "discarded"] as const;
export const END_REASONS = ["answer", "aborted", "refusal", "error"] as const;
export const FOUND_BYS = ["main", "user", "reviewer", "ci", "other"] as const;
export const CLAUDE_MODELS = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "inherit",
] as const;

export type Harness = (typeof HARNESSES)[number];
export type Effort = (typeof EFFORTS)[number];
export type Kind = (typeof KINDS)[number];
export type Size = (typeof SIZES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type EndReason = (typeof END_REASONS)[number];
export type FoundBy = (typeof FOUND_BYS)[number];
/** Read side keeps rows whose enum value this reader does not know. */
export type Loose<T extends string> = T | "?";

export type DelegationRow = {
  v: 1;
  type: "delegation";
  id: string;
  at: string;
  harness: Loose<Harness>;
  invocation: string[];
  model: string;
  effort: Loose<Effort>;
  kind: Loose<Kind>;
  size: Loose<Size>;
  sessionId: string | null;
  manual: boolean;
  durationMs: number | null;
  endReason: Loose<EndReason> | null;
  shapeErrors?: number;
  reworks?: number;
  triageExcluded?: number;
  verdict: Loose<Verdict>;
  note?: string;
};
export type AmendRow = {
  v: 1;
  type: "amend";
  id: string;
  at: string;
  laterDefect?: { foundBy: Loose<FoundBy> };
  reworks?: number;
};
export type LapseRow = {
  v: 1;
  type: "lapse";
  id: string;
  at: string;
  openedAt: string | null;
  harness: Loose<Harness>;
  invocation: string[];
  model: string;
  effort: Loose<Effort>;
  sessionId: string | null;
  durationMs: number | null;
  endReason: Loose<EndReason> | null;
};
export type ReviewRow = { v: 1; type: "review"; at: string };
export type LedgerRow = DelegationRow | AmendRow | LapseRow | ReviewRow;

export type Pending = {
  v: 1;
  id: string;
  openedAt: string;
  sessionId: string;
  toolUseId: string;
  harness: Harness;
  invocation: string[];
  model: string;
  effort: Effort;
  agentId: string | null;
  closedAt: string | null;
  endReason: EndReason | null;
  durationMs: number | null;
};

export type SkipReason = "version" | "type" | "broken";
export type ParseResult =
  | { ok: true; row: LedgerRow }
  | { ok: false; reason: SkipReason };

const ID_RE = /^d-[0-9a-f]{12}$/;
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_USE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const isDelegationId = (v: unknown): v is string =>
  typeof v === "string" && ID_RE.test(v);
export const isAgentId = (v: unknown): v is string =>
  typeof v === "string" && AGENT_RE.test(v);
export const isToolUseId = (v: unknown): v is string =>
  typeof v === "string" && TOOL_USE_RE.test(v);

export function isOneOf<T extends string>(
  list: readonly T[],
  v: unknown,
): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function looseEnum<T extends string>(list: readonly T[], v: unknown): Loose<T> {
  return isOneOf(list, v) ? v : "?";
}

export function boundedInt(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max
    ? v
    : null;
}
export const durationOrNull = (v: unknown) => boundedInt(v, MAX_DURATION_MS);
export const countOrNull = (v: unknown) => boundedInt(v, MAX_COUNT);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function wordList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((w): w is string => typeof w === "string")
    .slice(0, INVOCATION_MAX_WORDS);
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * Reads one ledger line. Version, type and breakage are separate outcomes so
 * the caller can count them apart: a v2 row is not corruption.
 */
export function parseRow(line: string): ParseResult {
  if (Buffer.byteLength(line, "utf8") > ROW_MAX_BYTES) {
    return { ok: false, reason: "broken" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: "broken" };
  }
  if (!isObject(raw) || typeof raw.v !== "number") {
    return { ok: false, reason: "broken" };
  }
  if (raw.v !== 1) return { ok: false, reason: "version" };
  const at = isoOrNull(raw.at) ?? "";
  switch (raw.type) {
    case "delegation": {
      if (
        !isDelegationId(raw.id) ||
        typeof raw.harness !== "string" ||
        typeof raw.model !== "string" ||
        typeof raw.effort !== "string" ||
        typeof raw.kind !== "string" ||
        typeof raw.size !== "string" ||
        typeof raw.verdict !== "string"
      ) {
        return { ok: false, reason: "broken" };
      }
      const row: DelegationRow = {
        v: 1,
        type: "delegation",
        id: raw.id,
        at,
        harness: looseEnum(HARNESSES, raw.harness),
        invocation: wordList(raw.invocation),
        model: raw.model,
        effort: looseEnum(EFFORTS, raw.effort),
        kind: looseEnum(KINDS, raw.kind),
        size: looseEnum(SIZES, raw.size),
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
        manual: raw.manual === true,
        durationMs: durationOrNull(raw.durationMs),
        endReason: isOneOf(END_REASONS, raw.endReason)
          ? raw.endReason
          : raw.endReason == null
            ? null
            : "?",
        verdict: looseEnum(VERDICTS, raw.verdict),
      };
      for (const k of ["shapeErrors", "reworks", "triageExcluded"] as const) {
        const n = countOrNull(raw[k]);
        if (n !== null) row[k] = n;
      }
      if (typeof raw.note === "string") row.note = raw.note;
      return { ok: true, row };
    }
    case "amend": {
      if (!isDelegationId(raw.id)) return { ok: false, reason: "broken" };
      const row: AmendRow = { v: 1, type: "amend", id: raw.id, at };
      if (isObject(raw.laterDefect)) {
        row.laterDefect = {
          foundBy: looseEnum(FOUND_BYS, raw.laterDefect.foundBy),
        };
      }
      const n = countOrNull(raw.reworks);
      if (n !== null) row.reworks = n;
      return { ok: true, row };
    }
    case "lapse": {
      if (!isDelegationId(raw.id)) return { ok: false, reason: "broken" };
      return {
        ok: true,
        row: {
          v: 1,
          type: "lapse",
          id: raw.id,
          at,
          openedAt: isoOrNull(raw.openedAt),
          harness: looseEnum(HARNESSES, raw.harness),
          invocation: wordList(raw.invocation),
          model: typeof raw.model === "string" ? raw.model : "unknown",
          effort: looseEnum(EFFORTS, raw.effort),
          sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
          durationMs: durationOrNull(raw.durationMs),
          endReason: isOneOf(END_REASONS, raw.endReason)
            ? raw.endReason
            : raw.endReason == null
              ? null
              : "?",
        },
      };
    }
    case "review": {
      if (at === "") return { ok: false, reason: "broken" };
      return { ok: true, row: { v: 1, type: "review", at } };
    }
    default:
      return { ok: false, reason: "type" };
  }
}

const MODEL_SHAPES: Partial<Record<Harness, RegExp>> = {
  "claude-code-agent": /^(sonnet|opus|haiku|fable|inherit)$/,
  "codex-cli": /^gpt-[0-9a-z.-]{1,32}$/,
  opencode: /^[a-z0-9-]{1,24}\/[a-z0-9.-]{1,32}$/,
  // Manual-only harnesses have no fixed vocabulary; keep the same character
  // class as the others so display hashing still bounds what is shown.
  cursor: /^[a-z0-9][a-z0-9./_-]{0,47}$/,
  other: /^[a-z0-9][a-z0-9./_-]{0,47}$/,
};

export function normalizeModel(harness: string, model: unknown): string {
  if (typeof model !== "string") return "unknown";
  if (model === "unknown") return "unknown";
  const shape = MODEL_SHAPES[harness as Harness];
  return shape !== undefined && shape.test(model) ? model : "unknown";
}

export function displayModel(stored: string): string {
  if (KNOWN_MODELS.includes(stored)) return stored;
  return `m-${createHash("sha256").update(stored).digest("hex").slice(0, 6)}`;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function capNote(note: string): string {
  return truncateUtf8(
    [...note].slice(0, NOTE_MAX_CHARS).join(""),
    NOTE_MAX_BYTES,
  );
}

export type DelegationInput = {
  id: string;
  at: string;
  harness: Harness;
  invocation: string[];
  model: string;
  effort: Effort;
  kind: Kind;
  size: Size;
  sessionId: string | null;
  manual: boolean;
  durationMs: number | null;
  endReason: EndReason | null;
  verdict: Verdict;
  shapeErrors?: number;
  reworks?: number;
  triageExcluded?: number;
  note?: string;
};

/** Applies the writer-side limits; the input must already have valid enums. */
export function buildDelegationRow(input: DelegationInput): DelegationRow {
  const row: DelegationRow = {
    v: 1,
    type: "delegation",
    id: input.id,
    at: input.at,
    harness: input.harness,
    invocation: input.invocation.slice(0, INVOCATION_MAX_WORDS),
    model: normalizeModel(input.harness, input.model),
    effort: input.effort,
    kind: input.kind,
    size: input.size,
    sessionId: input.sessionId,
    manual: input.manual,
    durationMs: durationOrNull(input.durationMs),
    endReason: input.endReason,
    verdict: input.verdict,
  };
  for (const k of ["shapeErrors", "reworks", "triageExcluded"] as const) {
    const n = countOrNull(input[k]);
    if (n !== null) row[k] = n;
  }
  if (input.note !== undefined && input.note !== "") {
    row.note = capNote(input.note);
  }
  return row;
}

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// C0, DEL, C1, and the bidi embedding/isolate controls.
const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

/** Stored text is data; it is shown on one line, cut short, and labelled. */
export function formatNote(note: string): string {
  const clean = note.replace(ANSI_RE, "").replace(CONTROL_RE, "");
  const cut = [...clean].slice(0, NOTE_DISPLAY_CHARS).join("");
  return `note(data):「${cut}」`;
}
