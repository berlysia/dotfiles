/**
 * The "decision sections" hash, the `.design-baseline` file, and the pure
 * judgment `workflow-cli round` applies to `--self-extend --cause <value>`.
 *
 * Why not reuse `computeDesignHash`: that hash decides approval and covers
 * Files / Key Decisions / Scope / Tasks. Here only Key Decisions and the
 * Alternative Approaches section matter (the sections `workflow.md` 5.2 ties to
 * `--full`), with whitespace folded so a reflow does not count as a change.
 *
 * Why not `.round-baseline`: that file feeds the reviewer time window. Adding
 * a column would couple two readers to one format.
 *
 * `.design-baseline` is written by the model's own CLI call and is not
 * authenticated: it feeds the cause label only, never approval or the gate.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { extractSectionBody } from "./document-hash.ts";
import type { WorkflowDocumentType } from "./workflow-paths.ts";

export const EXTENSION_CAUSES = [
  "landing",
  "kd-changed",
  "blocker",
  "not-narrowing",
] as const;
export type ExtensionCause = (typeof EXTENSION_CAUSES)[number];

export function isExtensionCause(value: string): value is ExtensionCause {
  return (EXTENSION_CAUSES as readonly string[]).includes(value);
}

const DECISION_SECTION_HEADINGS = [
  "Key Decisions",
  "Alternative Approaches (Greenfield View)",
];

/** null when neither section is present (a stable hash of nothing would match any other empty document). */
export function computeDecisionSectionsHash(content: string): string | null {
  const parts: string[] = [];
  for (const heading of DECISION_SECTION_HEADINGS) {
    const body = extractSectionBody(content, heading);
    if (body !== null) {
      parts.push(`## ${heading}\n${body.replace(/\s+/g, " ").trim()}`);
    }
  }
  if (parts.length === 0) return null;
  return createHash("sha256").update(parts.join("\n"), "utf-8").digest("hex");
}

export type BaselineLookup =
  | { kind: "found"; hash: string }
  | { kind: "missing" }
  | { kind: "unreadable" };

const BASELINE_FILE = ".design-baseline";
const BASELINE_DOC_REGEX = /^(?:spec|plan|plan-\d+)\.md$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isBaselineDocName(doc: string): boolean {
  return BASELINE_DOC_REGEX.test(doc);
}

/**
 * Last line of `doc` in the file content. A line belongs to `doc` by its first
 * column; if that last line is malformed the doc is unreadable (not missing),
 * so the caller can tell "no record yet" from "a record I cannot trust".
 */
export function parseDesignBaseline(
  content: string,
  doc: string,
): BaselineLookup {
  if (!isBaselineDocName(doc)) return { kind: "unreadable" };
  let last: string | null = null;
  for (const line of content.split("\n")) {
    if (line.split("\t")[0] === doc) last = line;
  }
  if (last === null) return { kind: "missing" };
  const columns = last.split("\t");
  const [, round, hash] = columns;
  if (
    columns.length !== 3 ||
    round === undefined ||
    hash === undefined ||
    !/^\d+$/.test(round) ||
    !SHA256_HEX.test(hash)
  ) {
    return { kind: "unreadable" };
  }
  return { kind: "found", hash };
}

export function readDesignBaseline(wfDir: string, doc: string): BaselineLookup {
  let content: string;
  try {
    content = readFileSync(resolve(wfDir, BASELINE_FILE), "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
  return parseDesignBaseline(content, doc);
}

/** Throws on any failure; the caller decides how loud to be. */
export function appendDesignBaseline(
  wfDir: string,
  doc: string,
  round: number,
  hash: string,
): void {
  if (!isBaselineDocName(doc) || !SHA256_HEX.test(hash)) {
    throw new Error(`invalid design-baseline entry for "${doc}"`);
  }
  const fd = openSync(
    resolve(wfDir, BASELINE_FILE),
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_APPEND |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${doc}\t${round}\t${hash}\n`);
  } finally {
    closeSync(fd);
  }
}

export interface RoundExtensionRequest {
  documentType: WorkflowDocumentType;
  /**
   * Where the cycle stands. `beyond` is the reframer and human stages, where
   * the phase check (not this judgment) decides whether `--self-extend` runs.
   */
  stage: "within-budget" | "self-extendable" | "beyond";
  approver: "human" | "self" | "reframer" | null;
  cause: string | undefined;
  full: boolean;
  /** Verdict of the newest marker after the last pass, null when none. */
  latestVerdict: string | null;
  baseline: BaselineLookup;
  /** Current decision-sections hash; null when the document has neither section. */
  currentHash: string | null;
}

export type RoundExtensionDecision =
  | { ok: true; cause: ExtensionCause | null }
  | { ok: false; message: string };

const CAUSE_USAGE =
  'use `--self-extend --cause <landing|kd-changed|blocker|not-narrowing> --reason "<why>"`; --reason and the other arguments are unchanged. landing: the remaining findings can be fixed without changing Key Decisions; not-narrowing: findings are not narrowing; blocker: the latest verdict is blocker; kd-changed: Key Decisions or Alternative Approaches changed since the last round';

const BASELINE_RECOVERY =
  "fix the line for this document in .design-baseline in the workflow dir, or delete it (a missing line is treated as no record)";

const reject = (message: string): RoundExtensionDecision => ({
  ok: false,
  message,
});

type DesignChange = "changed" | "unchanged" | "unknown" | "unreadable";

function judgeDesignChange(req: RoundExtensionRequest): DesignChange {
  // plan-N.md has no decision sections, so its hash never moves.
  if (req.documentType === "plan-numbered" || req.currentHash === null) {
    return "unchanged";
  }
  switch (req.baseline.kind) {
    case "found":
      return req.baseline.hash === req.currentHash ? "unchanged" : "changed";
    case "missing":
      return "unknown";
    case "unreadable":
      return "unreadable";
  }
}

/**
 * Whether a round request is accepted. Only `--self-extend` carries a cause;
 * blocker and kd-changed are checked against facts, landing and not-narrowing
 * are the operator's own claim (both allow the extension either way).
 */
export function decideRoundExtension(
  req: RoundExtensionRequest,
): RoundExtensionDecision {
  if (req.approver !== "self") {
    return req.cause === undefined
      ? { ok: true, cause: null }
      : reject(
          "--cause is only for --self-extend; --extend and --reframer-extend do not take it",
        );
  }

  if (req.cause === undefined) {
    return reject(`--self-extend requires --cause: ${CAUSE_USAGE}`);
  }
  if (!isExtensionCause(req.cause)) {
    return reject(`unknown --cause "${req.cause}": ${CAUSE_USAGE}`);
  }
  const cause = req.cause;
  const change = judgeDesignChange(req);

  if (req.stage === "self-extendable") {
    if (req.latestVerdict === "blocker") {
      if (cause !== "blocker") {
        return reject(
          `the latest verdict is blocker, so --cause must be blocker (got ${cause})`,
        );
      }
    } else if (cause === "blocker") {
      return reject(
        `--cause blocker needs the latest verdict in this cycle to be blocker (found ${req.latestVerdict ?? "no marker"})`,
      );
    } else if (change === "changed" && cause !== "kd-changed") {
      return reject(
        `Key Decisions or Alternative Approaches changed since the last round, so --cause must be kd-changed (got ${cause})`,
      );
    } else if (cause === "kd-changed") {
      if (change === "unchanged") {
        return reject(
          "--cause kd-changed needs Key Decisions or Alternative Approaches to have changed since the last round; they did not (whitespace-only edits do not count)",
        );
      }
      if (change === "unreadable") {
        return reject(
          `--cause kd-changed cannot be checked because .design-baseline is unreadable: ${BASELINE_RECOVERY}`,
        );
      }
    }
  }

  if (req.full) {
    if (change === "unchanged") {
      return reject(
        "--self-extend --full needs Key Decisions or Alternative Approaches to have changed since the last round; they did not (plan-N.md and documents without those sections never qualify)",
      );
    }
    if (change === "unreadable") {
      return reject(
        `--full cannot be checked because .design-baseline is unreadable: ${BASELINE_RECOVERY}`,
      );
    }
  }
  return { ok: true, cause };
}
