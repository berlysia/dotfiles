#!/usr/bin/env node --test

import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { orderForDisplay } from "../../lib/sessions/order-for-display.ts";
import { FIXTURES } from "../support/sessions-inject.ts";

type Case = {
  name: string;
  rows: Array<{ sessionId: string; repo: string | null }>;
  baseRepo: string | null;
  expected: string[];
};
const cases = JSON.parse(
  readFileSync(`${FIXTURES}order-for-display.cases.json`, "utf8"),
) as Case[];

describe("orderForDisplay", () => {
  for (const c of cases) {
    it(c.name, () => {
      const ordered = orderForDisplay(c.rows, c.baseRepo);
      deepStrictEqual(
        ordered.map((row) => row.sessionId),
        c.expected,
      );
    });
  }

  it("does not mutate the input", () => {
    const rows = [
      { sessionId: "b", repo: null },
      { sessionId: "a", repo: null },
    ];
    orderForDisplay(rows, null);
    deepStrictEqual(
      rows.map((row) => row.sessionId),
      ["b", "a"],
    );
  });

  it("a null repo never matches a null base", () => {
    const rows = [
      { sessionId: "b", repo: "/r" },
      { sessionId: "a", repo: null },
    ];
    deepStrictEqual(
      orderForDisplay(rows, null).map((row) => row.sessionId),
      ["a", "b"],
    );
  });
});
