// Upper bound only (plan-3 T5, provisional): p95 of getLearningsHealthNotice <= 100 ms.
// SessionStart calls it every time. If this fails, do not loosen the bound: report the
// numbers and revisit spec K13 (drop the metrics from SessionStart, or lower the log limit).
import { ok } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, describe, it } from "node:test";
import { getLearningsHealthNotice } from "../../lib/agent-learnings/claude/health.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import {
  formatFeedbackLine,
  formatInjectionLine,
} from "../../lib/agent-learnings/core/metrics.ts";
import {
  initStore,
  LOG_HARD_MAX_BYTES,
  LOG_MAX_BYTES,
  storePaths,
} from "../../lib/agent-learnings/core/store.ts";

const RUNS = 20;
const P95_LIMIT_MS = 100;
const NOW = new Date("2026-10-22T00:00:00.000Z");
const at = new Date(NOW.getTime() - 3_600_000).toISOString();

const injectionLine = formatInjectionLine({
  v: 1,
  at,
  repoKey: "github.com/a/b",
  id: "L-000000000001",
  kind: "pre",
  trigger: "cmd:git commit",
});
const feedbackLine = formatFeedbackLine({
  v: 1,
  at,
  reader: "claude",
  repoKey: "github.com/a/b",
  id: "L-000000000001",
  verdict: "mistimed",
  kind: "pre",
  trigger: "cmd:git commit",
});
const fill = (line: string, bytes: number): string =>
  line.repeat(Math.ceil(bytes / Buffer.byteLength(line)));

const states: Array<{ name: string; content: (line: string) => string }> = [
  {
    name: "1MB of minimal valid lines",
    content: (l) => fill(l, LOG_MAX_BYTES),
  },
  {
    name: "one 1MB line",
    content: () => `${"x".repeat(LOG_MAX_BYTES - 1)}\n`,
  },
  {
    name: "4MB (only the last 1MB is read)",
    content: (l) => fill(l, LOG_HARD_MAX_BYTES),
  },
];

const root = mkdtempSync(join(tmpdir(), "al-health-perf-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("getLearningsHealthNotice latency", () => {
  for (const state of states) {
    it(`p95 over ${RUNS} calls with all three logs at ${state.name} is <= ${P95_LIMIT_MS} ms`, () => {
      const store = join(root, state.name.replace(/\W+/g, "-"));
      ok(initStore(store, runGit).ok);
      const paths = storePaths(store);
      writeFileSync(paths.injectionsLog, state.content(injectionLine));
      writeFileSync(paths.feedbackLog, state.content(feedbackLine));
      writeFileSync(paths.codexFeedbackLog, state.content(feedbackLine));
      const samples: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        getLearningsHealthNotice({ store, now: NOW, runGit });
        samples.push(performance.now() - start);
      }
      // SessionStart は毎回新しいプロセスなので、初回が実態に近い。判定には使わない
      const first = samples[0] ?? Infinity;
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
      console.error(
        `health [${state.name}]: first=${first.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${sorted.at(-1)?.toFixed(1)}ms (n=${samples.length})`,
      );
      ok(p95 <= P95_LIMIT_MS, `p95 ${p95.toFixed(1)}ms > ${P95_LIMIT_MS}ms`);
    });
  }
});
