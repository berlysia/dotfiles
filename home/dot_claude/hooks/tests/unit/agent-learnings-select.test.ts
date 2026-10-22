import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type {
  LearningEntry,
  LearningsFile,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import {
  cmdSituations,
  collectCandidates,
  pathSituation,
} from "../../lib/agent-learnings/core/scene.ts";
import {
  selectInjectable,
  SESSION_MAX_BYTES,
  SESSION_MAX_ITEMS,
  type Candidate,
  type InjectedRecord,
} from "../../lib/agent-learnings/core/select.ts";

const KEY = "github.com/berlysia/foo";
const entry = (
  n: number,
  opts: { on?: string; seen?: number; updated?: string } = {},
): LearningEntry => ({
  id: `L-${n.toString(16).padStart(12, "0")}`,
  title: `title ${n}`,
  body: `body ${n}`,
  seen: opts.seen ?? 1,
  repos: [KEY],
  updated: opts.updated ?? "2026-10-01",
  extra: opts.on === undefined ? [] : [["on", opts.on]],
});
const file = (key: string, entries: LearningEntry[]): LearningsFile => ({
  format: 1,
  key,
  readOnly: false,
  entries,
});
const cand = (e: LearningEntry): Candidate => ({
  entry: e,
  fileKey: KEY,
  trigger: { kind: "session" },
});
const none = { records: [] as InjectedRecord[], totalCount: 0, totalBytes: 0 };
const rec = (
  n: number,
  kind: InjectedRecord["kind"],
  agent = "main",
): InjectedRecord => ({ agent, id: entry(n).id, kind, bytes: 10 });

describe("collectCandidates", () => {
  const repo = file(KEY, [entry(1, { on: "cmd:git commit" })]);
  const common = file("common", [entry(2, { on: "cmd:git" })]);
  it("collects entries matching any situation from both files", () => {
    const got = collectCandidates({
      repo,
      common,
      situations: [{ kind: "cmd", words: ["git", "commit"] }],
    });
    deepStrictEqual(
      got.map((c) => c.entry.id),
      [entry(1).id, entry(2).id],
    );
  });
  it("only common matches git push", () => {
    const got = collectCandidates({
      repo,
      common,
      situations: [{ kind: "cmd", words: ["git", "push"] }],
    });
    deepStrictEqual(
      got.map((c) => c.entry.id),
      [entry(2).id],
    );
  });
  it("accepts null files", () => {
    deepStrictEqual(
      collectCandidates({ repo: null, common: null, situations: [] }),
      [],
    );
  });
});

describe("selectInjectable", () => {
  const five = [1, 2, 3, 4, 5].map((n) => cand(entry(n, { seen: n })));
  it("picks 3 by seen desc", () => {
    const { selected } = selectInjectable({
      candidates: five,
      injected: none,
      kind: "pre",
      agent: "main",
    });
    deepStrictEqual(
      selected.map((c) => c.entry.seen),
      [5, 4, 3],
    );
  });
  it("breaks ties by updated desc", () => {
    const { selected } = selectInjectable({
      candidates: [
        cand(entry(1, { updated: "2026-10-01" })),
        cand(entry(2, { updated: "2026-10-05" })),
      ],
      injected: none,
      kind: "pre",
      agent: "main",
    });
    strictEqual(selected[0]?.entry.id, entry(2).id);
  });
  it("collapses duplicate ids", () => {
    const { selected } = selectInjectable({
      candidates: [cand(entry(1)), cand(entry(1))],
      injected: none,
      kind: "pre",
      agent: "main",
    });
    strictEqual(selected.length, 1);
  });
  it("pre / path skip entries already injected as pre or path; fail does not", () => {
    for (const recorded of ["pre", "path"] as const) {
      const injected = { ...none, records: [rec(1, recorded)] };
      for (const kind of ["pre", "path"] as const) {
        deepStrictEqual(
          selectInjectable({
            candidates: [cand(entry(1))],
            injected,
            kind,
            agent: "main",
          }).selected,
          [],
        );
      }
      strictEqual(
        selectInjectable({
          candidates: [cand(entry(1))],
          injected,
          kind: "fail",
          agent: "main",
        }).selected.length,
        1,
      );
    }
  });
  it("fail skips entries already injected as fail", () => {
    deepStrictEqual(
      selectInjectable({
        candidates: [cand(entry(1))],
        injected: { ...none, records: [rec(1, "fail")] },
        kind: "fail",
        agent: "main",
      }).selected,
      [],
    );
  });
  it("does not dedupe across agents", () => {
    strictEqual(
      selectInjectable({
        candidates: [cand(entry(1))],
        injected: { ...none, records: [rec(1, "pre", "sub1")] },
        kind: "pre",
        agent: "main",
      }).selected.length,
      1,
    );
  });
  it("selects nothing at the session item cap", () => {
    strictEqual(SESSION_MAX_ITEMS, 12);
    deepStrictEqual(
      selectInjectable({
        candidates: five,
        injected: { ...none, totalCount: 12 },
        kind: "pre",
        agent: "main",
      }).selected,
      [],
    );
  });
  it("limits by the remaining session count", () => {
    strictEqual(
      selectInjectable({
        candidates: five,
        injected: { ...none, totalCount: 10 },
        kind: "pre",
        agent: "main",
      }).selected.length,
      2,
    );
  });
  it("reports remaining bytes", () => {
    strictEqual(SESSION_MAX_BYTES, 16384);
    strictEqual(
      selectInjectable({
        candidates: five,
        injected: { ...none, totalBytes: 16000 },
        kind: "pre",
        agent: "main",
      }).remainingBytes,
      384,
    );
    strictEqual(
      selectInjectable({
        candidates: five,
        injected: { ...none, totalBytes: 99999 },
        kind: "pre",
        agent: "main",
      }).remainingBytes,
      0,
    );
  });
});

describe("cmdSituations / pathSituation", () => {
  it("builds one situation per simple command", () => {
    deepStrictEqual(cmdSituations("cd r && git commit"), [
      { kind: "cmd", words: ["cd", "r"] },
      { kind: "cmd", words: ["git", "commit"] },
    ]);
  });
  const p = (cwd: string, filePath: string) =>
    pathSituation({ cwd, toplevel: "/r", filePath });
  it("normalizes . and .. and makes the path relative to toplevel", () => {
    deepStrictEqual(p("/r/a", "../mods/x/f.ts"), {
      kind: "path",
      relPath: "mods/x/f.ts",
    });
    deepStrictEqual(p("/r/a", "/r/./mods//x/f.ts"), {
      kind: "path",
      relPath: "mods/x/f.ts",
    });
  });
  it("returns null outside the toplevel", () => {
    strictEqual(p("/r/a", "/etc/passwd"), null);
    strictEqual(p("/r/a", "../../etc/passwd"), null);
    strictEqual(p("/r", "/rr/x"), null);
  });
  it("returns null for the toplevel itself", () => {
    ok(p("/r", "/r") === null);
  });
});
