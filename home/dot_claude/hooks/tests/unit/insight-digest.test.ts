#!/usr/bin/env -S bun test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import {
  extractInsights,
  hashInsight,
  hashSessionId,
  INSIGHT_DELIMITER_PATTERN,
  normalize,
  sanitize,
} from "../../lib/insight-digest.ts";

const STAR = String.fromCharCode(0x2605);
const HBAR = String.fromCharCode(0x2500);

function makeInsightBlock(body: string): string {
  return `${STAR} Insight ${HBAR.repeat(40)}\n${body}\n${HBAR.repeat(40)}`;
}

describe("normalize", () => {
  it("preserves repeatable hashing across whitespace variants", () => {
    const a = normalize("Hello   World\r\nFoo\tBar");
    const b = normalize("hello world\nfoo bar");
    strictEqual(a, b);
  });

  it("converts CRLF and Unicode line separators to LF", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const a = normalize(`alpha${ls}beta${ps}gamma\r\ndelta`);
    strictEqual(a, "alpha\nbeta\ngamma\ndelta");
  });

  it("collapses NBSP and ideographic space to ASCII space", () => {
    const nbsp = String.fromCharCode(0xa0);
    const ideo = String.fromCharCode(0x3000);
    const a = normalize(`x${nbsp}y${ideo}z`);
    strictEqual(a, "x y z");
  });

  it("lowercases and trims lines", () => {
    strictEqual(normalize("  HELLO  \n  WORLD  "), "hello\nworld");
  });
});

describe("sanitize", () => {
  it("redacts API key patterns", () => {
    const samples = [
      "sk-ant-api03-abcdefghij1234567890ABCDEFGHIJK",
      "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "AKIA1234567890ABCDEF",
      "Authorization: Bearer eyJabc.def.ghi",
    ];
    for (const s of samples) {
      const { text, hits } = sanitize(s);
      ok(hits >= 1, `expected hit for ${s}`);
      ok(text.includes("[REDACTED]"), `expected REDACTED in ${text}`);
    }
  });

  it("does not redact harmless prose", () => {
    const { hits } = sanitize("This is a normal sentence with no secrets.");
    strictEqual(hits, 0);
  });

  it("redacts .env-style lines but not inline assignments", () => {
    const result = sanitize("API_TOKEN=abc123def456\nx = y");
    ok(result.text.includes("[REDACTED]"));
    ok(!result.text.includes("abc123def456"));
  });

  it("respects extra patterns", () => {
    const { hits, text } = sanitize("internal-corp-id-12345", [
      /internal-corp-id-\d+/g,
    ]);
    strictEqual(hits, 1);
    ok(text.includes("[REDACTED]"));
  });
});

describe("extractInsights", () => {
  it("returns body of a single insight block", () => {
    const text = `before\n${makeInsightBlock("- bullet 1\n- bullet 2")}\nafter`;
    const insights = extractInsights(text);
    strictEqual(insights.length, 1);
    ok(insights[0]?.includes("bullet 1"));
  });

  it("returns multiple blocks", () => {
    const text = `${makeInsightBlock("first")}\n\n${makeInsightBlock("second")}`;
    const insights = extractInsights(text);
    strictEqual(insights.length, 2);
    deepStrictEqual(insights, ["first", "second"]);
  });

  it("returns empty array when no marker", () => {
    deepStrictEqual(extractInsights("plain text"), []);
  });
});

describe("hashing", () => {
  it("hashInsight is deterministic and 16 hex chars", () => {
    const a = hashInsight(normalize("Hello world"));
    const b = hashInsight(normalize("hello   world"));
    strictEqual(a, b);
    strictEqual(a.length, 16);
    ok(/^[0-9a-f]{16}$/.test(a));
  });

  it("hashSessionId yields 12 hex chars", () => {
    const h = hashSessionId("7908d1f8-12c2-4e72-b9f1-92675affdbf7");
    strictEqual(h.length, 12);
    ok(/^[0-9a-f]{12}$/.test(h));
  });
});

describe("INSIGHT_DELIMITER_PATTERN", () => {
  it("has g flag", () => {
    ok(INSIGHT_DELIMITER_PATTERN.flags.includes("g"));
  });
});
