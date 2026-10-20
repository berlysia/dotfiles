#!/usr/bin/env node --test

import { deepEqual, equal, ok } from "node:assert";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
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
// Pure checks
// ---------------------------------------------------------------------------

const ALLOWED_HEADINGS: readonly string[] = [
  "Status",
  "Context",
  "Decision",
  "却下した代替案",
  "Consequences",
  "Amendments",
  "References",
];
const REQUIRED_HEADINGS: readonly string[] = ["Status", "Context", "Decision"];

const FENCE_LINE = /^\s*(```|~~~)/;

/** Lines outside code fences, with their 1-based line numbers. */
function linesOutsideFences(
  text: string,
): ReadonlyArray<{ line: string; lineNumber: number }> {
  const result: Array<{ line: string; lineNumber: number }> = [];
  let inFence = false;
  text.split("\n").forEach((line, index) => {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) result.push({ line, lineNumber: index + 1 });
  });
  return result;
}

/** (a) Headings must match the allowed set exactly (no prefix or case match). */
function checkAdrHeadings(text: string): string[] {
  const violations: string[] = [];
  const found = new Set<string>();
  for (const { line, lineNumber } of linesOutsideFences(text)) {
    const match = /^## (.*?)\s*$/.exec(line);
    if (!match) continue;
    const heading = match[1] ?? "";
    found.add(heading);
    if (!ALLOWED_HEADINGS.includes(heading)) {
      violations.push(`line ${lineNumber}: heading not allowed: ## ${heading}`);
    }
  }
  for (const required of REQUIRED_HEADINGS) {
    if (!found.has(required))
      violations.push(`missing heading: ## ${required}`);
  }
  return violations;
}

/** (b) `.tmp/sessions/` is a session scratch path, GC'd after 7 days. */
function checkSessionPaths(text: string): string[] {
  const violations: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.includes(".tmp/sessions/")) {
      violations.push(`line ${index + 1}: references .tmp/sessions/`);
    }
  });
  return violations;
}

// Built from parts so this file never contains an ADR file name followed by a
// line number, which check (c) would flag in this very file.
const LINE_SUFFIX = "(?::|#L)[0-9]+";
const ADR_FILE_LINE_REF = new RegExp(
  `[0-9]{4}-[a-z0-9-]+\\.md${LINE_SUFFIX}`,
  "g",
);
const SOURCE_LINE_REF = new RegExp(
  `\\.(?:ts|mjs|js|sh|tmpl|toml|yaml|yml)${LINE_SUFFIX}`,
  "g",
);

function checkPattern(text: string, pattern: RegExp, label: string): string[] {
  const violations: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      violations.push(`line ${index + 1}: ${label}: ${match[0]}`);
    }
  });
  return violations;
}

/** (c) Line-number reference to an ADR file. Applies to every tracked text file. */
function checkAdrLineRefs(text: string): string[] {
  return checkPattern(text, ADR_FILE_LINE_REF, "ADR line reference");
}

/** (e) Line-number reference to a source file. Applies to ADRs. */
function checkSourceLineRefs(text: string): string[] {
  return checkPattern(text, SOURCE_LINE_REF, "source line reference");
}

// (d) Path existence.
//
// Targets: docs/decisions/*.md (with an exception list), the .md files under
// docs/ other than ADRs and docs/plans/, root CONTEXT.md, and tracked
// *README*.md. docs/plans/ is excluded because plans name files that do not
// exist yet.
//
// Tokens: text in backticks outside code fences that starts with one of
// PATH_PREFIXES. Tokens containing `* ? < > { } …` or whitespace are skipped:
// they are globs, placeholders, elisions or commands, not one concrete path.
// Everything from the first `#` or `:` on is dropped (anchors, line numbers).
//
// Resolution: a path counts as present when the tracked set has it as a file,
// or as a directory (trailing `/` or any tracked path under it). It is tried
// relative to the repo root and relative to the directory of the doc that
// wrote it, because a README writes paths relative to its own package or
// directory (`tests/foo/run.sh` inside `tests/README.md`'s neighbour).
const PATH_PREFIXES: readonly string[] = [
  "docs/",
  "home/",
  ".skills/",
  "mods/",
  "scripts/",
  "tests/",
];
const SKIP_CHARS = /[*?<>{}…]/;

function isPathCheckTarget(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (path.startsWith("docs/decisions/")) return true;
  if (path.startsWith("docs/plans/")) return false;
  if (path === "CONTEXT.md") return true;
  if (/(^|\/)[^/]*README[^/]*\.md$/.test(path)) return true;
  return path.startsWith("docs/");
}

function extractBacktickTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const { line } of linesOutsideFences(text)) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      tokens.push((match[1] ?? "").trim());
    }
  }
  return tokens;
}

type PathExists = (candidate: string) => boolean;

function createPathExists(tracked: readonly string[]): PathExists {
  const trackedSet = new Set(tracked);
  return (candidate) => {
    const normalized = posix.normalize(candidate);
    if (normalized.endsWith("/")) {
      return tracked.some((path) => path.startsWith(normalized));
    }
    if (trackedSet.has(normalized)) return true;
    const asDirectory = `${normalized}/`;
    return tracked.some((path) => path.startsWith(asDirectory));
  };
}

/** (d) Backtick paths in `docPath`'s text that resolve to nothing. */
function checkMissingPaths(
  docPath: string,
  text: string,
  exists: PathExists,
): string[] {
  const violations: string[] = [];
  const docDir = posix.dirname(docPath);
  for (const raw of extractBacktickTokens(text)) {
    if (!PATH_PREFIXES.some((prefix) => raw.startsWith(prefix))) continue;
    if (SKIP_CHARS.test(raw) || /\s/.test(raw)) continue;
    const token = raw.replace(/[#:].*$/, "");
    if (!token) continue;
    if (exists(token) || exists(posix.join(docDir, token))) continue;
    violations.push(`missing path: ${raw}`);
  }
  return violations;
}

/**
 * Compares the files that violate a check with its exception set. A file in the
 * set that no longer violates, or that does not exist, is a problem: the set
 * must shrink as ADRs are fixed.
 */
function checkExceptionSet(
  exceptions: ReadonlySet<string>,
  violatingFiles: ReadonlySet<string>,
  existingFiles: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const file of [...violatingFiles].sort()) {
    if (!exceptions.has(file)) problems.push(`unexpected violation: ${file}`);
  }
  for (const file of [...exceptions].sort()) {
    if (!existingFiles.has(file)) {
      problems.push(`exception names a file that does not exist: ${file}`);
    } else if (!violatingFiles.has(file)) {
      problems.push(`exception no longer violates, remove it: ${file}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Unit tests (in-memory inputs)
// ---------------------------------------------------------------------------

test("(a) Status, Context and Decision only: no violation", () => {
  deepEqual(checkAdrHeadings("## Status\n\n## Context\n\n## Decision\n"), []);
});

test("(a) missing Status is reported", () => {
  const violations = checkAdrHeadings("## Context\n\n## Decision\n");
  deepEqual(violations, ["missing heading: ## Status"]);
});

test("(a) a heading inside a code fence is ignored", () => {
  const text = [
    "## Status",
    "## Context",
    "## Decision",
    "```md",
    "## Foo",
    "```",
    "~~~",
    "## Bar",
    "~~~",
  ].join("\n");
  deepEqual(checkAdrHeadings(text), []);
});

test("(a) a heading that is not an exact match is a violation", () => {
  const violations = checkAdrHeadings(
    "## Status\n## Context\n## Decision\n## Rejected alternatives\n",
  );
  equal(violations.length, 1);
  ok(violations[0]?.includes("## Rejected alternatives"));
});

test("(a) the other allowed headings are accepted; ### is not a heading here", () => {
  const text = [
    "## Status",
    "## Context",
    "## Decision",
    "## 却下した代替案",
    "## Consequences",
    "## Amendments",
    "## References",
    "### Anything",
  ].join("\n");
  deepEqual(checkAdrHeadings(text), []);
});

test("(b) .tmp/sessions/ is reported with its line", () => {
  deepEqual(checkSessionPaths("a\nsee .tmp/sessions/abcd1234/spec.md\n"), [
    "line 2: references .tmp/sessions/",
  ]);
  deepEqual(checkSessionPaths("see .tmp/docs/CONTEXT.md\n"), []);
});

test("(c) an ADR file name followed by a line suffix is a violation", () => {
  const adr = "0029-workflow-records-move-into-adr.md";
  equal(checkAdrLineRefs(`see ${adr}${"#L"}12`).length, 1);
  equal(checkAdrLineRefs(`see ${adr}${":"}12-14`).length, 1);
  deepEqual(checkAdrLineRefs(`see ${adr} and ${adr}#section`), []);
  deepEqual(checkAdrLineRefs("see foo.md:12"), []);
});

test("(e) source file line references are violations; markdown ones are not", () => {
  const violations = checkSourceLineRefs(
    "a foo.ts:12 and bar.yml#L3 and foo.md:12",
  );
  equal(violations.length, 2);
  deepEqual(checkSourceLineRefs("run foo.ts or bar.yml"), []);
});

test("(d) only the missing concrete path is reported", () => {
  const exists = createPathExists(["docs/real.md", "tests/other/run.sh"]);
  const text = [
    "`docs/no-such.md`",
    "`docs/*.md`",
    "`tests/<name>/run.sh`",
    "`docs/real.md#anchor`",
    "`docs/ with space.md`",
    "```",
    "`docs/in-fence.md`",
    "```",
  ].join("\n");
  deepEqual(checkMissingPaths("README.md", text, exists), [
    "missing path: docs/no-such.md",
  ]);
});

test("(d) a path is also resolved relative to the doc's own directory", () => {
  const exists = createPathExists([
    "tests/pkg/scripts/run.sh",
    "docs/dir/x.md",
  ]);
  deepEqual(
    checkMissingPaths("tests/pkg/README.md", "`scripts/run.sh`", exists),
    [],
  );
  // Not under PATH_PREFIXES, so never checked.
  deepEqual(checkMissingPaths("README.md", "`lib/none.ts`", exists), []);
  // A directory counts, with or without a trailing slash.
  deepEqual(
    checkMissingPaths("README.md", "`docs/dir/` `docs/dir`", exists),
    [],
  );
});

test("(d) target selection", () => {
  ok(isPathCheckTarget("docs/decisions/0001-x.md"));
  ok(isPathCheckTarget("docs/guide.md"));
  ok(isPathCheckTarget("CONTEXT.md"));
  ok(isPathCheckTarget("home/dot_claude/hooks/README.md"));
  ok(!isPathCheckTarget("docs/plans/x.md"));
  ok(!isPathCheckTarget("home/dot_claude/rules/workflow.md"));
  ok(!isPathCheckTarget("docs/data.json"));
});

test("exception set: an entry that no longer violates is reported", () => {
  const problems = checkExceptionSet(
    new Set(["a.md", "b.md"]),
    new Set(["a.md"]),
    new Set(["a.md", "b.md"]),
  );
  deepEqual(problems, ["exception no longer violates, remove it: b.md"]);
});

test("exception set: an entry naming a missing file is reported", () => {
  const problems = checkExceptionSet(
    new Set(["gone.md"]),
    new Set(),
    new Set(["a.md"]),
  );
  deepEqual(problems, ["exception names a file that does not exist: gone.md"]);
});

test("exception set: a violation outside the set is reported", () => {
  const problems = checkExceptionSet(
    new Set(),
    new Set(["new.md"]),
    new Set(["new.md"]),
  );
  deepEqual(problems, ["unexpected violation: new.md"]);
});

// ---------------------------------------------------------------------------
// Repository-wide application
// ---------------------------------------------------------------------------

// The ADR cleanup (plan-3) must empty these sets; each entry is a violation the
// cleanup has not fixed yet. Names are file names under docs/decisions/.
const ADR_HEADING_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
  "0033-claude-worktrees-under-git-dir.md",
  "0036-japanese-writing-skills-roles-and-entries.md",
  "0038-second-chezmoi-source-for-machine-local-files.md",
]);
const ADR_SESSION_PATH_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
  "0037-workflow-reset-archives-workflow-dir.md",
]);
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

test("(a) ADR headings are the fixed set (exceptions: ADRs not yet cleaned up)", () => {
  assertAdrExceptions(ADR_HEADING_EXCEPTIONS, (_path, text) =>
    checkAdrHeadings(text),
  );
});

test("(b) ADRs do not reference .tmp/sessions/ (exceptions: ADRs not yet cleaned up)", () => {
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

test("(d) ADRs reference existing paths (exceptions: ADRs not yet cleaned up)", () => {
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

test("(e) ADRs do not reference source files by line number (exceptions: ADRs not yet cleaned up)", () => {
  assertAdrExceptions(ADR_SOURCE_LINE_REF_EXCEPTIONS, (_path, text) =>
    checkSourceLineRefs(text),
  );
});
