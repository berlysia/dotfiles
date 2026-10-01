/** Verbs that remove or truncate a file's contents. The home guard keeps its own list; destructive-verbs-drift.test.ts keeps them in sync. */
export const DELETE_VERBS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
]);
export const MOVE_VERBS: ReadonlySet<string> = new Set(["mv"]);
export const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);
