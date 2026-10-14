import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { parseLlmOps } from "../../lib/agent-learnings/core/llm-ops.ts";

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
      wrap([
        {
          op: "promote",
          matchId: ID,
          title: "t",
          body: "b",
          evidence: "e",
        },
      ]),
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
