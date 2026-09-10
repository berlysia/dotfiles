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

export function appendOffPlanLog(
  wfDir: string,
  toolName: string,
  target: string,
): void {
  try {
    const logPath = resolve(wfDir, "off-plan-writes.log");
    const pathField = UNEXPANDED_TOKEN_REGEX.test(target)
      ? `raw-token:${JSON.stringify(target)}`
      : JSON.stringify(target);
    const entry = `${new Date().toISOString()}\ttool=${toolName}\tpath=${pathField}\n`;
    const fd = openSync(
      logPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, entry);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort; do not block the tool call on logging errors
  }
}
