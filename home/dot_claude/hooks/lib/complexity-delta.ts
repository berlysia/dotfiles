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
    if (typeof cognitive !== "number" || !Number.isFinite(cognitive)) return false;
    const kind = typeof node.kind === "string" ? node.kind : "";
    const line =
      typeof node.line === "number" && Number.isInteger(node.line) ? node.line : null;
    const nextChain = [...chain, `${name}:${kind}`];
    const key = `${path} :: ${nextChain.join(" > ")}`;
    const metrics = byKey.get(key) ?? [];
    metrics.push({ path, name, line, cognitive });
    byKey.set(key, metrics);
    const children: unknown[] = Array.isArray(node.children) ? node.children : [];
    return children.every((child) => walk(path, child, nextChain, depth + 1));
  };

  for (const file of data.files as unknown[]) {
    if (!isRecord(file)) return null;
    if (typeof file.path !== "string" || !Array.isArray(file.functions)) return null;
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
