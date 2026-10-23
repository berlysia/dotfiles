// lib/session-marker.ts
//
// A small file-per-name marker store: "this happened for this session within
// the last N ms". Age is the file's mtime, so no content has to be parsed.
// A leaf that only imports isSafeSessionId and knows nothing about what a
// caller's marker means.

import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSafeSessionId } from "./session-id.ts";

export interface CreateMarkerOptions {
  dir: string;
  name: string;
  /** A marker older than this is replaced. null: it never expires. */
  maxAgeMs: number | null;
  /** Delete other markers in `dir` older than this while creating. Omitted: delete none. */
  sweepAfterMs?: number;
  content?: string;
  now?: Date;
}

function sweepOld(dir: string, olderThanMs: number, nowMs: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isSafeSessionId(name)) continue;
    try {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isFile() && nowMs - stat.mtimeMs > olderThanMs) {
        unlinkSync(path);
      }
    } catch {
      // A failed sweep must not change the result of the create.
    }
  }
}

/**
 * Removes a marker that has outlived `maxAgeMs`. The file is renamed away
 * first, then its age is checked again: a concurrent creator may have
 * replaced it between our stat and our rename, and deleting its fresh marker
 * would let two callers both believe they created one. A fresh file that was
 * taken by mistake is linked back (link refuses to overwrite).
 */
function removeIfStale(path: string, maxAgeMs: number, nowMs: number): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return true;
  }
  if (nowMs - stat.mtimeMs <= maxAgeMs) return false;
  const aside = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return true;
  }
  try {
    if (nowMs - lstatSync(aside).mtimeMs <= maxAgeMs) {
      try {
        linkSync(aside, path);
      } catch {
        // Someone else already holds the name; either way we lost.
      }
      return false;
    }
    return true;
  } catch {
    return true;
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * True only when this call created the marker. False when a marker within
 * its lifetime exists, when the name is unsafe, or when anything fails. Never throws.
 */
export function createMarker(options: CreateMarkerOptions): boolean {
  const { dir, name, maxAgeMs, sweepAfterMs, content = "" } = options;
  if (!isSafeSessionId(name)) return false;
  const nowMs = (options.now ?? new Date()).getTime();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (sweepAfterMs !== undefined) sweepOld(dir, sweepAfterMs, nowMs);
    const path = join(dir, name);
    if (maxAgeMs !== null && !removeIfStale(path, maxAgeMs, nowMs)) {
      return false;
    }
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The marker's content, or null when it is absent, unsafe or unreadable. */
export function readMarker(dir: string, name: string): string | null {
  if (!isSafeSessionId(name)) return null;
  try {
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return null;
  }
}

/** True when no marker is left afterwards, including when there was none. Never throws. */
export function removeMarker(dir: string, name: string): boolean {
  if (!isSafeSessionId(name)) return false;
  try {
    rmSync(join(dir, name), { force: true });
    return true;
  } catch {
    return false;
  }
}
