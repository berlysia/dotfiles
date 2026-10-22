import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recordClaudeInjections } from "../../lib/agent-learnings/claude/inject-log.ts";
import {
  loadFeedback,
  loadInjections,
  loadMetrics,
  recordFeedback,
  recordInjections,
} from "../../lib/agent-learnings/core/metrics-log.ts";
import { parseInjectionLines } from "../../lib/agent-learnings/core/metrics.ts";
import { storePaths } from "../../lib/agent-learnings/core/store.ts";

const withStore = (fn: (store: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "al-mlog-"));
  try {
    const store = join(root, "store");
    mkdirSync(join(store, ".state", "codex"), { recursive: true });
    fn(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const AT = new Date("2026-10-22T00:00:00.000Z");
const REPO = "github.com/a/b";
const ID1 = "L-000000000001";
const ID2 = "L-000000000002";

describe("recordInjections", () => {
  it("writes one line per item and reads back the same values", () => {
    withStore((store) => {
      const ok1 = recordInjections(store, {
        at: AT,
        repoKey: REPO,
        kind: "pre",
        items: [
          { id: ID1, trigger: "cmd:git commit" },
          { id: ID2, trigger: "untagged" },
        ],
      });
      strictEqual(ok1, true);
      const text = readFileSync(storePaths(store).injectionsLog, "utf8");
      deepStrictEqual(parseInjectionLines(text).lines, [
        {
          v: 1,
          at: AT.toISOString(),
          repoKey: REPO,
          id: ID1,
          kind: "pre",
          trigger: "cmd:git commit",
        },
        {
          v: 1,
          at: AT.toISOString(),
          repoKey: REPO,
          id: ID2,
          kind: "pre",
          trigger: "untagged",
        },
      ]);
      strictEqual(loadInjections(store).lines.length, 2);
    });
  });
  it("does not throw on invalid items and writes nothing for them", () => {
    withStore((store) => {
      recordInjections(store, {
        at: AT,
        repoKey: REPO,
        kind: "pre",
        items: [{ id: ID1, trigger: "cmd:git; rm" }],
      });
      strictEqual(loadInjections(store).lines.length, 0);
      strictEqual(
        recordInjections(store, {
          at: AT,
          repoKey: REPO,
          kind: "pre",
          items: [],
        }),
        true,
      );
    });
  });
  it("returns false instead of throwing when the log cannot be written", () => {
    strictEqual(
      recordClaudeInjections("/nonexistent/store", {
        at: AT,
        repoKey: REPO,
        kind: "session",
        items: [{ id: ID1, trigger: "session" }],
      }),
      false,
    );
  });
});

describe("feedback", () => {
  it("loadFeedback merges claude and codex logs", () => {
    withStore((store) => {
      const base = {
        v: 1 as const,
        at: AT.toISOString(),
        repoKey: REPO,
        id: ID1,
        verdict: "mistimed" as const,
        kind: "pre" as const,
        trigger: "cmd:git",
      };
      ok(recordFeedback(store, { ...base, reader: "claude" }));
      ok(recordFeedback(store, { ...base, reader: "codex" }));
      ok(recordFeedback(store, { ...base, reader: "unknown" }));
      const loaded = loadFeedback(store);
      strictEqual(loaded.lines.length, 3);
      strictEqual(
        readFileSync(storePaths(store).codexFeedbackLog, "utf8").includes(
          '"reader":"codex"',
        ),
        true,
      );
    });
  });
});

describe("loadMetrics", () => {
  it("summarizes and reports oldest injection and truncation", () => {
    withStore((store) => {
      recordInjections(store, {
        at: new Date(AT.getTime() - 86400000),
        repoKey: REPO,
        kind: "pre",
        items: [{ id: ID1, trigger: "cmd:git" }],
      });
      const m = loadMetrics(store, AT);
      strictEqual(m.injections.pre, 1);
      strictEqual(m.injectionsTruncated, false);
      strictEqual(
        m.oldestInjectionAt,
        new Date(AT.getTime() - 86400000).toISOString(),
      );
      strictEqual(m.injectionsUnknown, 0);
    });
  });
});
