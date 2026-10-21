#!/usr/bin/env node --test

import { deepEqual, ok } from "node:assert";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import {
  checkAdrHeadings,
  checkSessionPaths,
  checkAdrLineRefs,
  checkSourceLineRefs,
  checkMissingPaths,
  createPathExists,
  isPathCheckTarget,
  checkExceptionSet,
} from "../support/doc-structure-checks.ts";
import { fileURLToPath } from "node:url";

// Structural checks for the docs in this repo (spec K9):
//   (a) ADR headings are the fixed set, and Status / Context / Decision exist
//   (b) ADRs do not point into `.tmp/sessions/` (GC'd after 7 days)
//   (c) nothing points into an ADR by line number
//   (d) repo-relative paths written in backticks exist in the tracked tree
//   (e) ADRs do not point into source files by line number
//
// Each check is a pure function (path + text -> violations). Reading files and
// `git ls-files` stay at the edge so the checks can be unit-tested in memory.
//
// A line number goes stale at the next edit of the target. The checks therefore
// forbid it; the target is named by ID, section or symbol instead.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Repository-wide application
// ---------------------------------------------------------------------------

// Every ADR meets these checks, so the sets are empty. An entry is a known
// violation allowed until it is fixed; a listed file that no longer violates, or
// does not exist, fails the test so the sets only shrink. Names are file names
// under docs/decisions/.
const ADR_HEADING_EXCEPTIONS: ReadonlySet<string> = new Set<string>([]);
const ADR_SESSION_PATH_EXCEPTIONS: ReadonlySet<string> = new Set<string>([]);
const ADR_MISSING_PATH_EXCEPTIONS: ReadonlySet<string> = new Set<string>([]);
const ADR_SOURCE_LINE_REF_EXCEPTIONS: ReadonlySet<string> = new Set<string>([]);

function listTrackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter((path) => path.length > 0);
}

/**
 * Text of a tracked regular file, or undefined when it is not readable text:
 * symlinks (tracked ones point at directories), files deleted in the working
 * tree, and binary files (NUL byte).
 */
function readTrackedText(path: string): string | undefined {
  const fullPath = join(repoRoot, path);
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const buffer = readFileSync(fullPath);
  if (buffer.includes(0)) return undefined;
  return buffer.toString("utf-8");
}

const tracked = listTrackedFiles();
const adrPaths = tracked.filter(
  (path) =>
    /^docs\/decisions\/[^/]+\.md$/.test(path) && !path.endsWith("/README.md"),
);
const adrNames = new Set(adrPaths.map((path) => posix.basename(path)));

function adrFilesViolating(
  check: (path: string, text: string) => string[],
): Set<string> {
  const files = new Set<string>();
  for (const path of adrPaths) {
    const text = readTrackedText(path);
    if (text === undefined) continue;
    if (check(path, text).length > 0) files.add(posix.basename(path));
  }
  return files;
}

function assertAdrExceptions(
  exceptions: ReadonlySet<string>,
  check: (path: string, text: string) => string[],
): void {
  ok(adrPaths.length > 0, "expected to find ADRs");
  const problems = checkExceptionSet(
    exceptions,
    adrFilesViolating(check),
    adrNames,
  );
  deepEqual(problems, []);
}

test("(a) ADR headings are the fixed set (exceptions must shrink)", () => {
  assertAdrExceptions(ADR_HEADING_EXCEPTIONS, (_path, text) =>
    checkAdrHeadings(text),
  );
});

test("(b) ADRs do not reference .tmp/sessions/ (exceptions must shrink)", () => {
  assertAdrExceptions(ADR_SESSION_PATH_EXCEPTIONS, (_path, text) =>
    checkSessionPaths(text),
  );
});

test("(c) no tracked text file references an ADR by line number", () => {
  const hits: string[] = [];
  for (const path of tracked) {
    const text = readTrackedText(path);
    if (text === undefined) continue;
    for (const violation of checkAdrLineRefs(text)) {
      hits.push(`${path}: ${violation}`);
    }
  }
  deepEqual(hits, []);
});

test("(d) ADRs reference existing paths (exceptions must shrink)", () => {
  const exists = createPathExists(tracked);
  assertAdrExceptions(ADR_MISSING_PATH_EXCEPTIONS, (path, text) =>
    checkMissingPaths(path, text, exists),
  );
});

test("(d) docs other than ADRs reference only existing paths (no exceptions)", () => {
  const exists = createPathExists(tracked);
  const hits: string[] = [];
  for (const path of tracked) {
    if (!isPathCheckTarget(path) || path.startsWith("docs/decisions/"))
      continue;
    const text = readTrackedText(path);
    if (text === undefined) continue;
    for (const violation of checkMissingPaths(path, text, exists)) {
      hits.push(`${path}: ${violation}`);
    }
  }
  deepEqual(hits, []);
});

test("(e) ADRs do not reference source files by line number (exceptions must shrink)", () => {
  assertAdrExceptions(ADR_SOURCE_LINE_REF_EXCEPTIONS, (_path, text) =>
    checkSourceLineRefs(text),
  );
});
