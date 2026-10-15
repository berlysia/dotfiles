import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type {
  LearningEntry,
  LearningsFile,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import {
  applyPromotes,
  buildCandidates,
  findRepoNames,
  promoteManually,
  type PromoteInput,
  type PromoteOp,
} from "../../lib/agent-learnings/core/promote.ts";
import type { NoPromoteResult } from "../../lib/agent-learnings/core/no-promote.ts";

const A = "github.com/org-a/alpha-service";
const B = "github.com/org-b/beta-tool";
const idOf = (n: number): string => `L-${n.toString(16).padStart(12, "0")}`;
const entry = (
  n: number,
  over: Partial<LearningEntry> = {},
): LearningEntry => ({
  id: idOf(n),
  title: `title ${n}`,
  body: `body ${n}`,
  seen: 1,
  repos: [],
  updated: "2026-10-01",
  extra: [],
  ...over,
});
const file = (
  key: string,
  entries: LearningEntry[],
  readOnly = false,
): LearningsFile => ({ format: 1, key, readOnly, entries });
const open_: NoPromoteResult = { ok: true, patterns: ["local/*"] };

// 元の項目 X（A）と Y（B）。昇格後の文面は X・Y と十分に重なる
const X = entry(1, {
  title: "Avoid overwriting files with cp",
  body: "Pass the update=none flag to cp so existing files are never overwritten.",
  seen: 2,
  repos: [A],
});
const Y = entry(2, {
  title: "Avoid overwriting files with cp",
  body: "Pass the update=none flag to cp so existing files are never overwritten.",
  seen: 1,
  repos: [B],
});
const GENERAL_TITLE = "Avoid overwriting files with cp";
const GENERAL_BODY =
  "Pass the update=none flag to cp so existing files are never overwritten.";

const promoteOp = (over: Partial<PromoteOp> = {}): PromoteOp => ({
  op: "promote",
  matchId: X.id,
  title: GENERAL_TITLE,
  body: GENERAL_BODY,
  evidence: "same fix in two repos",
  ...over,
});

function input(over: Partial<PromoteInput> = {}): PromoteInput {
  let counter = 0x500;
  return {
    repoKey: B,
    today: "2026-10-15",
    repoFile: file(B, [Y]),
    others: new Map([[A, file(A, [X])]]),
    common: file("common", []),
    noPromote: open_,
    ops: [promoteOp({ id: Y.id })],
    newId: () => idOf(counter++),
    extraRedact: [],
    droppableIds: new Set(),
    shownCandidateIds: new Set([X.id]),
    ...over,
  };
}
function applied(over: Partial<PromoteInput> = {}) {
  const r = applyPromotes(input(over));
  ok(r.ok, r.ok ? "" : r.reason);
  return r.value;
}
const rejects = (over: Partial<PromoteInput> = {}): void => {
  const r = applyPromotes(input(over));
  strictEqual(r.ok, false, "expected a rejection");
};

describe("applyPromotes", () => {
  it("moves a pair into common with summed seen and the union of repos", () => {
    const v = applied();
    strictEqual(v.common.entries.length, 1);
    const created = v.common.entries[0];
    deepStrictEqual(created?.repos.sort(), [A, B].sort());
    strictEqual(created?.seen, 3);
    strictEqual(created?.updated, "2026-10-15");
    strictEqual(v.changedOthers.get(A)?.entries.length, 0);
    strictEqual(v.repoFile.entries.length, 0);
    strictEqual(
      v.commitLines[0],
      `promote ${created?.id} <- ${X.id} (${A}), ${Y.id} (${B}): same fix in two repos`,
    );
    strictEqual(v.appliedCount, 1);
    strictEqual(v.droppedCount, 0);
  });
  it("counts the current repo as one sighting when id is omitted and leaves the repo file alone", () => {
    const v = applied({ ops: [promoteOp()] });
    strictEqual(v.common.entries[0]?.seen, 3);
    strictEqual(v.repoFile.entries.length, 1);
    ok(!v.commitLines[0]?.includes(Y.id));
    deepStrictEqual(v.common.entries[0]?.repos.sort(), [A, B].sort());
  });
  it("does not mutate its inputs", () => {
    const i = input();
    const before = JSON.stringify([i.repoFile, i.others.get(A), i.common]);
    applyPromotes(i);
    strictEqual(
      JSON.stringify([i.repoFile, i.others.get(A), i.common]),
      before,
    );
  });
  it("merges into a common entry with the same normalized heading", () => {
    const existing = entry(9, {
      title: "AVOID  overwriting files with cp",
      body: "kept body",
      seen: 5,
      repos: ["github.com/z/z"],
      updated: "2026-09-01",
    });
    const v = applied({ common: file("common", [existing]) });
    strictEqual(v.common.entries.length, 1);
    const merged = v.common.entries[0];
    strictEqual(merged?.seen, 8);
    strictEqual(merged?.title, existing.title);
    strictEqual(merged?.body, "kept body");
    strictEqual(merged?.updated, "2026-10-15");
    deepStrictEqual(merged?.repos.sort(), [A, B, "github.com/z/z"].sort());
    ok(v.commitLines[0]?.startsWith(`promote merge ${existing.id} <- `));
  });
  it("rejects a matchId that belongs to the current repo or was not shown", () => {
    rejects({
      repoFile: file(B, [Y, X]),
      ops: [promoteOp({ id: Y.id })],
    });
    rejects({ shownCandidateIds: new Set() });
  });
  it("rejects when no-promote is unreadable or matches either repo", () => {
    rejects({ noPromote: { ok: false, reason: "broken" } });
    rejects({ noPromote: { ok: true, patterns: ["github.com/org-a/*"] } });
    rejects({ noPromote: { ok: true, patterns: ["github.com/org-b/*"] } });
  });
  it("does nothing with no promotes even if no-promote is unreadable", () => {
    const r = applyPromotes(
      input({ ops: [], noPromote: { ok: false, reason: "broken" } }),
    );
    ok(r.ok);
    strictEqual(r.value.appliedCount, 0);
  });
  it("rejects a repo name in the promoted text, and a word of the name", () => {
    const keyed = (n: number, key: string) => entry(n, { ...X, repos: [key] });
    const kanbun = "github.com/berlysia/kanbun-annotation";
    for (const text of [
      "Use update=none; seen in kanbun-annotation too.",
      "Use update=none; seen in the kanbun repo too.",
    ]) {
      const x = keyed(1, kanbun);
      rejects({
        others: new Map([[kanbun, file(kanbun, [x])]]),
        ops: [promoteOp({ id: Y.id, body: `${GENERAL_BODY} ${text}` })],
      });
    }
  });
  it("does not check a 2-char name part or a 3-char word", () => {
    const short = "x.io/ab";
    const word = "x.io/abc-d";
    for (const [key, text] of [
      [short, "ab"],
      [word, "abc"],
    ] as const) {
      const x = entry(1, { ...X, repos: [key] });
      const r = applyPromotes(
        input({
          repoKey: B,
          others: new Map([[key, file(key, [x])]]),
          ops: [promoteOp({ id: Y.id, body: `${GENERAL_BODY} ${text}` })],
        }),
      );
      ok(r.ok, `${key} ${text}`);
    }
  });
  it("checks the matchId file key even when it is absent from the entry repos", () => {
    const x = entry(1, { ...X, repos: [] });
    rejects({
      others: new Map([[A, file(A, [x])]]),
      ops: [promoteOp({ id: Y.id, body: `${GENERAL_BODY} alpha` })],
    });
  });
  it("checks the repos of the id entry too", () => {
    const y = entry(2, { ...Y, repos: [B, "github.com/o/gamma-lib"] });
    rejects({
      repoFile: file(B, [y]),
      ops: [promoteOp({ id: y.id, body: `${GENERAL_BODY} gamma` })],
    });
  });
  it("finds repo names case-insensitively through NFKC", () => {
    deepStrictEqual(findRepoNames([A], "ＡＬＰＨＡ-service"), [
      "alpha-service",
      "alpha",
      "service",
    ]);
  });
  describe("content overlap", () => {
    // P = {ab, bc, de}。元の項目の bigram の集合 Q との比を数えて作る
    const source = (title: string) =>
      entry(1, { title, body: "z", seen: 2, repos: [] });
    const run = (sourceTitle: string) =>
      applyPromotes(
        input({
          others: new Map([[A, file(A, [source(sourceTitle)])]]),
          ops: [promoteOp({ title: "abc", body: "de" })],
        }),
      );
    it("passes at exactly 0.2 (1 shared of 5 in the union)", () => {
      ok(run("abxy").ok); // Q = {ab, bx, xy}: |P∩Q| = 1, |P∪Q| = 5
    });
    it("rejects below 0.2 (1 shared of 6 in the union)", () => {
      strictEqual(run("abxyw").ok, false); // Q = {ab, bx, xy, yw}
    });
    it("rejects an empty bigram set on either side", () => {
      strictEqual(
        applyPromotes(input({ ops: [promoteOp({ title: "a", body: "b" })] }))
          .ok,
        false,
      );
      strictEqual(
        applyPromotes(
          input({
            others: new Map([
              [A, file(A, [entry(1, { title: "x", body: "y", repos: [] })])],
            ]),
            ops: [promoteOp()],
          }),
        ).ok,
        false,
      );
    });
    it("uses the union of both sources when id is given", () => {
      const x = entry(1, { title: "abxy", body: "z", repos: [] });
      const y = entry(2, { title: "dezz", body: "z", repos: [] });
      const r = applyPromotes(
        input({
          repoFile: file(B, [y]),
          others: new Map([[A, file(A, [x])]]),
          ops: [promoteOp({ id: y.id, title: "abc", body: "de" })],
        }),
      );
      ok(r.ok); // Q = {ab, bx, xy, de, ez, zz}: shared 2 of 7
    });
  });
  it("rejects invalid texts", () => {
    rejects({
      ops: [promoteOp({ body: `see https://example.com ${GENERAL_BODY}` })],
    });
    rejects({ ops: [promoteOp({ title: "#x" })] });
    rejects({ ops: [promoteOp({ evidence: "" })] });
    rejects({ ops: [promoteOp({ evidence: "e".repeat(201) })] });
  });
  it("rejects two promotes that share a matchId or id", () => {
    rejects({ ops: [promoteOp(), promoteOp({ title: "Other heading" })] });
    rejects({
      ops: [
        promoteOp({ id: Y.id }),
        promoteOp({ matchId: idOf(7), id: Y.id, title: "Other heading" }),
      ],
    });
  });
  it("evicts from a full common but keeps what it just added", () => {
    const full = Array.from({ length: 40 }, (_, i) =>
      entry(100 + i, { seen: 5, updated: "2026-10-10" }),
    );
    full[0] = entry(100, { seen: 1, updated: "2026-01-01" });
    const v = applied({ common: file("common", full) });
    strictEqual(v.common.entries.length, 40);
    ok(!v.common.entries.some((e) => e.id === idOf(100)));
    ok(v.commitLines.some((l) => l === `evicted ${idOf(100)}`));
    ok(v.commitLines[0]?.startsWith("promote "));
  });
  it("applies in order so a later promote with the same heading merges", () => {
    const x2 = entry(3, { ...X, id: idOf(3), seen: 4 });
    const v = applied({
      others: new Map([[A, file(A, [X, x2])]]),
      shownCandidateIds: new Set([X.id, x2.id]),
      ops: [
        promoteOp(),
        promoteOp({
          matchId: x2.id,
          title: "avoid  Overwriting files with CP",
        }),
      ],
    });
    strictEqual(v.common.entries.length, 1);
    strictEqual(v.common.entries[0]?.seen, 3 + 5);
    ok(v.commitLines[1]?.startsWith("promote merge "));
  });
  it("drops a promote whose matchId or id vanished and counts it", () => {
    const gone = applyPromotes(
      input({
        others: new Map([[A, file(A, [])]]),
        ops: [promoteOp()],
        droppableIds: new Set([X.id]),
      }),
    );
    ok(gone.ok);
    strictEqual(gone.value.droppedCount, 1);
    strictEqual(gone.value.appliedCount, 0);
    strictEqual(gone.value.common.entries.length, 0);
    const goneOwn = applyPromotes(
      input({
        repoFile: file(B, []),
        ops: [promoteOp({ id: Y.id })],
        droppableIds: new Set([Y.id]),
      }),
    );
    ok(goneOwn.ok);
    strictEqual(goneOwn.value.droppedCount, 1);
    strictEqual(goneOwn.value.changedOthers.size, 0);
    // droppableIds に無い存在しない id は拒否
    rejects({ others: new Map([[A, file(A, [])]]) });
    rejects({ repoFile: file(B, []) });
  });
  it("reports a read-only common as such", () => {
    const r = applyPromotes(input({ common: file("common", [], true) }));
    strictEqual(r.ok, false);
    if (!r.ok) strictEqual(r.kind, "read-only");
  });
  it("draws a fresh id when the generator first returns an id already in common", () => {
    const existing = entry(0x500, { title: "unrelated" });
    const v = applied({ common: file("common", [existing]) });
    const created = v.common.entries.find((e) => e.id !== existing.id);
    strictEqual(created?.id, idOf(0x501));
  });
});

describe("promoteManually", () => {
  const manual = (
    over: Partial<Parameters<typeof promoteManually>[0]> = {},
  ) => {
    let counter = 0x600;
    return promoteManually({
      repoKey: B,
      today: "2026-10-15",
      repoFile: file(B, [
        entry(2, { title: "t", body: "b", seen: 3, repos: [B] }),
      ]),
      common: file("common", []),
      noPromote: open_,
      id: idOf(2),
      newId: () => idOf(counter++),
      ...over,
    });
  };
  it("moves the entry keeping seen and repos", () => {
    const r = manual();
    ok(r.ok);
    strictEqual(r.value.repoFile.entries.length, 0);
    const moved = r.value.common.entries[0];
    strictEqual(moved?.id, r.value.commonId);
    strictEqual(moved?.seen, 3);
    deepStrictEqual(moved?.repos, [B]);
    strictEqual(
      r.value.commitLines[0],
      `promote ${idOf(0x600)} <- ${idOf(2)} (${B})`,
    );
  });
  it("adds the full seen to a common entry with the same heading", () => {
    const r = manual({
      common: file("common", [entry(9, { title: "T", seen: 5, repos: [] })]),
    });
    ok(r.ok);
    strictEqual(r.value.common.entries.length, 1);
    strictEqual(r.value.common.entries[0]?.seen, 8);
    ok(r.value.commitLines[0]?.startsWith("promote merge "));
  });
  it("allows a URL in the body, since a person decides a manual promotion", () => {
    const r = manual({
      repoFile: file(B, [
        entry(2, {
          title: "t",
          body: "詳細は https://example.com/docs を参照",
          repos: [B],
        }),
      ]),
    });
    ok(r.ok);
    ok(r.value.common.entries[0]?.body.includes("https://example.com/docs"));
  });
  it("warns, without rejecting, when the text carries a repo name part", () => {
    const r = manual({
      repoFile: file(B, [
        entry(2, { title: "t", body: "works well in beta usage", repos: [B] }),
      ]),
    });
    ok(r.ok);
    strictEqual(r.value.warnings.length, 1);
  });
  it("rejects a no-promote match, an unreadable no-promote, an unknown id and bad text", () => {
    strictEqual(
      manual({ noPromote: { ok: true, patterns: ["github.com/org-b/*"] } }).ok,
      false,
    );
    strictEqual(manual({ noPromote: { ok: false, reason: "x" } }).ok, false);
    strictEqual(manual({ id: idOf(77) }).ok, false);
    strictEqual(
      manual({
        repoFile: file(B, [entry(2, { title: "#x", body: "b", repos: [B] })]),
      }).ok,
      false,
    );
  });
  it("evicts from a full common", () => {
    const full = Array.from({ length: 40 }, (_, i) =>
      entry(100 + i, { seen: 5 }),
    );
    const r = manual({ common: file("common", full) });
    ok(r.ok);
    strictEqual(r.value.common.entries.length, 40);
    ok(r.value.commitLines.some((l) => l.startsWith("evicted ")));
  });
  it("reports a read-only common", () => {
    const r = manual({ common: file("common", [], true) });
    strictEqual(r.ok, false);
    if (!r.ok) strictEqual(r.kind, "read-only");
  });
});

describe("buildCandidates", () => {
  const long = entry(3, {
    title: "long",
    body: "あ".repeat(300),
    updated: "2026-10-10",
  });
  it("cuts bodies at 120 characters, skips no-promote repos and never prints repo keys", () => {
    const secret = "github.com/org-c/secret-repo";
    const c = buildCandidates({
      repoKey: B,
      others: new Map([
        [A, file(A, [X, long])],
        [secret, file(secret, [entry(5, { title: "hidden" })])],
      ]),
      noPromote: { ok: true, patterns: ["local/*", "github.com/org-c/*"] },
    });
    strictEqual(c.ids.size, 2);
    ok(c.ids.has(X.id) && c.ids.has(long.id));
    const lines = c.text.split("\n");
    strictEqual(lines.length, 2);
    ok(lines.some((l) => l === `${long.id}: long — ${"あ".repeat(120)}`));
    ok(!c.text.includes("hidden"));
    ok(!c.text.includes("github.com"));
    ok(!c.text.includes("alpha"));
  });
  it("is empty when the current repo matches no-promote or no-promote is unreadable", () => {
    const others = new Map([[A, file(A, [X])]]);
    strictEqual(
      buildCandidates({
        repoKey: B,
        others,
        noPromote: { ok: true, patterns: ["github.com/org-b/*"] },
      }).ids.size,
      0,
    );
    strictEqual(
      buildCandidates({
        repoKey: B,
        others,
        noPromote: { ok: false, reason: "x" },
      }).text,
      "",
    );
  });
  it("keeps the 200 most recently updated entries", () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      entry(1000 + i, {
        updated: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      }),
    );
    const c = buildCandidates({
      repoKey: B,
      others: new Map([[A, file(A, many)]]),
      noPromote: open_,
    });
    strictEqual(c.ids.size, 200);
    ok(!c.ids.has(many[0]?.id ?? ""), "the oldest is dropped");
    ok(c.ids.has(many[200]?.id ?? ""));
  });
});
