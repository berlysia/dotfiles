/**
 * Pure aggregation over `hook-timing.jsonl` records written by
 * `hook-timer.sh` (see hooks/README.md "Hook telemetry" and plan T3). No I/O
 * here: reading the log file and printing the report are the CLI's job
 * (`cli/hook-timing.ts`), following the same "pure functions + deps at the
 * edge" split as `cli/workflow.ts`.
 */

export type HookTimingRecord = {
  ts: string;
  start_ms: number | null;
  duration_ms: number | null;
  event: string;
  async: boolean;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number | null;
  command: string;
  session_id: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  // Absent in rows written before these keys existed.
  source?: string | null;
  prompt_id?: string | null;
  terminated: string | null;
};

const IMPLEMENTATIONS_PATTERN = /implementations\/([^/\s]+)\.ts/;
const INLINE_LABEL_PREFIX_LENGTH = 40;
const FIRING_WINDOW_MS = 1000;

/**
 * Parse one `hook-timing.jsonl` file's content. Blank lines are silently
 * skipped (the trailing newline every appender leaves behind is not a
 * malformed record); every other line that fails `JSON.parse` or does not
 * decode to an object counts toward `invalidLines`.
 */
export function parseHookTimingLines(text: string): {
  records: HookTimingRecord[];
  invalidLines: number;
} {
  const records: HookTimingRecord[] = [];
  let invalidLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") {
        records.push(parsed as HookTimingRecord);
      } else {
        invalidLines++;
      }
    } catch {
      invalidLines++;
    }
  }
  return { records, invalidLines };
}

/**
 * K8: a command that runs `implementations/<name>.ts` is labelled `<name>`;
 * anything else (inline shell, `echo`, `jq | sed`, ...) is labelled by its
 * own first 40 characters, so the label is a deterministic function of the
 * command string alone.
 */
export function labelForCommand(command: string): string {
  const match = command.match(IMPLEMENTATIONS_PATTERN);
  const captured = match?.[1];
  if (captured !== undefined) return captured;
  return `inline:${command.slice(0, INLINE_LABEL_PREFIX_LENGTH)}`;
}

/** Nearest-rank percentile: `sorted[ceil(p/100*n)-1]`. `sorted` must be non-empty and ascending. */
function nearestRankPercentile(sorted: number[], p: number): number {
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("nearestRankPercentile: empty input");
  }
  return value;
}

function summarizeDurations(durationsAscending: number[]): {
  p50: number;
  p95: number;
  max: number;
  totalMs: number;
} {
  const max = durationsAscending[durationsAscending.length - 1];
  if (max === undefined) {
    throw new Error("summarizeDurations: empty input");
  }
  return {
    p50: nearestRankPercentile(durationsAscending, 50),
    p95: nearestRankPercentile(durationsAscending, 95),
    max,
    totalMs: durationsAscending.reduce((sum, d) => sum + d, 0),
  };
}

export type HookStats = {
  label: string;
  event: string;
  async: boolean;
  count: number;
  terminatedCount: number;
  p50: number;
  p95: number;
  max: number;
  totalMs: number;
  maxStderrBytes: number;
};

/**
 * Per-hook stats, grouped by (label, event, async). Records with
 * `duration_ms === null` (the timer could not measure, e.g. a signal arrived
 * before `now_ms` could run) are excluded entirely -- they carry no duration
 * to summarize. Sorted by `totalMs` descending, the hooks costing the most
 * cumulative wall-clock time first.
 */
export function summarizeByHook(records: HookTimingRecord[]): HookStats[] {
  type Group = {
    records: HookTimingRecord[];
    event: string;
    async: boolean;
    label: string;
  };
  const groups = new Map<string, Group>();

  for (const record of records) {
    if (typeof record.duration_ms !== "number") continue;
    const label = labelForCommand(record.command);
    const key = `${label}\u0000${record.event}\u0000${record.async}`;
    const group = groups.get(key);
    if (group) {
      group.records.push(record);
    } else {
      groups.set(key, {
        records: [record],
        event: record.event,
        async: record.async,
        label,
      });
    }
  }

  const stats: HookStats[] = [];
  for (const group of groups.values()) {
    const durations = group.records
      .map((r) => r.duration_ms as number)
      .sort((a, b) => a - b);
    const { p50, p95, max, totalMs } = summarizeDurations(durations);
    const terminatedCount = group.records.filter(
      (r) => r.terminated !== null,
    ).length;
    const stderrValues = group.records
      .map((r) => r.stderr_bytes)
      .filter((v): v is number => typeof v === "number");
    const maxStderrBytes =
      stderrValues.length > 0 ? Math.max(...stderrValues) : 0;

    stats.push({
      label: group.label,
      event: group.event,
      async: group.async,
      count: group.records.length,
      terminatedCount,
      p50,
      p95,
      max,
      totalMs,
      maxStderrBytes,
    });
  }

  return stats.sort((a, b) => b.totalMs - a.totalMs);
}

export type EventBlockingStats = {
  event: string;
  invocations: number;
  p50: number;
  p95: number;
  max: number;
  topBottleneck: { label: string; share: number } | null;
};

type Firing = { event: string; maxDuration: number; bottleneckLabel: string };

/** The bottleneck within one firing: the largest duration, ties broken by label ascending. */
function firingFromGroup(records: HookTimingRecord[]): Firing {
  let maxDuration = -Infinity;
  let bottleneckLabel = "";
  for (const record of records) {
    const duration = record.duration_ms as number;
    const label = labelForCommand(record.command);
    if (
      duration > maxDuration ||
      (duration === maxDuration && label < bottleneckLabel)
    ) {
      maxDuration = duration;
      bottleneckLabel = label;
    }
  }
  const first = records[0];
  if (first === undefined) {
    throw new Error("firingFromGroup: empty group");
  }
  return { event: first.event, maxDuration, bottleneckLabel };
}

/**
 * K7: group sync records into "firings" (one Claude Code hook dispatch).
 * With a `tool_use_id`, the firing is `(session_id, event, tool_use_id)`.
 * Without one (SessionStart, Stop, UserPromptSubmit, ...), records in the
 * same `(session_id, event)` are grouped by a 1000ms window measured from
 * the group's first `start_ms` (not a sliding window from the previous
 * record) -- see plan K7 for why 1000ms.
 */
function computeFirings(records: HookTimingRecord[]): Firing[] {
  const syncRecords = records.filter(
    (r) => r.async === false && typeof r.duration_ms === "number",
  );

  const withToolUseId = new Map<string, HookTimingRecord[]>();
  const withoutToolUseId = new Map<string, HookTimingRecord[]>();

  for (const record of syncRecords) {
    if (record.tool_use_id) {
      const key = `${record.session_id ?? ""}\u0000${record.event}\u0000${record.tool_use_id}`;
      const list = withToolUseId.get(key);
      if (list) list.push(record);
      else withToolUseId.set(key, [record]);
    } else {
      const key = `${record.session_id ?? ""}\u0000${record.event}`;
      const list = withoutToolUseId.get(key);
      if (list) list.push(record);
      else withoutToolUseId.set(key, [record]);
    }
  }

  const firings: Firing[] = [];
  for (const group of withToolUseId.values()) {
    firings.push(firingFromGroup(group));
  }
  for (const group of withoutToolUseId.values()) {
    const sorted = [...group].sort(
      (a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0),
    );
    let windowHeadStart: number | null = null;
    let window: HookTimingRecord[] = [];
    for (const record of sorted) {
      const start = record.start_ms ?? 0;
      if (
        windowHeadStart === null ||
        start - windowHeadStart > FIRING_WINDOW_MS
      ) {
        if (window.length > 0) firings.push(firingFromGroup(window));
        window = [record];
        windowHeadStart = start;
      } else {
        window.push(record);
      }
    }
    if (window.length > 0) firings.push(firingFromGroup(window));
  }
  return firings;
}

/**
 * Per-event blocking-time stats: the wall-clock time a tool call actually
 * waited on hooks, per firing, is the max duration among that firing's sync
 * records (K7) -- parallel hooks don't sum. `topBottleneck` is the label most
 * often responsible for that max, ties broken by label ascending.
 */
export function summarizeBlocking(
  records: HookTimingRecord[],
): EventBlockingStats[] {
  const firings = computeFirings(records);

  const byEvent = new Map<string, Firing[]>();
  for (const firing of firings) {
    const list = byEvent.get(firing.event);
    if (list) list.push(firing);
    else byEvent.set(firing.event, [firing]);
  }

  const result: EventBlockingStats[] = [];
  for (const [event, eventFirings] of byEvent) {
    const durations = eventFirings
      .map((f) => f.maxDuration)
      .sort((a, b) => a - b);
    const { p50, p95, max } = summarizeDurations(durations);

    const bottleneckCounts = new Map<string, number>();
    for (const firing of eventFirings) {
      bottleneckCounts.set(
        firing.bottleneckLabel,
        (bottleneckCounts.get(firing.bottleneckLabel) ?? 0) + 1,
      );
    }
    const rankedBottlenecks = [...bottleneckCounts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const topRanked = rankedBottlenecks[0];
    const topBottleneck =
      topRanked !== undefined
        ? { label: topRanked[0], share: topRanked[1] / eventFirings.length }
        : null;

    result.push({
      event,
      invocations: eventFirings.length,
      p50,
      p95,
      max,
      topBottleneck,
    });
  }

  return result.sort((a, b) => a.event.localeCompare(b.event));
}

function padRight(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

/**
 * Render both tables as plain text. Callers that also want to surface the
 * count of `duration_ms === null` records (excluded from both tables above)
 * append that separately -- this function only sees the already-filtered
 * per-hook and per-event summaries, not the raw record list.
 */
export function formatReport(
  byHook: HookStats[],
  blocking: EventBlockingStats[],
): string {
  const lines: string[] = [];

  lines.push("Per-hook timing (sorted by total ms):");
  if (byHook.length === 0) {
    lines.push("  (no records)");
  } else {
    const header = [
      padRight("label", 28),
      padRight("event", 16),
      padRight("async", 6),
      padRight("count", 6),
      padRight("term", 5),
      padRight("p50", 6),
      padRight("p95", 6),
      padRight("max", 6),
      padRight("total", 8),
      "maxStderr",
    ].join(" ");
    lines.push(`  ${header}`);
    for (const h of byHook) {
      lines.push(
        `  ${[
          padRight(h.label, 28),
          padRight(h.event, 16),
          padRight(String(h.async), 6),
          padRight(String(h.count), 6),
          padRight(String(h.terminatedCount), 5),
          padRight(String(h.p50), 6),
          padRight(String(h.p95), 6),
          padRight(String(h.max), 6),
          padRight(String(h.totalMs), 8),
          String(h.maxStderrBytes),
        ].join(" ")}`,
      );
    }
  }

  lines.push("");
  lines.push("Blocking time by event (max of parallel sync hooks per firing):");
  if (blocking.length === 0) {
    lines.push("  (no records)");
  } else {
    const header = [
      padRight("event", 16),
      padRight("invocations", 12),
      padRight("p50", 6),
      padRight("p95", 6),
      padRight("max", 6),
      "top bottleneck",
    ].join(" ");
    lines.push(`  ${header}`);
    for (const b of blocking) {
      const bottleneck = b.topBottleneck
        ? `${b.topBottleneck.label} (${Math.round(b.topBottleneck.share * 100)}%)`
        : "-";
      lines.push(
        `  ${[
          padRight(b.event, 16),
          padRight(String(b.invocations), 12),
          padRight(String(b.p50), 6),
          padRight(String(b.p95), 6),
          padRight(String(b.max), 6),
          bottleneck,
        ].join(" ")}`,
      );
    }
  }

  return lines.join("\n");
}
