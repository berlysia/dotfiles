import { recordInjections } from "../core/metrics-log.ts";
import type { RecordKind } from "../core/metrics.ts";

// Claude の 2 つの入口（開始時と場面）が共有する薄い関数。
// 行の形と書き込みは core にあり（Codex の入口も使う）、ここは委譲だけ
export function recordClaudeInjections(
  store: string,
  record: {
    at: Date;
    repoKey: string;
    kind: RecordKind;
    items: ReadonlyArray<{ id: string; trigger: string }>;
  },
): boolean {
  try {
    return recordInjections(store, record);
  } catch {
    return false;
  }
}
