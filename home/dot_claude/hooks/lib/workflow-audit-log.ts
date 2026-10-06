#!/usr/bin/env -S bun run --silent

/**
 * Append-only audit trail shared by `document-workflow-guard.ts` (off-plan
 * write relaxation, spec K7) and `workflow-bash-sync.ts` (tripwire, spec K2).
 * Both hooks record the same class of event -- "a write happened that a plan
 * did not account for" -- to the same file, so the appender lives once here
 * (implementations -> lib) rather than being duplicated or imported
 * implementation-to-implementation.
 */

import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";

/**
 * Append a single-line audit entry to `<wfDir>/off-plan-writes.log` recording
 * a write to a file not accounted for by the active plan (guard: not listed
 * in any plan-N.md Files section; tripwire: a gate-closed repo change).
 *
 * Format: ISO8601 \t tool=<name> \t path=<JSON-encoded rel-or-abs>
 *
 * The path is JSON-encoded (not sanitizeForDisplay'd) because this log is
 * meant to be read back and folded into a plan-N.md Files section, which
 * requires round-tripping the exact path. sanitizeForDisplay's redaction is
 * irreversible and would break that round trip; JSON.stringify is reversible
 * and still neutralizes control characters / embedded quotes for the log's
 * tab-separated format.
 *
 * `O_NOFOLLOW` on the open call refuses to append through a symlinked log
 * file (plan-2 T4): a symlink swapped in at this path could otherwise
 * redirect the audit trail to overwrite an arbitrary file the appending
 * process can write. Best-effort throughout: log write failures must not
 * interfere with the user's tool call.
 */
/**
 * A target string still containing an unexpanded shell token (`$VAR`,
 * `${VAR}`) is not a real path — the guard extracted it verbatim from the
 * command text and the shell never got to substitute it. Recording it as if
 * it were `path=` would mislead someone folding this log back into a
 * plan-N.md Files section (spec K9a). `raw-token:` marks it explicitly
 * instead.
 */
const UNEXPANDED_TOKEN_REGEX = /\$/;

/** One `write` on an O_APPEND | O_NOFOLLOW descriptor. Best-effort: false when it could not be written. */
function appendAuditLine(
  wfDir: string,
  fileName: string,
  line: string,
): boolean {
  try {
    const fd = openSync(
      resolve(wfDir, fileName),
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function appendOffPlanLog(
  wfDir: string,
  toolName: string,
  target: string,
): void {
  const pathField = UNEXPANDED_TOKEN_REGEX.test(target)
    ? `raw-token:${JSON.stringify(target)}`
    : JSON.stringify(target);
  appendAuditLine(
    wfDir,
    "off-plan-writes.log",
    `${new Date().toISOString()}\ttool=${toolName}\tpath=${pathField}\n`,
  );
}

export const DELEGATION_USES_LOG = "delegation-uses.log";
/** How the user takes a delegation back; kept on every line so it is found where the use is. */
const DELEGATION_REVOKE =
  "set the `- Approval Status:` line of spec.md back to pending";

export interface DelegationUse {
  planName: string;
  planHash: string;
  specHash: string;
}

export interface DelegationUseRecord {
  /** This plan version had not been recorded under this spec version. */
  first: boolean;
  /** The line is in the log (already there, or just written). */
  written: boolean;
}

/**
 * Append one line under `key` unless a line with that key is already there.
 * A log that cannot be read counts as "not recorded": a repeated notice is
 * the lesser failure, and `written` lets the caller say the record could not
 * be kept.
 */
function recordOnce(wfDir: string, key: string): DelegationUseRecord {
  try {
    const fd = openSync(
      resolve(wfDir, DELEGATION_USES_LOG),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      if (readFileSync(fd, "utf-8").includes(key)) {
        return { first: false, written: true };
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Missing or unreadable: record and report.
  }
  const written = appendAuditLine(
    wfDir,
    DELEGATION_USES_LOG,
    `${new Date().toISOString()}${key}revoke=${JSON.stringify(DELEGATION_REVOKE)}\n`,
  );
  return { first: true, written };
}

/**
 * Record that a write cleared by the spec's delegation, once per plan-N.md
 * version under a spec.md version.
 */
export function recordDelegationUse(
  wfDir: string,
  use: DelegationUse,
): DelegationUseRecord {
  return recordOnce(
    wfDir,
    `\tplan=${JSON.stringify(use.planName)}\tplan-hash=${use.planHash}\tspec-hash=${use.specHash}\t`,
  );
}

export interface DelegatedOffPlanWrite {
  /** The write target as an absolute path, so the key does not depend on the tool's cwd. */
  target: string;
  specHash: string;
}

/**
 * Record a write that no plan-N.md lists and that was let through while only
 * delegated plans were in effect, once per target under a spec.md version.
 */
export function recordDelegatedOffPlanWrite(
  wfDir: string,
  write: DelegatedOffPlanWrite,
): DelegationUseRecord {
  return recordOnce(
    wfDir,
    `\toff-plan=${JSON.stringify(write.target)}\tspec-hash=${write.specHash}\t`,
  );
}
