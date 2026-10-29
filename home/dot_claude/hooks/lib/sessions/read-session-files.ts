import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Reads the raw text of ~/.claude/sessions/<pid>.json files and nothing else.
 * The directory is writable by every process of the same user, so every limit
 * here exists to keep one hostile or runaway entry from stalling or flooding
 * the CLI. Parsing and validation belong to validate-session.ts.
 */

export const MAX_FILES = 1024;
export const MAX_FILE_BYTES = 65536;

const NAME_PATTERN = /^[0-9]+\.json$/;

export type SessionFileStat = {
  isFile(): boolean;
  size: number;
  uid: number;
};

// Synchronous on purpose: at most 1024 small reads, and sync deps keep the
// close-exactly-once bookkeeping free of interleaving.
export type ReadSessionFilesDeps = {
  readdir(dir: string): string[];
  open(path: string, flags: number): number;
  fstat(fd: number): SessionFileStat;
  read(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  close(fd: number): void;
  getuid(): number;
};

export type SessionFile = { name: string; pid: number; text: string };

export type ReadSessionFilesResult =
  | {
      ok: true;
      value: {
        files: SessionFile[];
        scanned: number;
        skippedBeforeContent: number;
      };
    }
  | {
      ok: false;
      error: { kind: "sessions-dir-unreadable"; message: string };
    };

export const defaultDeps: ReadSessionFilesDeps = {
  readdir: (dir) => readdirSync(dir),
  open: (path, flags) => openSync(path, flags),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length) =>
    readSync(fd, buffer, offset, length, null),
  close: (fd) => closeSync(fd),
  getuid: () => {
    if (typeof process.getuid !== "function") {
      // No uid to compare against (non-POSIX): -1 never matches, so nothing is read.
      return -1;
    }
    return process.getuid();
  },
};

// O_NOFOLLOW: a symlink in the directory must not redirect the read.
// O_NONBLOCK: open(2) on a FIFO with no writer would otherwise block forever.
const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function digitsOf(name: string): string {
  return name.slice(0, -".json".length);
}

// Compares as numbers without converting, so a 30-digit name cannot lose
// precision and reorder. Ties (001 vs 1) fall back to the full name.
function compareNames(a: string, b: string): number {
  const da = digitsOf(a).replace(/^0+(?=.)/, "");
  const db = digitsOf(b).replace(/^0+(?=.)/, "");
  if (da.length !== db.length) return da.length - db.length;
  if (da !== db) return da < db ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

type ReadOutcome = { kind: "text"; text: string } | { kind: "skip" };

function readOne(
  path: string,
  deps: ReadSessionFilesDeps,
  uid: number,
  buffer: Buffer,
): ReadOutcome {
  let fd: number;
  try {
    fd = deps.open(path, OPEN_FLAGS);
  } catch {
    return { kind: "skip" };
  }
  try {
    // fstat on the opened fd, not stat on the path: the path may be swapped
    // between a check and the open.
    const st = deps.fstat(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES || st.uid !== uid) {
      return { kind: "skip" };
    }
    // One byte over the limit: reaching it proves the file grew while we read.
    const limit = MAX_FILE_BYTES + 1;
    let total = 0;
    while (total < limit) {
      const n = deps.read(fd, buffer, total, limit - total);
      if (n <= 0) break;
      total += n;
    }
    if (total > MAX_FILE_BYTES) return { kind: "skip" };
    return {
      kind: "text",
      text: Buffer.from(buffer.subarray(0, total)).toString("utf8"),
    };
  } catch {
    return { kind: "skip" };
  } finally {
    try {
      deps.close(fd);
    } catch {
      // Nothing useful to do; the fd is gone either way.
    }
  }
}

export function readSessionFiles(
  dir: string,
  deps: ReadSessionFilesDeps = defaultDeps,
): ReadSessionFilesResult {
  let names: string[];
  try {
    names = deps.readdir(dir);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "sessions-dir-unreadable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // The name filter runs before any open or stat, so .key files and
  // anything else in the directory are never touched.
  const candidates = names
    .filter((name) => NAME_PATTERN.test(name))
    .sort(compareNames);
  const uid = deps.getuid();
  // One scratch buffer for all files (reads are sequential). allocUnsafe: only
  // buffer[0..total) is ever read, so zero-filling 64 KiB buys nothing.
  const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  const files: SessionFile[] = [];
  let skippedBeforeContent = 0;

  candidates.forEach((name, index) => {
    if (index >= MAX_FILES) {
      skippedBeforeContent += 1;
      return;
    }
    const outcome = readOne(join(dir, name), deps, uid, buffer);
    if (outcome.kind === "skip") {
      skippedBeforeContent += 1;
      return;
    }
    files.push({ name, pid: Number(digitsOf(name)), text: outcome.text });
  });

  return {
    ok: true,
    value: { files, scanned: candidates.length, skippedBeforeContent },
  };
}
