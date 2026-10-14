import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  applyOps,
  MAX_ENTRIES,
  type OpsContext,
} from "../../lib/agent-learnings/core/ops.ts";
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
