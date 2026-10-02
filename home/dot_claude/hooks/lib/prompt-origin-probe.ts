/**
 * Measurement probe for issue J: does the transcript row of the current
 * prompt already say who produced it (`promptSource` / `turnOrigin`) at the
 * moment approval-recorder runs? The result is one line appended to the
 * recorder's reply. It never throws, never prints the prompt text or the
 * prompt id, and prints only fixed words or values matching a strict pattern.
 * The transcript format is undocumented, so an observation holds only for the
 * Claude Code version it was measured on.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";

const TAIL_WINDOW_BYTES = 1024 * 1024;
const FULL_READ_LIMIT_BYTES = 64 * 1024 * 1024;
const SAFE_VALUE = /^[a-z_-]{1,32}$/;

type Origin = { promptSource: string; turnOrigin: string };

function sanitizeValue(value: unknown): string {
  if (typeof value !== "string") return "none";
  return SAFE_VALUE.test(value) ? value : "other";
}

/** The last row of this prompt that carries the typed text, or null. */
function findOrigin(text: string, promptId: string): Origin | null {
  let found: Origin | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes(promptId)) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (typeof row !== "object" || row === null) continue;
      const record = row as Record<string, unknown>;
      const message = record.message as
        | { content?: unknown }
        | null
        | undefined;
      if (
        record.type === "user" &&
        record.promptId === promptId &&
        typeof message?.content === "string"
      ) {
        found = {
          promptSource: sanitizeValue(record.promptSource),
          turnOrigin: sanitizeValue(record.turnOrigin),
        };
      }
    } catch {
      // a broken or partial line is skipped on its own
    }
  }
  return found;
}

function readRange(fd: number, start: number, length: number): string {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const n = readSync(fd, buffer, filled, length - filled, start + filled);
    if (n === 0) break;
    filled += n;
  }
  return buffer.subarray(0, filled).toString("utf-8");
}

function format(
  source: string | undefined,
  promptId: string | undefined,
  transcript: string,
  scope: string,
  bytes: string,
): string {
  return `probe: source=${source ?? "none"} prompt_id=${promptId ? "present" : "none"} transcript=${transcript} scope=${scope} bytes=${bytes}`;
}

export function probePromptOrigin(args: {
  transcriptPath: string | undefined;
  promptId: string | undefined;
  source: string | undefined;
}): string {
  const { transcriptPath, promptId, source } = args;
  const unreadable = format(source, promptId, "unreadable", "n/a", "n/a");
  if (!promptId) return format(source, promptId, "n/a", "n/a", "n/a");
  if (!transcriptPath || !isAbsolute(transcriptPath)) return unreadable;
  let fd: number | undefined;
  try {
    if (!lstatSync(transcriptPath).isFile()) return unreadable;
    fd = openSync(
      transcriptPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) return unreadable;
    const size = stat.size;
    const describe = (origin: Origin) =>
      `found(promptSource=${origin.promptSource},turnOrigin=${origin.turnOrigin})`;

    const windowStart = Math.max(0, size - TAIL_WINDOW_BYTES);
    let tail = readRange(fd, windowStart, size - windowStart);
    if (windowStart > 0) {
      // the window starts mid-line; drop the partial first line
      const newline = tail.indexOf("\n");
      tail = newline === -1 ? "" : tail.slice(newline + 1);
    }
    const inTail = findOrigin(tail, promptId);
    if (inTail)
      return format(source, promptId, describe(inTail), "tail", String(size));

    if (size > FULL_READ_LIMIT_BYTES) {
      return format(source, promptId, "missing", "tail", String(size));
    }
    const whole = windowStart === 0 ? tail : readRange(fd, 0, size);
    const inFile = findOrigin(whole, promptId);
    return format(
      source,
      promptId,
      inFile ? describe(inFile) : "missing",
      "file",
      String(size),
    );
  } catch {
    return unreadable;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to recover
      }
    }
  }
}
