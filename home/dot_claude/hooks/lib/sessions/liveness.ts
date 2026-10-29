export type Liveness = "alive" | "dead" | "unknown";

/** Reads /proc/<pid>/stat. Throws with a `code` (ENOENT, ESRCH, ...) on failure. */
export type ReadStat = (pid: number) => string;

// Tokens after the last ")" start at field 3 (state), so field 22 (starttime) is the 20th.
const START_TIME_INDEX = 19;

// Compares the start time as well as the pid so a recycled pid reads as dead.
export function liveness(
  pid: number,
  procStart: string,
  readStat: ReadStat,
): Liveness {
  let line: string;
  try {
    line = readStat(pid);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ESRCH" ? "dead" : "unknown";
  }
  // comm may itself contain ")" or spaces, so anchor on the last ")".
  const close = line.lastIndexOf(")");
  if (close === -1) return "unknown";
  const tokens = line
    .slice(close + 1)
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.length < START_TIME_INDEX + 1) return "unknown";
  return tokens[START_TIME_INDEX] === procStart ? "alive" : "dead";
}
