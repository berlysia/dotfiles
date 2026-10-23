#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  formatExtensionLogLine,
  formatExtensionTally,
  parseExtensionLog,
  sanitizeExtensionReason,
  tallyExtensions,
} from "../../lib/round-extension-log.ts";

const AT = "2026-10-01T00:00:00.000Z";
const row = (...columns: Array<string | number>) => columns.join("\t");

describe("round-extension-log: format", () => {
  it("writes six columns, with - as the cause of a non-self approver", () => {
    const at = new Date(AT);
    assert.equal(
      formatExtensionLogLine({
        at,
        doc: "spec.md",
        round: 4,
        approver: "self",
        reason: "r",
        cause: "blocker",
      }),
      row(AT, "spec.md", 4, "self", "r", "blocker"),
    );
    assert.equal(
      formatExtensionLogLine({
        at,
        doc: "spec.md",
        round: 4,
        approver: "human",
        reason: "r",
      }),
      row(AT, "spec.md", 4, "human", "r", "-"),
    );
  });

  it("flattens separators so the line stays six columns", () => {
    const line = formatExtensionLogLine({
      at: new Date(AT),
      doc: "spec.md",
      round: 4,
      approver: "self",
      reason: "a\tb\nc\u0085d\r\ne f",
      cause: "landing",
    });
    assert.equal(line.split("\t").length, 6);
    assert.equal(line.includes("\n"), false);
    assert.equal(sanitizeExtensionReason("  x  "), "x");
    assert.equal(sanitizeExtensionReason("x".repeat(600)).length, 500);
  });
});

describe("round-extension-log: parse and tally", () => {
  const log = [
    row(AT, "spec.md", 4, "x legacy reason"), // 4 columns: human
    row(AT, "spec.md", 5, "self", "five columns"), // 5 columns: self, cause unknown
    row(AT, "spec.md", 6, "self", "r", "blocker"),
    row(AT, "spec.md", 7, "self", "r", "landing"),
    row(AT, "spec.md", 8, "reframer", "r", "-"),
    "",
    row(AT, "spec.md", 9, "self", "r", "landing", "extra"), // 7 columns
    row(AT, "spec.md", 10, "self", "r", "-"), // self without a cause
    row(AT, "spec.md", 11, "human", "r", "landing"), // human with a cause
  ].join("\n");

  it("counts by column count and drops malformed rows", () => {
    const tally = tallyExtensions(parseExtensionLog(log), "spec.md", 0);
    assert.deepEqual(tally, {
      human: 1,
      self: 3,
      reframer: 1,
      selfCauses: {
        landing: 1,
        "kd-changed": 0,
        blocker: 1,
        "not-narrowing": 0,
        unknown: 1,
      },
    });
  });

  it("counts only the current cycle: rows above the last pass round are dropped", () => {
    const tally = tallyExtensions(parseExtensionLog(log), "spec.md", 6);
    assert.equal(tally.human, 0);
    assert.equal(tally.self, 1);
    assert.equal(tally.reframer, 1);
  });

  it("with no pass marker (pass round 0) every row of the doc counts", () => {
    assert.equal(tallyExtensions(parseExtensionLog(log), "spec.md", 0).self, 3);
  });

  it("counts only the named doc", () => {
    const mixed = [
      row(AT, "spec.md", 4, "self", "r", "landing"),
      row(AT, "plan-1.md", 4, "self", "r", "landing"),
      row(AT, "plan-1.md", 5, "human", "r", "-"),
    ].join("\n");
    const rows = parseExtensionLog(mixed);
    assert.equal(tallyExtensions(rows, "spec.md", 0).self, 1);
    assert.equal(tallyExtensions(rows, "plan-1.md", 0).human, 1);
    assert.equal(tallyExtensions(rows, "plan-2.md", 0).self, 0);
  });

  it("drops rows with 3 or fewer columns, an unknown approver or a non-numeric round", () => {
    const bad = [
      row(AT, "spec.md", 4),
      row(AT, "spec.md", "x", "self", "r", "landing"),
      row(AT, "spec.md", 4, "robot", "r", "-"),
      row(AT, "spec.md", 4, "robot", "r"),
    ].join("\n");
    const tally = tallyExtensions(parseExtensionLog(bad), "spec.md", 0);
    assert.equal(tally.human + tally.self + tally.reframer, 0);
  });

  it("splits on LF and TAB only (a CR stays inside its column)", () => {
    const crlf = `${row(AT, "spec.md", 4, "self", "r", "landing")}\r\n`;
    // The CR sticks to the cause, which is then not one of the four values.
    assert.equal(
      tallyExtensions(parseExtensionLog(crlf), "spec.md", 0).self,
      0,
    );
  });
});

describe("round-extension-log: formatExtensionTally", () => {
  const empty = tallyExtensions([], "spec.md", 0);

  it("is null with no extension", () => {
    assert.equal(formatExtensionTally(empty), null);
  });

  it("renders approver and cause counts on one line", () => {
    const rows = parseExtensionLog(
      [
        row(AT, "spec.md", 4, "self", "r", "landing"),
        row(AT, "spec.md", 5, "self", "r", "kd-changed"),
        row(AT, "spec.md", 6, "self", "five"),
        row(AT, "spec.md", 7, "reframer", "r", "-"),
      ]
        .join("\n")
        .replace("self\tfive", "self\tfive"),
    );
    assert.equal(
      formatExtensionTally(tallyExtensions(rows, "spec.md", 0)),
      "延長: human 0 / self 3（landing 1、kd-changed 1、blocker 0、not-narrowing 0、不明 1）/ reframer 1",
    );
  });
});
