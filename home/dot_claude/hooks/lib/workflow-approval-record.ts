/**
 * The steps that turn a verified approval into a recorded one: append to the
 * ledger, rewrite the Approval line, then read the gate back. Shared by the
 * recorders so every route ends in the same state and the gate, which reads
 * only approvals.log, never learns which route was used.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { appendApproval } from "./workflow-approval.ts";
import { evaluateDocument } from "./workflow-gate.ts";
import { setApprovalStatusLine } from "./workflow-marker.ts";

/**
 * Rewrite the Approval line so a crash never leaves a truncated document:
 * write a uniquely named temp file opened with O_EXCL (it cannot follow a
 * planted symlink or reuse an existing name), keep the document's mode,
 * then rename over the document. A symlinked document is left alone: the
 * hook must not write outside the workflow dir. Returns whether the line
 * was rewritten (false when it already said approved or is missing).
 */
export function setApprovalLineApproved(path: string): boolean {
  const stat = lstatSync(path);
  if (!stat.isFile()) return false;
  const content = readFileSync(path, "utf-8");
  const updated = setApprovalStatusLine(content, "approved");
  if (updated === null || updated === content) return false;
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.approval-tmp`;
  const fd = openSync(temp, "wx", stat.mode & 0o777);
  try {
    try {
      writeFileSync(fd, updated);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true }); // any failure after the temp exists leaves nothing behind
    } catch {
      // keep the original error; a leftover temp is named *.approval-tmp and harmless
    }
    throw error;
  }
  return true;
}

export type RecordState = "recorded" | "loggedOnly" | "failed";

export interface RecordResult {
  doc: string;
  state: RecordState;
  hash: string;
  /** Machine-readable note on how the state came about. */
  detail?: string;
}

/**
 * Record one document and say what state it ended in. Never throws: each
 * document is its own step, so a failure on one still reports the others.
 * `loggedOnly` means the ledger line was written but the Approval line is
 * not approved yet, so the gate still waits.
 */
export function recordOne(
  wfDir: string,
  doc: string,
  hash: string,
  session: string,
  at: string,
): RecordResult {
  const path = resolve(wfDir, doc);
  let logged = false;
  try {
    appendApproval(wfDir, { doc, hash, session, at });
    logged = true;
    if (!lstatSync(path).isFile()) {
      return { doc, state: "loggedOnly", hash, detail: "not-regular-file" };
    }
    const rewritten = setApprovalLineApproved(path);
    const c = evaluateDocument(path).conditions;
    if (c.approvalRecord.ok && c.approvalStatus.ok) {
      return {
        doc,
        state: "recorded",
        hash,
        detail: rewritten ? "rewritten" : "already-approved",
      };
    }
    return {
      doc,
      state: c.approvalRecord.ok ? "loggedOnly" : "failed",
      hash,
      detail: `conditions:log=${c.approvalRecord.ok ? "ok" : "no"},line=${c.approvalStatus.ok ? "ok" : "no"}`,
    };
  } catch (error) {
    return {
      doc,
      state: logged ? "loggedOnly" : "failed",
      hash,
      detail: `error:${String(error).slice(0, 120)}`,
    };
  }
}
