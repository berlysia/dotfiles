import { createHash } from "node:crypto";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { sanitizeForDisplay } from "./sanitize-display.ts";

// Thresholds come from replaying 150 commits of this repository's hooks; run
// git show 52dc6fd447:docs/plans/complexity-delta/research.md before changing them.
const COGNITIVE_THRESHOLD = 25;
const MIN_RISE = 5;
const MAX_NOTICE_LINES = 10;
const MAX_NESTING_DEPTH = 64;

type FunctionMetric = {
  path: string;
  name: string;
  line: number | null;
  cognitive: number;
};

/** One measurement of a tree. Keys are `<path> :: <parent chain of name:kind>`. */
export type Report = {
  byKey: Map<string, FunctionMetric[]>;
  parseErrorFiles: string[];
};

/** What survives between the prompt and the stop: values only, no line numbers. */
export type Baseline = {
  functions: Record<string, number[]>;
  parseErrorFiles: string[];
};

export type Finding = {
  path: string;
  name: string;
  line: number | null;
  before: number | null;
  after: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/**
 * Validates cccc's JSON and flattens it. Returns null for any input outside the
 * contract instead of throwing: the tool is updated by Renovate, and a shape
 * change must turn into a logged skip, not an exception in every project.
 */
export function parseCcccOutput(raw: string): Report | null {
  // A tree with no supported source files makes cccc exit 0 with nothing on
  // stdout ("no matching files found" goes to stderr). That is a measurement
  // of zero functions, not a contract change.
  if (raw.trim() === "") return { byKey: new Map(), parseErrorFiles: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || !Array.isArray(data.files)) return null;

  const byKey = new Map<string, FunctionMetric[]>();
  const parseErrorFiles = new Set<string>();

  const walk = (
    path: string,
    node: unknown,
    chain: readonly string[],
    depth: number,
  ): boolean => {
    if (depth > MAX_NESTING_DEPTH || !isRecord(node)) return false;
    const { name, cognitive } = node;
    if (typeof name !== "string") return false;
    if (typeof cognitive !== "number" || !Number.isFinite(cognitive))
      return false;
    const kind = typeof node.kind === "string" ? node.kind : "";
    const line =
      typeof node.line === "number" && Number.isInteger(node.line)
        ? node.line
        : null;
    const nextChain = [...chain, `${name}:${kind}`];
    const key = `${path} :: ${nextChain.join(" > ")}`;
    const metrics = byKey.get(key) ?? [];
    metrics.push({ path, name, line, cognitive });
    byKey.set(key, metrics);
    const children: unknown[] = Array.isArray(node.children)
      ? node.children
      : [];
    return children.every((child) => walk(path, child, nextChain, depth + 1));
  };

  for (const file of data.files as unknown[]) {
    if (!isRecord(file)) return null;
    if (typeof file.path !== "string" || !Array.isArray(file.functions))
      return null;
    const path = normalizePath(file.path);
    if (Array.isArray(file.parse_errors) && file.parse_errors.length > 0) {
      parseErrorFiles.add(path);
    }
    for (const node of file.functions as unknown[]) {
      if (!walk(path, node, [], 1)) return null;
    }
  }

  const { summary } = data;
  if (isRecord(summary) && Array.isArray(summary.parse_error_files)) {
    for (const path of summary.parse_error_files as unknown[]) {
      if (typeof path === "string") parseErrorFiles.add(normalizePath(path));
    }
  }

  return { byKey, parseErrorFiles: [...parseErrorFiles].sort() };
}

export function toBaseline(report: Report): Baseline {
  return {
    functions: Object.fromEntries(
      [...report.byKey].map(([key, metrics]) => [
        key,
        metrics.map((metric) => metric.cognitive),
      ]),
    ),
    parseErrorFiles: report.parseErrorFiles,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Findings for one key. Equal values are cancelled first so that an untouched
 * function never pairs with a changed one; what remains is paired by rank.
 */
function diffKey(
  before: readonly number[],
  current: readonly FunctionMetric[],
): Finding[] {
  const remainingBefore = [...before];
  const changed: FunctionMetric[] = [];
  for (const metric of current) {
    const index = remainingBefore.indexOf(metric.cognitive);
    if (index === -1) {
      changed.push(metric);
    } else {
      remainingBefore.splice(index, 1);
    }
  }
  remainingBefore.sort((a, b) => b - a);
  changed.sort(
    (a, b) => b.cognitive - a.cognitive || (a.line ?? 0) - (b.line ?? 0),
  );

  const findings: Finding[] = [];
  changed.forEach((metric, rank) => {
    const paired = remainingBefore[rank] ?? null;
    if (metric.cognitive < COGNITIVE_THRESHOLD) return;
    if (paired !== null && metric.cognitive - paired < MIN_RISE) return;
    findings.push({
      path: metric.path,
      name: metric.name,
      line: metric.line,
      before: paired,
      after: metric.cognitive,
    });
  });
  return findings;
}

export function diffReports(baseline: Baseline, current: Report): Finding[] {
  const skipped = new Set([
    ...baseline.parseErrorFiles,
    ...current.parseErrorFiles,
  ]);
  const findings: Finding[] = [];
  for (const [key, metrics] of current.byKey) {
    const compared = metrics.filter((metric) => !skipped.has(metric.path));
    if (compared.length === 0) continue;
    findings.push(...diffKey(baseline.functions[key] ?? [], compared));
  }
  const rise = (finding: Finding) => finding.after - (finding.before ?? 0);
  return findings.sort(
    (a, b) =>
      rise(b) - rise(a) ||
      compareText(a.path, b.path) ||
      compareText(a.name, b.name) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

const NOTICE_HEADER = `[complexity-delta] Cognitive complexity rose this turn (>= ${COGNITIVE_THRESHOLD}, new or +${MIN_RISE}):`;

/** The findings that get a line of their own; the rest are only counted. */
export function shownFindings(findings: readonly Finding[]): Finding[] {
  return findings.slice(0, MAX_NOTICE_LINES);
}

/** The text shown in the UI. Paths and names come from the opened repository. */
export function formatNotice(findings: readonly Finding[]): string {
  const lines = shownFindings(findings).map((finding) => {
    const path = sanitizeForDisplay(finding.path);
    const where = finding.line === null ? path : `${path}:${finding.line}`;
    const change =
      finding.before === null
        ? `new ${finding.after}`
        : `${finding.before} → ${finding.after}`;
    return `  ${where} ${sanitizeForDisplay(finding.name)} ${change}`;
  });
  const rest = findings.length - lines.length;
  if (rest > 0) lines.push(`  ... and ${rest} more`);
  return [NOTICE_HEADER, ...lines].join("\n");
}

export function hashNotice(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `<entry>/cccc` for every absolute PATH entry. Relative and empty entries resolve against the opened repository, so they are dropped. */
export function listCcccCandidates(pathEnv: string | undefined): string[] {
  if (!pathEnv) return [];
  return pathEnv
    .split(delimiter)
    .filter((entry) => entry !== "" && isAbsolute(entry))
    .map((entry) => join(entry, "cccc"));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * `realPath` is the resolved candidate. A mise shim resolves to the mise binary,
 * which may install tools declared by the opened repository; a binary inside the
 * repository is the repository's own.
 */
export function isUsableCccc(
  realPath: string,
  excludedRoots: readonly string[],
): boolean {
  if (basename(realPath) === "mise") return false;
  return !excludedRoots.some((root) => isInside(root, realPath));
}
