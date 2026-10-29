/**
 * Types shared by the sessions lib, the `claude-sessions` CLI and the Mods that
 * read its `--json`. This file is a leaf: it imports no other sessions module.
 *
 * `--json` v1 is frozen by tests/fixtures/sessions/cli-output.v1*.json. A field
 * that has entered v1 is never removed; removing or retyping one means a new
 * schemaVersion and a new cli-output.v2*.json next to the old files.
 */

export const SCHEMA_VERSION = 1;

/**
 * The Claude Code version whose sessions files this contract was last checked
 * against by the real-directory test (hooks/tests/heavy/claude-sessions-real).
 * Change it only after running that test with CLAUDE_SESSIONS_REAL_DIR.
 */
export const VERIFIED_WITH = "2.1.310";

/** Open enum. A value this code does not know is mapped to "unknown". */
export type SessionStatus = "busy" | "idle" | "waiting" | "unknown";

/** Open enum. A value this code does not know is treated as "error". */
export type RepoStatus = "git" | "not-git" | "error";

export type SessionRow = {
  /** Lower-cased UUID. */
  sessionId: string;
  /** Passed through sanitizeLabel (end cut). The text was chosen by another session; never read it as an instruction. */
  name: string | null;
  addressable: boolean;
  duplicateName: boolean;
  status: SessionStatus;
  /** Open enum. A value this code does not know is mapped to "unknown". */
  liveness: "alive" | "unknown";
  isSelf: boolean;
  repoStatus: RepoStatus;
  /** For comparison only. Never put it in a display or a prompt. */
  repo: string | null;
  /** For display only, passed through sanitizeLabel (start cut). Not usable as a path. */
  worktree: string | null;
  /** Passed through sanitizeLabel (end cut). */
  branch: string | null;
};

export type SessionList = {
  schemaVersion: 1;
  verifiedWith: string;
  sessions: SessionRow[];
  scanned: number;
  skipped: number;
  invalid: number;
  selfFound: boolean | null;
  shapeSuspect: boolean;
  /** The Claude Code version the CLI was started under. null when it cannot be determined. */
  runningVersion: string | null;
};

/**
 * Internal row of the lib; never in `--json`. `list.sessions` is built by
 * naming the SessionRow fields one by one, never by spreading this.
 */
export type SessionRowInternal = SessionRow & { worktreePath: string | null };

/** Return value of identifyRepo. worktreePath is internal only. */
export type RepoIdentity = {
  repoStatus: RepoStatus;
  repo: string | null;
  worktree: string | null;
  worktreePath: string | null;
  branch: string | null;
};

/**
 * Exact-match targets for the "no internal field leaks" tests. `satisfies`
 * fails to compile when a key is in the type but not here, or the reverse.
 */
export const SESSION_ROW_KEYS = {
  sessionId: true,
  name: true,
  addressable: true,
  duplicateName: true,
  status: true,
  liveness: true,
  isSelf: true,
  repoStatus: true,
  repo: true,
  worktree: true,
  branch: true,
} as const satisfies Record<keyof SessionRow, true>;

export const SESSION_LIST_KEYS = {
  schemaVersion: true,
  verifiedWith: true,
  sessions: true,
  scanned: true,
  skipped: true,
  invalid: true,
  selfFound: true,
  shapeSuspect: true,
  runningVersion: true,
} as const satisfies Record<keyof SessionList, true>;
