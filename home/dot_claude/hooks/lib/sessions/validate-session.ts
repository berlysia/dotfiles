import type { SessionStatus } from "./types.ts";

export type ValidSession = {
  pid: number;
  procStart: string;
  sessionId: string;
  cwd: string;
  /** Raw, unsanitized. Null when absent or not a string. */
  name: string | null;
  status: SessionStatus;
};

// No reason is returned on failure: a reason would tend to carry a fragment of
// a file written by another process.
export type ValidateResult = { ok: true; value: ValidSession } | { ok: false };

const PROC_START = /^[0-9]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// NUL, C0, DEL, C1. Cut before the value reaches git.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const KNOWN_STATUS: ReadonlySet<string> = new Set(["busy", "idle", "waiting"]);

const FAIL: ValidateResult = { ok: false };

export function validateSession(text: string, filePid: number): ValidateResult {
  // Deeply nested input can make JSON.parse throw RangeError as well as SyntaxError.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return FAIL;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return FAIL;
  }
  const obj = parsed as Record<string, unknown>;

  const { pid, procStart, sessionId, cwd, name, status } = obj;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid !== filePid
  ) {
    return FAIL;
  }
  if (typeof procStart !== "string" || !PROC_START.test(procStart)) return FAIL;
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return FAIL;
  if (typeof cwd !== "string" || !cwd.startsWith("/") || CONTROL.test(cwd))
    return FAIL;
  if (typeof status !== "string") return FAIL;

  return {
    ok: true,
    value: {
      pid,
      procStart,
      sessionId: sessionId.toLowerCase(),
      cwd,
      name: typeof name === "string" ? name : null,
      status: KNOWN_STATUS.has(status) ? (status as SessionStatus) : "unknown",
    },
  };
}
