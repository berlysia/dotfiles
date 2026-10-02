/**
 * The approval ledger (spec K8): which version of a workflow document a
 * human approved. One JSON object per line, appended by approval-recorder
 * when the user says `承認` in the conversation. The gate trusts this file,
 * not the Approval Status line -- the line is display and the way to revoke.
 *
 * JSON Lines so document names and session ids need no delimiter rules of
 * their own. The reader keeps only the last line per document: approve,
 * revise, then revert to the approved text and the old approval does not
 * come back. `session` is audit only and never matched, so a wfDir copied by
 * task-handoff keeps its approvals for unchanged documents.
 *
 * A leaf module (node builtins only): the document hash is computed by the
 * gate, which is the only reader.
 */

import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const APPROVALS_LOG = "approvals.log";

export interface ApprovalRecord {
  doc: string;
  hash: string;
  session: string;
  at: string;
}

export interface LatestApprovals {
  latest: Map<string, ApprovalRecord>;
  /** Lines that were not a valid version-1 record. */
  ignoredLines: number;
  /** Set when the log exists but cannot be read; the caller must treat every document as unapproved. */
  readError?: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One line, one write on an O_APPEND descriptor, so concurrent appends never
 * interleave mid-line. O_NOFOLLOW: a symlink planted at the ledger's name
 * makes the append fail instead of writing into whatever it points at.
 */
export function appendApproval(wfDir: string, record: ApprovalRecord): void {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_NOFOLLOW;
  const fd = openSync(join(wfDir, APPROVALS_LOG), flags, 0o644);
  try {
    writeSync(fd, `${JSON.stringify({ v: 1, ...record })}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * The last valid record per document. Lines that are not JSON, not version
 * 1, or miss a field are skipped and counted, so a diagnosis can say the
 * ledger had lines it did not understand (a newer writer, a hand edit)
 * instead of silently treating them as absent. A log that cannot be read
 * (a directory, EACCES, ELOOP) is reported, not thrown: an exception would
 * reach the guard's catch, which allows the call.
 */
export function readLatestApprovals(wfDir: string): LatestApprovals {
  const latest = new Map<string, ApprovalRecord>();
  let text: string;
  try {
    text = readFileSync(join(wfDir, APPROVALS_LOG), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { latest, ignoredLines: 0 };
    }
    return { latest, ignoredLines: 0, readError: code ?? String(error) };
  }
  let ignoredLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record === null) {
      ignoredLines++;
      continue;
    }
    latest.set(record.doc, record);
  }
  return { latest, ignoredLines };
}

function parseRecord(line: string): ApprovalRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, doc, hash, session, at } = value as Record<string, unknown>;
  if (v !== 1) return null;
  if (
    typeof doc !== "string" ||
    typeof session !== "string" ||
    typeof at !== "string"
  )
    return null;
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) return null;
  return { doc, hash, session, at };
}
