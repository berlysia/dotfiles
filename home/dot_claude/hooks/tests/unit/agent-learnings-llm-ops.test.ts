import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  checkOpGroups,
  parseLlmOps,
} from "../../lib/agent-learnings/core/llm-ops.ts";

const ID = "L-0123456789ab";
const wrap = (ops: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 1, ops, ...extra });
const add = (n = 0) => ({
  op: "add",
  title: `t${n}`,
  body: "b",
  evidence: "e",
});

describe("parseLlmOps", () => {
  it("extracts the first json fence from a response with prose around it", () => {
    const text = `前置き\n\`\`\`json\n${wrap([add()])}\n\`\`\`\n後書き \`\`\`json\n${wrap([])}\n\`\`\``;
    const r = parseLlmOps(text);
    ok(r.ok);
    strictEqual(r.ops.length, 1);
    deepStrictEqual(r.ops[0], add());
  });
  it("accepts an unfenced whole-response object", () => {
    const r = parseLlmOps('{"schemaVersion":1,"ops":[]}');
    ok(r.ok);
    deepStrictEqual(r.ops, []);
  });
  it("accepts well-formed update and remove", () => {
    const r = parseLlmOps(
      wrap([
        { op: "update", id: ID, evidence: "e" },
        {
          op: "update",
          id: "L-aaaaaaaaaaaa",
          title: "t",
          body: "b",
          evidence: "e",
        },
        { op: "remove", id: "L-bbbbbbbbbbbb", reason: "r" },
      ]),
    );
    ok(r.ok);
    strictEqual(r.ops.length, 3);
  });
  it("rejects malformed responses as a whole", () => {
    const bad: string[] = [
      wrap([], { schemaVersion: 2 }).replace('"schemaVersion":1,', ""),
      JSON.stringify({ schemaVersion: 2, ops: [] }),
      JSON.stringify({ schemaVersion: 1, ops: [], extra: 1 }),
      JSON.stringify({ schemaVersion: 1 }),
      wrap([{ op: "rename", id: ID }]),
      wrap([{ op: "add", title: "t", body: "b" }]),
      wrap([{ op: "remove", id: ID, reason: "r", extra: 1 }]),
      wrap([{ op: "remove", id: 123, reason: "r" }]),
      wrap([{ op: "remove", id: "L-XYZ", reason: "r" }]),
      wrap([{ op: "update", id: ID, title: null, evidence: "e" }]),
      wrap([{ op: "update", id: ID, title: "t" }]),
      wrap([{ op: "update", id: ID, evidence: "e", extra: 1 }]),
      wrap([null]),
      wrap(["add"]),
      "not json",
      "",
    ];
    for (const text of bad) strictEqual(parseLlmOps(text).ok, false, text);
  });
  it("rejects more than 20 ops", () => {
    strictEqual(
      parseLlmOps(wrap(Array.from({ length: 21 }, (_, i) => add(i)))).ok,
      false,
    );
    ok(parseLlmOps(wrap(Array.from({ length: 20 }, (_, i) => add(i)))).ok);
  });
  it("allows up to 5 removes", () => {
    const remove = (n: number) => ({
      op: "remove",
      id: `L-00000000000${n}`,
      reason: "r",
    });
    strictEqual(parseLlmOps(wrap([1, 2, 3, 4, 5, 6].map(remove))).ok, false);
    ok(parseLlmOps(wrap([1, 2, 3, 4, 5].map(remove))).ok);
  });
});

describe("parseLlmOps promote", () => {
  const MATCH = "L-aaaaaaaaaaaa";
  const promote = (over: Record<string, unknown> = {}) => ({
    op: "promote",
    matchId: MATCH,
    title: "t",
    body: "b",
    evidence: "e",
    ...over,
  });
  it("splits add and promote into separate groups", () => {
    const r = parseLlmOps(wrap([add(), promote()]));
    ok(r.ok);
    deepStrictEqual(r.ops, [add()]);
    deepStrictEqual(r.promotes, [promote()]);
  });
  it("accepts an optional id", () => {
    const r = parseLlmOps(wrap([promote({ id: ID })]));
    ok(r.ok);
    strictEqual(r.promotes[0]?.id, ID);
  });
  it("rejects extra keys, a missing matchId, a null id and malformed ids", () => {
    for (const bad of [
      promote({ extra: 1 }),
      { op: "promote", title: "t", body: "b", evidence: "e" },
      promote({ id: null }),
      promote({ id: "L-XYZ" }),
      promote({ matchId: "L-XYZ" }),
      promote({ matchId: 1 }),
      promote({ evidence: undefined }),
    ])
      strictEqual(parseLlmOps(wrap([bad])).ok, false, JSON.stringify(bad));
  });
  it("allows 3 promotes and rejects 4", () => {
    const n = (i: number) => promote({ matchId: `L-00000000000${i}` });
    ok(parseLlmOps(wrap([1, 2, 3].map(n))).ok);
    strictEqual(parseLlmOps(wrap([1, 2, 3, 4].map(n))).ok, false);
  });
  it("counts promotes in the 20-op limit", () => {
    const ops = [
      ...Array.from({ length: 19 }, (_, i) => add(i)),
      promote(),
      promote({ matchId: "L-bbbbbbbbbbbb" }),
    ];
    strictEqual(parseLlmOps(wrap(ops)).ok, false);
  });
});

describe("checkOpGroups", () => {
  const MATCH = "L-aaaaaaaaaaaa";
  const OWN = "L-cccccccccccc";
  const promotes = [
    {
      op: "promote" as const,
      matchId: MATCH,
      id: OWN,
      title: "Shared Heading",
      body: "b",
      evidence: "e",
    },
  ];
  const candidates = new Set([MATCH, "L-dddddddddddd"]);
  const check = (ops: Parameters<typeof checkOpGroups>[0]) =>
    checkOpGroups(ops, promotes, candidates, []);
  it("accepts unrelated ops", () => {
    ok(
      check([
        { op: "add", title: "other", body: "b", evidence: "e" },
        { op: "update", id: "L-eeeeeeeeeeee", evidence: "e" },
      ]).ok,
    );
  });
  it("rejects update or remove of a promote's matchId or id", () => {
    strictEqual(check([{ op: "remove", id: MATCH, reason: "r" }]).ok, false);
    strictEqual(
      check([{ op: "update", id: OWN, body: "b", evidence: "e" }]).ok,
      false,
    );
  });
  it("rejects update or remove of any shown candidate id", () => {
    strictEqual(
      check([{ op: "update", id: "L-dddddddddddd", body: "b", evidence: "e" }])
        .ok,
      false,
    );
    strictEqual(
      check([{ op: "remove", id: "L-dddddddddddd", reason: "r" }]).ok,
      false,
    );
  });
  it("rejects an add whose heading matches a promote's after normalization", () => {
    strictEqual(
      check([
        { op: "add", title: "shared   heading", body: "b", evidence: "e" },
      ]).ok,
      false,
    );
  });
  it("does nothing without promotes", () => {
    ok(
      checkOpGroups(
        [{ op: "remove", id: MATCH, reason: "r" }],
        [],
        candidates,
        [],
      ).ok,
    );
  });
});

describe("parseLlmOps with on", () => {
  const upd = (on: unknown) => ({
    op: "update",
    id: ID,
    evidence: "e",
    on,
  });
  it("accepts on for add and update", () => {
    const r = parseLlmOps(
      wrap([{ ...add(), on: ["cmd:git"] }, upd(["path:.claude/x"])]),
    );
    ok(r.ok);
    strictEqual(r.ops.length, 2);
    const first = r.ops[0];
    ok(first?.op === "add" && first.on?.length === 1);
    const second = r.ops[1];
    ok(second?.op === "update" && second.on?.length === 1);
    ok(second.title === undefined && second.body === undefined);
  });
  it("keeps ops without on free of an on key", () => {
    const r = parseLlmOps(wrap([add()]));
    ok(r.ok);
    deepStrictEqual(r.ops[0], add());
  });
  it("rejects the whole response for a malformed on", () => {
    for (const on of ["cmd:git commit", [1], ["cmd:Git"], ["a", "b"]]) {
      strictEqual(parseLlmOps(wrap([{ ...add(), on }])).ok, false);
      strictEqual(parseLlmOps(wrap([upd(on)])).ok, false);
    }
  });
  it("rejects on in a promote", () => {
    const promote = {
      op: "promote",
      matchId: "L-aaaaaaaaaaaa",
      title: "t",
      body: "b",
      evidence: "e",
      on: ["session"],
    };
    strictEqual(parseLlmOps(wrap([promote])).ok, false);
  });
  it("counts an on-only update toward the 20 op limit", () => {
    const ops = Array.from({ length: 21 }, () => upd(["session"]));
    strictEqual(parseLlmOps(wrap(ops)).ok, false);
  });
});
