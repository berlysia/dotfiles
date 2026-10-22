// lib/session-id.ts
//
// Session ids become file names (markers, scene state), so every user checks
// this one pattern before touching the filesystem. `.` is excluded on purpose:
// it keeps `..` and extension-looking suffixes out of the name.

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}
