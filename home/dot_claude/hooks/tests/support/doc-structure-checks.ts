// Shared by unit/doc-structure.test.ts and heavy/doc-structure.test.ts.
// Pure checks (path + text -> violations) only: reading tracked files and
// `git ls-files` stay in the heavy file.
import { posix } from "node:path";

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

export const ALLOWED_HEADINGS: readonly string[] = [
  "Status",
  "Context",
  "Decision",
  "却下した代替案",
  "Consequences",
  "Amendments",
  "References",
];
export const REQUIRED_HEADINGS: readonly string[] = [
  "Status",
  "Context",
  "Decision",
];

export const FENCE_LINE = /^\s*(```|~~~)/;

/** Lines outside code fences, with their 1-based line numbers. */
export function linesOutsideFences(
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
export function checkAdrHeadings(text: string): string[] {
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
export function checkSessionPaths(text: string): string[] {
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
export const LINE_SUFFIX = "(?::|#L)[0-9]+";
export const ADR_FILE_LINE_REF = new RegExp(
  `[0-9]{4}-[a-z0-9-]+\\.md${LINE_SUFFIX}`,
  "g",
);
export const SOURCE_LINE_REF = new RegExp(
  `\\.(?:ts|mjs|js|sh|tmpl|toml|yaml|yml)${LINE_SUFFIX}`,
  "g",
);

export function checkPattern(
  text: string,
  pattern: RegExp,
  label: string,
): string[] {
  const violations: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      violations.push(`line ${index + 1}: ${label}: ${match[0]}`);
    }
  });
  return violations;
}

/** (c) Line-number reference to an ADR file. Applies to every tracked text file. */
export function checkAdrLineRefs(text: string): string[] {
  return checkPattern(text, ADR_FILE_LINE_REF, "ADR line reference");
}

/** (e) Line-number reference to a source file. Applies to ADRs. */
export function checkSourceLineRefs(text: string): string[] {
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
export const PATH_PREFIXES: readonly string[] = [
  "docs/",
  "home/",
  ".skills/",
  "mods/",
  "scripts/",
  "tests/",
];
export const SKIP_CHARS = /[*?<>{}…]/;

export function isPathCheckTarget(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (path.startsWith("docs/decisions/")) return true;
  if (path.startsWith("docs/plans/")) return false;
  if (path === "CONTEXT.md") return true;
  if (/(^|\/)[^/]*README[^/]*\.md$/.test(path)) return true;
  return path.startsWith("docs/");
}

export function extractBacktickTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const { line } of linesOutsideFences(text)) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      tokens.push((match[1] ?? "").trim());
    }
  }
  return tokens;
}

export type PathExists = (candidate: string) => boolean;

export function createPathExists(tracked: readonly string[]): PathExists {
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
export function checkMissingPaths(
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
export function checkExceptionSet(
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
