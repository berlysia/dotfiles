#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runHookTimingCli } from "../../cli/hook-timing.ts";

const deps = {
  logDir: "/nonexistent",
  now: new Date("2026-10-29T00:00:00Z"),
  readFileIfExists: () => {
    throw new Error("help must not read the log");
  },
};

describe("hook-timing --help", () => {
  it("prints usage on stdout with exit 0 for -h and --help", () => {
    for (const flag of ["-h", "--help"]) {
      const r = runHookTimingCli([flag], deps);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /usage/);
      assert.equal(r.stderr, "");
    }
  });

  it("keeps exit 2 on stderr for other argument errors", () => {
    const r = runHookTimingCli(["--bogus"], deps);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /unrecognized argument/);
  });
});
