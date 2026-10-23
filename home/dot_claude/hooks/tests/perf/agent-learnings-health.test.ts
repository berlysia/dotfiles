// getLearningsHealthNotice runs on every SessionStart (ADR-0042 K13). This file gates
// only what a CI runner can measure about it:
// - reads stay capped at the last 1 MB of each log: the 4 MB state's p50 must stay
//   within 1.5x the 1 MB state's p50. Healthy runs are 0.8-1.1x; reading the whole
//   injections log alone gives about 2.0x, all three logs about 4x.
// - per-line cost does not jump: p95 <= 250 ms in every state. 250 ms is the largest
//   CI p95 seen for the 1 MB state (112.4 ms, n=5) times about 2.2, so this fails on a
//   per-line slowdown above about 2.2-2.9x depending on the runner (250 / 87-112 ms).
//   The ratio check cannot see such a slowdown: it slows both states alike.
//   The "one 1 MB line" state is far under this bound (5-7 ms locally) and only fails
//   on work quadratic in line length. MAX_LINE_LENGTH itself is covered by the unit
//   test of a JSON line over 2 KB; timing cannot see it, since "x" fails JSON.parse
//   at the first character either way.
// It does not gate SessionStart latency on the user's machine, nor slowdowns smaller
// than the bound above: node, a warm process and a CI runner do not stand for bun, a
// fresh process and that machine. Read that latency from
// ~/.claude/logs/hook-timing.jsonl with the `hook-timing` command.
import { ok } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
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
const P95_LIMIT_MS = 250;
const TAIL_RATIO_LIMIT = 1.5;
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

const MINIMAL = "1MB of minimal valid lines";
const ONE_LINE = "one 1MB line";
const HARD_MAX = "4MB (only the last 1MB is read)";

const states: Array<{ name: string; content: (line: string) => string }> = [
  { name: MINIMAL, content: (l) => fill(l, LOG_MAX_BYTES) },
  { name: ONE_LINE, content: () => `${"x".repeat(LOG_MAX_BYTES - 1)}\n` },
  { name: HARD_MAX, content: (l) => fill(l, LOG_HARD_MAX_BYTES) },
];

type Timing = { p50: number; p95: number };

const root = mkdtempSync(join(tmpdir(), "al-health-perf-"));
after(() => rmSync(root, { recursive: true, force: true }));

function measure(name: string, content: (line: string) => string): Timing {
  const store = join(root, name.replace(/\W+/g, "-"));
  ok(initStore(store, runGit).ok, `initStore failed for ${name}`);
  const paths = storePaths(store);
  writeFileSync(paths.injectionsLog, content(injectionLine));
  writeFileSync(paths.feedbackLog, content(feedbackLine));
  writeFileSync(paths.codexFeedbackLog, content(feedbackLine));
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    getLearningsHealthNotice({ store, now: NOW, runGit });
    samples.push(performance.now() - start);
  }
  // SessionStart は毎回新しいプロセスなので、初回が実態に近い。判定には使わない
  const first = samples[0] ?? Infinity;
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1] ?? Infinity;
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
  console.error(
    `health [${name}]: first=${first.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${sorted.at(-1)?.toFixed(1)}ms (n=${samples.length})`,
  );
  return { p50, p95 };
}

describe("getLearningsHealthNotice latency", () => {
  // 全状態を先に測り、判定の it は結果を比べるだけにする。
  // 計測が投げたら before が失敗し、下の it はすべてその失敗で落ちる
  const timings = new Map<string, Timing>();
  before(() => {
    for (const state of states)
      timings.set(state.name, measure(state.name, state.content));
  });

  const timingOf = (name: string): Timing => {
    const timing = timings.get(name);
    ok(timing, `no timing for ${name}`);
    return timing;
  };

  for (const state of states) {
    it(`p95 over ${RUNS} calls with all three logs at ${state.name} is <= ${P95_LIMIT_MS} ms`, () => {
      const { p95 } = timingOf(state.name);
      ok(
        p95 <= P95_LIMIT_MS,
        `${state.name}: p95 ${p95.toFixed(1)}ms > ${P95_LIMIT_MS}ms`,
      );
    });
  }

  it(`p50 at ${HARD_MAX} is <= ${TAIL_RATIO_LIMIT}x the p50 at ${MINIMAL}`, () => {
    const capped = timingOf(HARD_MAX).p50;
    const base = timingOf(MINIMAL).p50;
    const ratio = capped / base;
    console.error(`health tail ratio (4MB / 1MB p50): ${ratio.toFixed(2)}`);
    ok(
      ratio <= TAIL_RATIO_LIMIT,
      `p50 ${capped.toFixed(1)}ms / ${base.toFixed(1)}ms = ${ratio.toFixed(2)} > ${TAIL_RATIO_LIMIT}`,
    );
  });
});
