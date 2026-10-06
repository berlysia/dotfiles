import { ok } from "node:assert";
import { describe, it } from "node:test";
import {
  entriesWithSpec,
  genericShapes,
} from "../support/linear-match-rules.ts";

describe("adversarial inputs run in linear time", () => {
  for (const { matcher, rule } of entriesWithSpec()) {
    it(`generic shapes: ${rule.source}`, () => {
      for (const shape of [
        ...genericShapes(rule),
        ...rule.perf.map((make) => make()),
      ]) {
        const start = performance.now();
        matcher.test(shape);
        const elapsed = performance.now() - start;
        ok(
          elapsed < 1000,
          `${elapsed} ms for ${JSON.stringify(shape.slice(0, 40))}`,
        );
      }
    });
  }
});
