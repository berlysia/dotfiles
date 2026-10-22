// Upper bound only (spec K8, provisional): p95 of the PreToolUse(Bash) hook process <= 150 ms.
// It lives here, not in heavy/, so the machine is not loaded by parallel tests.
// If this fails, do not loosen the bound: report the numbers and revisit plan-2
// (the K8 fallback is to drop the PreToolUse(Bash) registration).
import { ok, strictEqual } from "node:assert";
import { realpathSync } from "node:fs";
import { after, describe, it } from "node:test";
import {
  appendCache,
  ensureSceneDir,
} from "../../lib/agent-learnings/core/scene-state.ts";
import { sceneStateDir } from "../../lib/agent-learnings/claude/scene-context.ts";
import {
  bashInput,
  learning,
  makeWorld,
  REPO_KEY,
  removeWorld,
  runHookProcess,
} from "../support/agent-learnings-trigger-fixture.ts";

const RUNS = 20;
const P95_LIMIT_MS = 150;

const entries = Array.from({ length: 40 }, (_, i) =>
  learning(i + 1, i < 5 ? "cmd:git commit" : `cmd:tool${i} sub`),
);
const world = makeWorld(entries);
after(() => removeWorld(world));

describe("learnings-trigger process latency", () => {
  it(`p95 over ${RUNS} runs with 40 entries and a warm cache is <= ${P95_LIMIT_MS} ms`, () => {
    const stateDir = sceneStateDir(world.home);
    ok(ensureSceneDir(stateDir));
    const cwd = realpathSync(world.repo);
    const samples: number[] = [];
    // 注入まで通る経路を測るため、実行ごとに別のセッションにして .cache だけ温めておく
    for (let i = 0; i < RUNS + 1; i++) {
      const sessionId = `perf-${i}`;
      ok(
        appendCache(stateDir, sessionId, {
          cwd,
          repoKey: REPO_KEY,
          toplevel: cwd,
        }),
      );
      const r = runHookProcess(
        world,
        JSON.stringify(bashInput(world, "git commit -m x", sessionId)),
      );
      strictEqual(r.status, 0, r.stderr);
      ok(
        r.stdout.includes("additionalContext"),
        "the path measured must inject",
      );
      // 最初の 1 回は bun とファイルキャッシュの起動分なので捨てる
      if (i > 0) samples.push(r.elapsedMs);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
    const p50 = samples[Math.floor(samples.length / 2)] ?? Infinity;
    console.error(
      `learnings-trigger: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${samples.at(-1)?.toFixed(1)}ms (n=${samples.length})`,
    );
    ok(p95 <= P95_LIMIT_MS, `p95 ${p95.toFixed(1)}ms > ${P95_LIMIT_MS}ms`);
  });
});
