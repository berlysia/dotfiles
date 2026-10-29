#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { liveness } from "../../lib/sessions/liveness.ts";

// Fields 3..21 are 19 tokens (state + 18 numbers), then field 22 is starttime.
const statLine = (comm: string, startTime: string, filler = 18): string =>
  `1234 (${comm}) S ${Array.from({ length: filler }, () => "1").join(" ")} ${startTime} 999 888`;

const throwing = (code: string) => (): string => {
  throw Object.assign(new Error(code), { code });
};

describe("liveness", () => {
  it("is alive when the 20th token after the last ) matches, even if comm contains )", () => {
    strictEqual(
      liveness(1234, "43648818", () => statLine("a) b", "43648818")),
      "alive",
    );
  });
  it("is dead when the start time differs (recycled pid)", () => {
    strictEqual(
      liveness(1234, "1", () => statLine("a) b", "43648818")),
      "dead",
    );
  });
  it("is unknown when fewer than 20 tokens follow the last )", () => {
    // 19 tokens: state + 17 fillers + starttime
    strictEqual(
      liveness(1234, "5", () => statLine("a", "5", 17).split(" 999")[0]!),
      "unknown",
    );
  });
  it("is unknown without a )", () => {
    strictEqual(
      liveness(1234, "1", () => "garbage"),
      "unknown",
    );
  });
  it("is dead on ENOENT and ESRCH", () => {
    strictEqual(liveness(1234, "1", throwing("ENOENT")), "dead");
    strictEqual(liveness(1234, "1", throwing("ESRCH")), "dead");
  });
  it("is unknown on EACCES and on an error without a code", () => {
    strictEqual(liveness(1234, "1", throwing("EACCES")), "unknown");
    strictEqual(
      liveness(1234, "1", () => {
        throw new Error("boom");
      }),
      "unknown",
    );
  });
  it("reads field 22 of this machine's /proc/self/stat", (t) => {
    let line: string;
    try {
      line = readFileSync("/proc/self/stat", "utf8");
    } catch {
      t.skip("no /proc");
      return;
    }
    const after = line
      .slice(line.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    strictEqual(
      liveness(1, after[19]!, () => line),
      "alive",
    );
  });
});
