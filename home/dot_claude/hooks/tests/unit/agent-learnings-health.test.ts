import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getLearningsHealthNotice } from "../../lib/agent-learnings/claude/health.ts";
import type { RunGit } from "../../lib/agent-learnings/core/git.ts";
import {
  formatFeedbackLine,
  formatInjectionLine,
} from "../../lib/agent-learnings/core/metrics.ts";
import {
  ensureStateDirs,
  LOG_HARD_MAX_BYTES,
  storePaths,
} from "../../lib/agent-learnings/core/store.ts";

// 実 git は使わない（unit は CLAUDE_TEST_FORBID_GIT=1）。upstream が無い store として振る舞う
const noGit: RunGit = () => ({ ok: false, status: 128 });
const NOW = new Date("2026-10-22T00:00:00.000Z");
const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "al-health-unit-"));
  roots.push(root);
  const store = join(root, "s");
  mkdirSync(join(store, ".git"), { recursive: true });
  ensureStateDirs(store);
  return { store, paths: storePaths(store) };
}
const notice = (store: string) =>
  getLearningsHealthNotice({ store, now: NOW, runGit: noGit });
const at = new Date(NOW.getTime() - 3_600_000).toISOString();
const inj = {
  v: 1 as const,
  at,
  repoKey: "github.com/a/b",
  id: "L-000000000001",
  kind: "pre" as const,
  trigger: "cmd:git commit",
};
const fb = {
  ...inj,
  reader: "claude" as const,
  verdict: "mistimed" as const,
};

describe("getLearningsHealthNotice (metrics)", () => {
  it("is null without review candidates", () => {
    const { store, paths } = makeStore();
    writeFileSync(paths.injectionsLog, formatInjectionLine(inj));
    strictEqual(notice(store), null);
  });
  it("reports a review candidate in one line", () => {
    const { store, paths } = makeStore();
    writeFileSync(paths.injectionsLog, formatInjectionLine(inj).repeat(3));
    writeFileSync(paths.feedbackLog, formatFeedbackLine(fb).repeat(2));
    const line = notice(store) ?? "";
    ok(line.includes("見直す候補 1 件"));
    ok(line.includes("agent-learnings status"));
    strictEqual(line.split("\n").length, 1);
  });
  it("reports a log at the hard limit", () => {
    const { store, paths } = makeStore();
    writeFileSync(paths.injectionsLog, "");
    truncateSync(paths.injectionsLog, LOG_HARD_MAX_BYTES + 1);
    ok((notice(store) ?? "").includes("記録のログが上限"));
  });
  it(
    "keeps the failed notice and returns at once when injections.log is a FIFO",
    { timeout: 1000 },
    () => {
      const { store, paths } = makeStore();
      writeFileSync(
        join(paths.failed, "0f0e0d0c-0000-4000-8000-000000000001.json"),
        "{}",
      );
      execFileSync("mkfifo", [paths.injectionsLog]);
      const line = notice(store) ?? "";
      ok(line.includes("failed/ にジョブ 1 件"));
      ok(!line.includes("見直す候補"));
    },
  );
});
