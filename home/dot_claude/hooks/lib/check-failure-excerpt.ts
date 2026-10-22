// lib/check-failure-excerpt.ts
//
// Pure extraction of the part of a failed test run that the completion gate
// shows the model. I/O-free so the gate's close handler can call it without a
// new way to throw; the caller still guards it.
//
// Input is the run's stdout and stderr as two strings. They are kept apart
// because runners split their output differently (vitest and bun print the
// failure to stderr and the passed-test lines to stdout) and the gate used to
// concatenate them before reading the end.

export type FailureExcerpt = {
  text: string;
  // "section": a failure section was found by its marker.
  // "tail": no marker matched; the text is the cleaned end of the output.
  source: "section" | "tail";
};

export type CheckOutput = { stdout: string; stderr: string };

// Why 500: a minified bundle in a test's output can be one multi-MiB line. The
// cap also bounds what any single line can add to the excerpt.
const MAX_LINE_CHARS = 500;
const SECTION_MAX_LINES = 60;
const RAW_TAIL_LINES = 20;
const SUMMARY_MAX_LINES = 8;
// How far above a stream's first "(fail)" line the error text can start, and
// how many lines before a section its counts can sit.
const BUN_LOOKBACK_LINES = 200;
const COUNTS_LOOKBEHIND_LINES = 10;
const COUNTS_TAIL_LINES = 8;
// A load failure's error text above the section is copied after its
// "'test failed'" line, at most this many lines, scanning at most this far.
const LOAD_ERROR_MAX_LINES = 30;
const LOAD_ERROR_SCAN_LINES = 200;

// Only CSI sequences (colors, cursor, erase). Test runners emit nothing else
// that matters here, and a wider pattern risks backtracking on hostile input.
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// All patterns are anchored at the line start (or a literal) with no nested
// quantifiers, so one line costs time linear in its length.
const NOISE_PATTERNS: readonly RegExp[] = [
  // Passed-test lines of vitest / node:test / bun.
  /^\s*(?:[✓✔√]|\(pass\) )/,
  // Frames inside node itself add nothing to a failure.
  /^\s*at .*node:(?:internal|async_hooks)/,
  /^\s*at async Promise\.all/,
  // pnpm's "the script failed" restatement, with or without turbo's prefix.
  /^.{0,200}?ELIFECYCLE\s+(?:Test|Command) failed/,
];

function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // A trailing newline is not a line; keeping it would put a blank line between
  // the two streams.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}…`
    : line;
}

/** ANSI removed, long lines cut, one array entry per line. */
function prepareLines(text: string): string[] {
  return splitLines(stripAnsi(text)).map(capLine);
}

function dropNoise(lines: readonly string[]): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    if (isNoise(line)) continue;
    // Consecutive blank lines are one: dropping the passed-test lines between
    // two blanks would otherwise leave a run of them.
    if (
      line.trim() === "" &&
      kept.length > 0 &&
      kept[kept.length - 1]!.trim() === ""
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept;
}

// Markers come in two strengths. A strong marker is printed once by the runner
// and starts the whole failure report: node:test's "✖ failing tests:" and
// vitest's "⎯⎯ Failed Tests N ⎯⎯" banner. A weak marker is printed per failure
// ("FAIL" in vitest, "(fail)" in bun) and so can also be produced by a test's
// own console output. Strong markers are searched first, in both streams, so a
// console.error shaped like "FAIL ..." cannot pull the excerpt away from the
// real report.
const STRONG_MARKERS: readonly RegExp[] = [
  /^✖ failing tests:/,
  /^\s*⎯+ Failed Tests? \d+ ⎯+/,
];
const WEAK_MARKERS: readonly RegExp[] = [/^\s*FAIL /, /^\(fail\) /];
const BUN_FAIL = /^\(fail\) /;
// bun prints a failure's error text before its "(fail)" line, so the section
// starts after the previous result line or the file heading.
const BUN_BOUNDARY =
  /^\((?:pass|fail|skip|todo)\) |^\S.*\.(?:test|spec)\.[cm]?[jt]sx?:$/;

const COUNT_PATTERNS: readonly RegExp[] = [
  /\b\d+\s+(?:passed|failed|pass|fail)\b/,
  /^\s*Tests?\s/,
  /^ℹ (?:tests|pass|fail) \d+/,
];

function isCountLine(line: string): boolean {
  return COUNT_PATTERNS.some((pattern) => pattern.test(line));
}

function findFirst(
  lines: readonly string[],
  patterns: readonly RegExp[],
): number {
  return lines.findIndex((line) =>
    patterns.some((pattern) => pattern.test(line)),
  );
}

/** Index of the first line of the failure section in one stream, or -1. */
function findSectionStart(
  lines: readonly string[],
  patterns: readonly RegExp[],
  walkBackForBun: boolean,
): number {
  const found = findFirst(lines, patterns);
  if (found < 0 || !walkBackForBun || !BUN_FAIL.test(lines[found]!)) {
    return found;
  }
  let start = found;
  const floor = Math.max(0, found - BUN_LOOKBACK_LINES);
  while (start > floor && !BUN_BOUNDARY.test(lines[start - 1]!)) start--;
  return start;
}

// turbo prints "Failed:    <pkg>#<task>" in its own summary.
const TURBO_FAILED = /^\s*Failed:\s+(\S+)#(\S+)/;

type TurboSelection = {
  streams: readonly (readonly string[])[];
  failedLines: readonly string[];
};

/**
 * turbo interleaves every package's output, each line prefixed with
 * "<pkg>:<task>: ". With exactly one failed package its lines are selected and
 * unprefixed, so the runner's markers (anchored at the line start) match
 * again. With several, which prefix belongs to which failure is unknown, so
 * the lines stay as they are and mostly end up in the tail.
 */
function selectTurboFailure(
  streams: readonly (readonly string[])[],
): TurboSelection {
  const failedLines = streams.flat().filter((line) => TURBO_FAILED.test(line));
  if (failedLines.length !== 1) return { streams, failedLines };
  const [, pkg, task] = TURBO_FAILED.exec(failedLines[0]!)!;
  const prefix = `${pkg}:${task}: `;
  // turbo may trim the trailing space of an otherwise empty line.
  const bare = prefix.trimEnd();
  const selected = streams.map((lines) =>
    lines
      .filter((line) => line.startsWith(prefix) || line === bare)
      .map((line) => line.slice(prefix.length)),
  );
  if (selected.every((lines) => lines.length === 0)) {
    return { streams, failedLines };
  }
  return { streams: selected, failedLines };
}

const LOAD_ERROR_TEST_AT = /^test at (.+):1:1$/;
const NODE_TOP_LEVEL_RESULT = /^✖ (\S+) \(/;
const NODE_RESULT_LINE = /^[✖✔▶ℹ] /;

type TopLevelFailure = { index: number; previousResult: number };

/** Last top-level "✖ <file> (" line above the section per file, in one pass. */
function indexTopLevelFailures(
  lines: readonly string[],
  end: number,
): Map<string, TopLevelFailure> {
  const byFile = new Map<string, TopLevelFailure>();
  let previousResult = -1;
  for (let i = 0; i < end; i++) {
    const line = lines[i]!;
    const file = NODE_TOP_LEVEL_RESULT.exec(line)?.[1];
    if (file !== undefined) byFile.set(file, { index: i, previousResult });
    if (NODE_RESULT_LINE.test(line)) previousResult = i;
  }
  return byFile;
}

/**
 * node:test reports a test file that failed to load (ERR_MODULE_NOT_FOUND,
 * a syntax error) as `✖ <file>` / `'test failed'` in its failure section; the
 * cause was printed earlier, between the previous result line and the file's
 * top-level `✖ <file> (` line. The cause is copied next to the report.
 * Searching is done through an index built once, so a run with thousands of
 * such files stays linear.
 */
function sectionWithLoadErrors(section: Section): string[] {
  const { lines, start } = section;
  const out: string[] = [];
  let topLevel: Map<string, TopLevelFailure> | null = null;
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]!);
    if (i - 2 < start || lines[i]!.trim() !== "'test failed'") continue;
    const file = LOAD_ERROR_TEST_AT.exec(lines[i - 2]!)?.[1];
    if (file === undefined || !lines[i - 1]!.startsWith(`✖ ${file} (`))
      continue;
    topLevel ??= indexTopLevelFailures(lines, start);
    const found = topLevel.get(file);
    if (found === undefined) continue;
    const from = found.previousResult + 1;
    const cause = trimBlankEdges(
      dropNoise(
        lines.slice(from, Math.min(found.index, from + LOAD_ERROR_SCAN_LINES)),
      ),
    );
    out.push(...cause.slice(0, LOAD_ERROR_MAX_LINES));
  }
  return out;
}

type Section = { lines: readonly string[]; start: number };

/**
 * Streams are searched one by one, never after concatenation: vitest prints
 * the report to stderr and hundreds of passed-test lines to stdout, which
 * would follow the report in a concatenation and push the failures out of any
 * window.
 */
function findSection(streams: readonly (readonly string[])[]): Section | null {
  for (const [patterns, walkBack] of [
    [STRONG_MARKERS, false],
    [WEAK_MARKERS, true],
  ] as const) {
    for (const lines of streams) {
      const start = findSectionStart(lines, patterns, walkBack);
      if (start >= 0) return { lines, start };
    }
  }
  return null;
}

function trimBlankEdges(lines: string[]): string[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first]!.trim() === "") first++;
  while (last > first && lines[last - 1]!.trim() === "") last--;
  return lines.slice(first, last);
}

function lastLines<T>(lines: readonly T[], count: number): T[] {
  return lines.slice(Math.max(0, lines.length - count));
}

/** Count lines near the section and at the end of the whole output, not already shown. */
function collectCountLines(
  streams: readonly (readonly string[])[],
  section: Section | null,
  shown: ReadonlySet<string>,
): string[] {
  const candidates: string[] = [];
  if (section !== null) {
    const from = Math.max(0, section.start - COUNTS_LOOKBEHIND_LINES);
    candidates.push(...section.lines.slice(from, section.start));
  }
  const cleanedAll = dropNoise(streams.flat()).filter(
    (line) => line.trim() !== "",
  );
  candidates.push(...lastLines(cleanedAll, COUNTS_TAIL_LINES));

  const picked: string[] = [];
  const seen = new Set(shown);
  for (const line of candidates) {
    if (picked.length >= SUMMARY_MAX_LINES) break;
    const key = line.trim();
    if (!isCountLine(line) || seen.has(key)) continue;
    seen.add(key);
    picked.push(line);
  }
  return picked;
}

function renderSection(section: Section): string[] {
  const cleaned = trimBlankEdges(dropNoise(sectionWithLoadErrors(section)));
  if (cleaned.length <= SECTION_MAX_LINES) return cleaned;
  return [
    ...cleaned.slice(0, SECTION_MAX_LINES),
    `... ${cleaned.length - SECTION_MAX_LINES} more lines omitted`,
  ];
}

export function extractFailureExcerpt(output: CheckOutput): FailureExcerpt {
  const raw = [prepareLines(output.stderr), prepareLines(output.stdout)];
  const all = raw.flat();
  const { streams, failedLines } = selectTurboFailure(raw);

  const section = findSection(streams);
  let body = section === null ? [] : renderSection(section);
  const source: FailureExcerpt["source"] = body.length > 0 ? "section" : "tail";
  if (source === "tail") {
    body = lastLines(
      trimBlankEdges(dropNoise(streams.flat())),
      SECTION_MAX_LINES,
    );
  }

  const counts = collectCountLines(
    streams,
    source === "section" ? section : null,
    new Set(body.map((line) => line.trim())),
  );
  const shown = new Set([...body, ...counts].map((line) => line.trim()));
  const failed: string[] = [];
  for (const line of failedLines) {
    if (shown.has(line.trim())) continue;
    shown.add(line.trim());
    failed.push(line);
  }

  const text = [...body, ...counts, ...failed].join("\n");
  if (text.trim() !== "" || all.every((line) => line.trim() === "")) {
    return { text, source };
  }
  // Everything was noise. An empty reason tells the model nothing, so show the
  // raw end instead.
  return { text: lastLines(all, RAW_TAIL_LINES).join("\n"), source: "tail" };
}
