import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  applyOps,
  evictEntries,
  MAX_ENTRIES,
  type OpsContext,
  type OpsResult,
} from "../../lib/agent-learnings/core/ops.ts";
import {
  parseTriggers,
  type ValidatedTriggers,
} from "../../lib/agent-learnings/core/triggers.ts";
import type {
  LearningEntry,
  LearningsFile,
} from "../../lib/agent-learnings/core/learnings-file.ts";

const KEY = "github.com/berlysia/foo";
const entry = (
  n: number,
  over: Partial<LearningEntry> = {},
): LearningEntry => ({
  id: `L-${n.toString(16).padStart(12, "0")}`,
  title: `title ${n}`,
  body: `body ${n}`,
  seen: 1,
  repos: [KEY],
  updated: "2026-10-01",
  extra: [],
  ...over,
});
const file = (entries: LearningEntry[]): LearningsFile => ({
  format: 1,
  key: KEY,
  readOnly: false,
  entries,
});
function ctx(): OpsContext {
  let counter = 0x100;
  return {
    today: "2026-10-15",
    repoKey: KEY,
    newId: () => `L-${(counter++).toString(16).padStart(12, "0")}`,
    rules: { allowUrl: false },
    extraRedact: [],
  };
}

describe("applyOps", () => {
  it("adds an entry with a fresh id and records evidence", () => {
    const r = applyOps(
      file([]),
      [{ op: "add", title: "t", body: "b", evidence: "e1" }],
      ctx(),
    );
    ok(r.ok);
    strictEqual(r.value.file.entries.length, 1);
    strictEqual(r.value.file.entries[0]?.updated, "2026-10-15");
    deepStrictEqual(r.value.file.entries[0]?.repos, [KEY]);
    deepStrictEqual(r.value.evidence, [`add ${r.value.addedIds[0]}: e1`]);
  });
  it("turns an add with a matching heading into seen+1", () => {
    const r = applyOps(
      file([entry(1, { title: "Ｔｉｔｌｅ  1" })]),
      [{ op: "add", title: "title 1", body: "x", evidence: "e" }],
      ctx(),
    );
    ok(r.ok);
    strictEqual(r.value.file.entries.length, 1);
    strictEqual(r.value.file.entries[0]?.seen, 2);
    strictEqual(r.value.addedIds[0], entry(1).id);
  });
  it("rejects two adds with the same normalized heading in one batch", () => {
    strictEqual(
      applyOps(
        file([]),
        [
          { op: "add", title: "Same", body: "a", evidence: "e" },
          { op: "add", title: "same", body: "b", evidence: "e" },
        ],
        ctx(),
      ).ok,
      false,
    );
  });
  it("removes an existing id and rejects an unknown id", () => {
    ok(
      applyOps(
        file([entry(1)]),
        [{ op: "remove", id: entry(1).id, reason: "wrong" }],
        ctx(),
      ).ok,
    );
    strictEqual(
      applyOps(
        file([entry(1)]),
        [{ op: "remove", id: "L-ffffffffffff", reason: "x" }],
        ctx(),
      ).ok,
      false,
    );
  });
  it("rejects the whole list when any op is invalid", () => {
    strictEqual(
      applyOps(
        file([]),
        [
          { op: "add", title: "ok", body: "fine", evidence: "e" },
          { op: "add", title: "#bad", body: "fine", evidence: "e" },
        ],
        ctx(),
      ).ok,
      false,
    );
  });
  it("enforces evidence and reason limits at 200 chars", () => {
    strictEqual(
      applyOps(
        file([]),
        [{ op: "add", title: "t", body: "b", evidence: "" }],
        ctx(),
      ).ok,
      false,
    );
    ok(
      applyOps(
        file([]),
        [{ op: "add", title: "t", body: "b", evidence: "e".repeat(200) }],
        ctx(),
      ).ok,
    );
    strictEqual(
      applyOps(
        file([]),
        [{ op: "add", title: "t", body: "b", evidence: "e".repeat(201) }],
        ctx(),
      ).ok,
      false,
    );
    ok(
      applyOps(
        file([entry(1)]),
        [{ op: "remove", id: entry(1).id, reason: "r".repeat(200) }],
        ctx(),
      ).ok,
    );
    strictEqual(
      applyOps(
        file([entry(1)]),
        [{ op: "remove", id: entry(1).id, reason: "r".repeat(201) }],
        ctx(),
      ).ok,
      false,
    );
  });
  it("rejects two ops on the same id", () => {
    strictEqual(
      applyOps(
        file([entry(1)]),
        [
          { op: "remove", id: entry(1).id, reason: "a" },
          { op: "remove", id: entry(1).id, reason: "b" },
        ],
        ctx(),
      ).ok,
      false,
    );
  });
  it("evicts lowest seen, then oldest updated, when over the cap", () => {
    const full = Array.from({ length: MAX_ENTRIES }, (_, i) =>
      entry(i + 1, { seen: 2, updated: "2026-10-10" }),
    );
    full[5] = entry(6, { seen: 1, updated: "2026-10-12" });
    full[7] = entry(8, { seen: 1, updated: "2026-10-11" });
    const r = applyOps(
      file(full),
      [{ op: "add", title: "new", body: "b", evidence: "e" }],
      ctx(),
    );
    ok(r.ok);
    strictEqual(r.value.file.entries.length, MAX_ENTRIES);
    deepStrictEqual(r.value.evictedIds, [entry(8).id]);
  });
  it("refuses read-only files", () => {
    strictEqual(
      applyOps(
        { ...file([]), readOnly: true },
        [{ op: "add", title: "t", body: "b", evidence: "e" }],
        ctx(),
      ).ok,
      false,
    );
  });
});

describe("applyOps update", () => {
  const OTHER = "L-aaaaaaaaaaaa";
  it("changes only the body, bumps seen and updated, records evidence", () => {
    const r = applyOps(
      file([entry(1)]),
      [{ op: "update", id: entry(1).id, body: "new body", evidence: "ev" }],
      ctx(),
    );
    ok(r.ok);
    const e = r.value.file.entries[0];
    strictEqual(e?.body, "new body");
    strictEqual(e?.title, "title 1");
    strictEqual(e?.seen, 2);
    strictEqual(e?.updated, "2026-10-15");
    deepStrictEqual(r.value.evidence, [`update ${entry(1).id}: ev`]);
  });
  it("only bumps seen when title and body are omitted", () => {
    const r = applyOps(
      file([entry(1)]),
      [{ op: "update", id: entry(1).id, evidence: "ev" }],
      ctx(),
    );
    ok(r.ok);
    const e = r.value.file.entries[0];
    strictEqual(e?.seen, 2);
    strictEqual(e?.body, "body 1");
    strictEqual(e?.title, "title 1");
  });
  it("rejects an unknown id, a bad title, empty evidence and a URL body", () => {
    const base = file([entry(1)]);
    for (const op of [
      { op: "update" as const, id: OTHER, body: "b", evidence: "e" },
      { op: "update" as const, id: entry(1).id, title: "#x", evidence: "e" },
      { op: "update" as const, id: entry(1).id, body: "b", evidence: "" },
      {
        op: "update" as const,
        id: entry(1).id,
        body: "see https://example.com",
        evidence: "e",
      },
    ]) {
      strictEqual(applyOps(base, [op], ctx()).ok, false);
    }
  });
  it("flattens newlines and redacts secrets in evidence", () => {
    const r = applyOps(
      file([entry(1)]),
      [
        {
          op: "update",
          id: entry(1).id,
          evidence:
            "line1\nline2 token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      ],
      ctx(),
    );
    ok(r.ok);
    const line = r.value.evidence[0] ?? "";
    ok(!line.includes("\n"));
    ok(line.includes("[REDACTED]"));
    ok(!line.includes("ghp_AAA"));
  });
  it("rejects update and remove on the same id", () => {
    strictEqual(
      applyOps(
        file([entry(1)]),
        [
          { op: "update", id: entry(1).id, evidence: "e" },
          { op: "remove", id: entry(1).id, reason: "r" },
        ],
        ctx(),
      ).ok,
      false,
    );
  });
  it("rejects an add whose heading matches an updated entry", () => {
    strictEqual(
      applyOps(
        file([entry(1)]),
        [
          { op: "update", id: entry(1).id, evidence: "e" },
          { op: "add", title: "title 1", body: "b", evidence: "e" },
        ],
        ctx(),
      ).ok,
      false,
    );
  });
  it("rejects an update whose new title collides with another entry", () => {
    strictEqual(
      applyOps(
        file([entry(1), entry(2)]),
        [{ op: "update", id: entry(1).id, title: "Title 2", evidence: "e" }],
        ctx(),
      ).ok,
      false,
    );
  });
  it("keeps an updated entry out of the eviction candidates", () => {
    const full = Array.from({ length: MAX_ENTRIES }, (_, i) =>
      entry(i + 1, { seen: 5, updated: "2026-10-10" }),
    );
    full[0] = entry(1, { seen: 1, updated: "2026-01-01" }); // 追い出し候補の筆頭
    const r = applyOps(
      file(full),
      [
        { op: "update", id: entry(1).id, evidence: "e" },
        { op: "add", title: "new", body: "b", evidence: "e" },
      ],
      ctx(),
    );
    ok(r.ok);
    ok(!r.value.evictedIds.includes(entry(1).id));
    strictEqual(r.value.evictedIds.length, 1);
  });
  it("drops a remove of a droppable missing id and applies the rest", () => {
    const r = applyOps(
      file([]),
      [
        { op: "remove", id: OTHER, reason: "r" },
        { op: "add", title: "t", body: "b", evidence: "e" },
      ],
      { ...ctx(), droppableIds: new Set([OTHER]) },
    );
    ok(r.ok);
    strictEqual(r.value.droppedCount, 1);
    strictEqual(r.value.file.entries.length, 1);
    strictEqual(r.value.removedIds.length, 0);
  });
  it("drops an update of a droppable missing id", () => {
    const r = applyOps(
      file([]),
      [{ op: "update", id: OTHER, body: "b", evidence: "e" }],
      { ...ctx(), droppableIds: new Set([OTHER]) },
    );
    ok(r.ok);
    strictEqual(r.value.droppedCount, 1);
  });
  it("rejects a missing id that is not droppable", () => {
    const r = applyOps(
      file([]),
      [{ op: "update", id: OTHER, body: "b", evidence: "e" }],
      { ...ctx(), droppableIds: new Set(["L-bbbbbbbbbbbb"]) },
    );
    strictEqual(r.ok, false);
  });
});

describe("evictEntries", () => {
  it("returns the entries untouched while under the limit", () => {
    const entries = [entry(1), entry(2)];
    const r = evictEntries(entries, new Set(), 2);
    deepStrictEqual(r.entries, entries);
    deepStrictEqual(r.evictedIds, []);
  });
  it("evicts the lowest seen first, then the oldest updated, then the earliest position", () => {
    const entries = [
      entry(1, { seen: 2, updated: "2026-10-01" }),
      entry(2, { seen: 1, updated: "2026-10-05" }),
      entry(3, { seen: 1, updated: "2026-10-02" }),
      entry(4, { seen: 1, updated: "2026-10-02" }),
    ];
    const r = evictEntries(entries, new Set(), 1);
    deepStrictEqual(r.evictedIds, [entry(3).id, entry(4).id, entry(2).id]);
    deepStrictEqual(
      r.entries.map((e) => e.id),
      [entry(1).id],
    );
  });
  it("never evicts a protected id, even when that leaves the file over the limit", () => {
    const entries = [entry(1), entry(2), entry(3)];
    const r = evictEntries(entries, new Set([entry(1).id, entry(2).id]), 1);
    deepStrictEqual(r.evictedIds, [entry(3).id]);
    strictEqual(r.entries.length, 2);
  });
});

describe("applyOps with on", () => {
  const trigs = (...values: string[]): ValidatedTriggers => {
    const r = parseTriggers(values);
    ok(r.ok);
    return r.value;
  };
  const extraOn = (e: LearningEntry | undefined): string | undefined =>
    e?.extra.find(([k]) => k === "on")?.[1];
  const withOn = (n: number, on: string, over: Partial<LearningEntry> = {}) =>
    entry(n, { extra: [["on", on]], seen: 3, ...over });

  it("writes on for a new add", () => {
    const r = applyOps(
      file([]),
      [
        {
          op: "add",
          title: "t",
          body: "b",
          evidence: "e",
          on: trigs("cmd:git commit"),
        },
      ],
      ctx(),
    );
    ok(r.ok);
    strictEqual(extraOn(r.value.file.entries[0]), "cmd:git commit");
  });
  it("records the on value in the evidence of a new add only", () => {
    const fresh = applyOps(
      file([]),
      [
        {
          op: "add",
          title: "t",
          body: "b",
          evidence: "e",
          on: trigs("cmd:git", "path:.claude/x"),
        },
      ],
      ctx(),
    );
    ok(fresh.ok);
    deepStrictEqual(fresh.value.evidence, [
      `add ${fresh.value.addedIds[0]}: e`,
      "on: cmd:git,path:.claude/x/",
    ]);
    const noOn = applyOps(
      file([]),
      [{ op: "add", title: "t", body: "b", evidence: "e" }],
      ctx(),
    );
    ok(noOn.ok);
    strictEqual(noOn.value.evidence.length, 1);
    const dup = applyOps(
      file([withOn(1, "cmd:git commit")]),
      [
        {
          op: "add",
          title: "title 1",
          body: "x",
          evidence: "e",
          on: trigs("session"),
        },
      ],
      ctx(),
    );
    ok(dup.ok);
    ok(!dup.value.evidence.some((line) => line.startsWith("on:")));
  });
  it("drops on for an add that only bumps seen", () => {
    const r = applyOps(
      file([withOn(1, "cmd:git commit")]),
      [
        {
          op: "add",
          title: "title 1",
          body: "x",
          evidence: "e",
          on: trigs("session"),
        },
      ],
      ctx(),
    );
    ok(r.ok);
    strictEqual(extraOn(r.value.file.entries[0]), "cmd:git commit");
    strictEqual(r.value.file.entries[0]?.seen, 4);
  });
  it("rejects path-prefix in common but allows a suffix", () => {
    const common = { ...file([]), key: "common" };
    const add = (on: ValidatedTriggers): OpsResult =>
      applyOps(
        common,
        [{ op: "add", title: "t", body: "b", evidence: "e", on }],
        { ...ctx(), repoKey: null },
      );
    strictEqual(add(trigs("path:mods/x/")).ok, false);
    ok(add(trigs("path:*.test.ts")).ok);
  });
  it("retags with on only, leaving seen and updated alone", () => {
    const r = applyOps(
      file([withOn(1, "cmd:git commit")]),
      [
        {
          op: "update",
          id: entry(1).id,
          evidence: "ev",
          on: trigs("cmd:git push"),
        },
      ],
      ctx(),
    );
    ok(r.ok);
    const e = r.value.file.entries[0];
    strictEqual(extraOn(e), "cmd:git push");
    strictEqual(e?.seen, 3);
    strictEqual(e?.updated, "2026-10-01");
    deepStrictEqual(r.value.evidence, [
      `retag ${entry(1).id}: cmd:git commit -> cmd:git push (ev)`,
    ]);
    deepStrictEqual(r.value.updatedIds, [entry(1).id]);
  });
  it("treats whitespace-only text differences as unchanged", () => {
    const r = applyOps(
      file([withOn(1, "cmd:git commit", { body: "body 1" })]),
      [
        {
          op: "update",
          id: entry(1).id,
          body: "  body 1 ",
          evidence: "ev",
          on: trigs("session"),
        },
      ],
      ctx(),
    );
    ok(r.ok);
    strictEqual(r.value.file.entries[0]?.seen, 3);
    strictEqual(extraOn(r.value.file.entries[0]), "session");
  });
  it("update without on and without text change keeps the old behaviour", () => {
    const r = applyOps(
      file([withOn(1, "cmd:git commit")]),
      [{ op: "update", id: entry(1).id, evidence: "ev" }],
      ctx(),
    );
    ok(r.ok);
    strictEqual(r.value.file.entries[0]?.seen, 4);
    strictEqual(extraOn(r.value.file.entries[0]), "cmd:git commit");
  });
  it("drops on when the text changes and on is not passed", () => {
    const r = applyOps(
      file([withOn(1, "cmd:git commit")]),
      [{ op: "update", id: entry(1).id, body: "new body", evidence: "ev" }],
      ctx(),
    );
    ok(r.ok);
    strictEqual(extraOn(r.value.file.entries[0]), undefined);
    strictEqual(r.value.file.entries[0]?.seen, 4);
    deepStrictEqual(r.value.evidence, [
      `update ${entry(1).id}: ev`,
      `untag ${entry(1).id}: cmd:git commit (updated by worker)`,
    ]);
  });
  it("drops an invalid on and reports it as invalid", () => {
    const r = applyOps(
      file([withOn(1, "<script>")]),
      [{ op: "update", id: entry(1).id, body: "new body", evidence: "ev" }],
      ctx(),
    );
    ok(r.ok);
    strictEqual(extraOn(r.value.file.entries[0]), undefined);
    ok(
      r.value.evidence.includes(
        `untag ${entry(1).id}: invalid (updated by worker)`,
      ),
    );
  });
  it("changes text and on together", () => {
    const r = applyOps(
      file([withOn(1, "cmd:git commit")]),
      [
        {
          op: "update",
          id: entry(1).id,
          body: "new body",
          evidence: "ev",
          on: trigs("cmd:git push"),
        },
      ],
      ctx(),
    );
    ok(r.ok);
    const e = r.value.file.entries[0];
    strictEqual(e?.body, "new body");
    strictEqual(extraOn(e), "cmd:git push");
    strictEqual(e?.seen, 4);
  });
  it("leaves a no-on entry alone when text changes without on", () => {
    const r = applyOps(
      file([entry(1)]),
      [{ op: "update", id: entry(1).id, body: "new body", evidence: "ev" }],
      ctx(),
    );
    ok(r.ok);
    deepStrictEqual(r.value.evidence, [`update ${entry(1).id}: ev`]);
  });
});
