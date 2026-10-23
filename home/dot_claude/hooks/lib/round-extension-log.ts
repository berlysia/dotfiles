/**
 * `round-extensions.log`: how a line is written, read and counted.
 *
 * The writer (`workflow-cli round`) and the readers (`status`,
 * `ask-approval`) share this one module so the column layout lives in one
 * place. It must not import `workflow-review-core.ts`: that module re-exports
 * from here.
 *
 * The log is appended by the model's own CLI call and is not authenticated; it
 * feeds the count shown at approval only, never approval or the gate.
 */

import { type ExtensionCause, isExtensionCause } from "./design-baseline.ts";

/** Who took responsibility for continuing past a cap; recorded in the log. */
export type ExtensionApprover = "human" | "self" | "reframer";

function isSeparatorOrControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

const EXTENSION_REASON_MAX_LENGTH = 500;

/**
 * Keep an extension reason on one log line. The reason is free text that may
 * echo document content, so control characters and line separators become a
 * single space each (no column or line forgery), then the text is trimmed and
 * capped. Guards the one-line, fixed-column shape only, not the approver
 * column's truthfulness.
 */
export function sanitizeExtensionReason(reason: string): string {
  let flattened = "";
  for (const char of reason) {
    flattened += isSeparatorOrControl(char.codePointAt(0) ?? 0) ? " " : char;
  }
  return flattened.trim().slice(0, EXTENSION_REASON_MAX_LENGTH).trim();
}

/**
 * One `round-extensions.log` line:
 * `<ISO8601>\t<doc>\t<round>\t<approver>\t<reason>\t<cause>`. The approver
 * sits before the free-text reason, and the cause (`-` unless self) after it,
 * so appending the column left the earlier ones where they were.
 */
export function formatExtensionLogLine(entry: {
  at: Date;
  doc: string;
  round: number;
  approver: ExtensionApprover;
  reason: string;
  cause?: ExtensionCause | null | undefined;
}): string {
  const cause = entry.approver === "self" ? (entry.cause ?? "-") : "-";
  return `${entry.at.toISOString()}\t${entry.doc}\t${entry.round}\t${entry.approver}\t${sanitizeExtensionReason(entry.reason)}\t${cause}`;
}

export interface ExtensionRow {
  doc: string;
  round: number;
  approver: ExtensionApprover;
  /** `unknown` for a 5-column self row written before the cause column; null when the approver is not self. */
  cause: ExtensionCause | "unknown" | null;
}

function isApprover(value: string | undefined): value is ExtensionApprover {
  return value === "human" || value === "self" || value === "reframer";
}

/**
 * Rows by column count, split on LF and TAB only (other separators stay inside
 * their column). Rows that cannot be read as a coherent extension are dropped:
 * blank, 3 columns or fewer, 7 or more, an unknown approver, a round that is
 * not a number, or a cause column that contradicts the approver.
 */
export function parseExtensionLog(content: string): ExtensionRow[] {
  const rows: ExtensionRow[] = [];
  for (const line of content.split("\n")) {
    if (line === "") continue;
    const columns = line.split("\t");
    if (columns.length < 4 || columns.length > 6) continue;
    const doc = columns[1];
    const roundText = columns[2];
    if (doc === undefined || roundText === undefined) continue;
    if (!/^\d+$/.test(roundText)) continue;
    const round = Number.parseInt(roundText, 10);
    if (columns.length === 4) {
      rows.push({ doc, round, approver: "human", cause: null });
      continue;
    }
    const approver = columns[3];
    if (!isApprover(approver)) continue;
    if (columns.length === 5) {
      rows.push({
        doc,
        round,
        approver,
        cause: approver === "self" ? "unknown" : null,
      });
      continue;
    }
    const cause = columns[5] ?? "";
    if (approver === "self") {
      if (!isExtensionCause(cause)) continue;
      rows.push({ doc, round, approver, cause });
    } else if (cause === "-") {
      rows.push({ doc, round, approver, cause: null });
    }
  }
  return rows;
}

export interface ExtensionTally {
  human: number;
  self: number;
  reframer: number;
  selfCauses: Record<ExtensionCause | "unknown", number>;
}

/**
 * Counts for one document's current review cycle: rows whose round is above
 * `lastPassRound` (0 when the document has no pass marker yet). The caller
 * supplies the round, so this module reads no marker text.
 */
export function tallyExtensions(
  rows: readonly ExtensionRow[],
  doc: string,
  lastPassRound: number,
): ExtensionTally {
  const tally: ExtensionTally = {
    human: 0,
    self: 0,
    reframer: 0,
    selfCauses: {
      landing: 0,
      "kd-changed": 0,
      blocker: 0,
      "not-narrowing": 0,
      unknown: 0,
    },
  };
  for (const row of rows) {
    if (row.doc !== doc || row.round <= lastPassRound) continue;
    tally[row.approver] += 1;
    if (row.approver === "self" && row.cause !== null) {
      tally.selfCauses[row.cause] += 1;
    }
  }
  return tally;
}

/** One line for the approver, or null when nothing was extended (no line is better than a line of zeros). */
export function formatExtensionTally(tally: ExtensionTally): string | null {
  if (tally.human + tally.self + tally.reframer === 0) return null;
  const c = tally.selfCauses;
  return `延長: human ${tally.human} / self ${tally.self}（landing ${c.landing}、kd-changed ${c["kd-changed"]}、blocker ${c.blocker}、not-narrowing ${c["not-narrowing"]}、不明 ${c.unknown}）/ reframer ${tally.reframer}`;
}
