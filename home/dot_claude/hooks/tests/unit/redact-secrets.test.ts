#!/usr/bin/env -S bun test

import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import {
  COMPACTION_EXTRA_PATTERNS,
  sanitize,
} from "../../lib/redact-secrets.ts";

const AIZA = `AIza${"A".repeat(35)}`;
const NPM = `npm_${"a".repeat(36)}`;
const GLPAT = `glpat-${"a".repeat(20)}`;
const ANT = `sk-ant-${"x".repeat(30)}`;
const RSA_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----";

describe("sanitize default patterns", () => {
  it("redacts known secret shapes without leaving the secret", () => {
    const samples: Array<[string, string]> = [
      [ANT, ANT],
      [AIZA, AIZA],
      [NPM, NPM],
      [GLPAT, GLPAT],
      ["https://user:pass@example.com", "user:pass"],
      [RSA_KEY, "MIIabc"],
    ];
    for (const [input, secret] of samples) {
      const { text, hits } = sanitize(input);
      ok(hits >= 1, `expected hit for ${input}`);
      ok(text.includes("[REDACTED]"), `expected REDACTED in ${text}`);
      ok(!text.includes(secret), `secret leaked in ${text}`);
    }
  });

  it("keeps the URL host when redacting userinfo", () => {
    const { text } = sanitize("clone https://user:pass@example.com/repo.git");
    ok(text.includes("example.com/repo.git"));
  });

  it("does not redact harmless prose or plain URLs", () => {
    strictEqual(sanitize("a normal sentence").hits, 0);
    strictEqual(sanitize("see https://example.com/path@x").hits, 0);
  });

  it("applies extra patterns and adds the g flag when missing", () => {
    const { hits } = sanitize("corp-1 corp-2", [/corp-\d/]);
    strictEqual(hits, 2);
  });
});

describe("COMPACTION_EXTRA_PATTERNS", () => {
  it("redacts assignments, headers and JSON-shaped secrets", () => {
    const samples: Array<[string, string[]]> = [
      ["token: abc123", ["abc123"]],
      ["export AWS_SECRET_ACCESS_KEY=xyz", ["xyz"]],
      ["Authorization: Basic Zm9v", ["Zm9v"]],
      ['{"password": "two words"}', ["two", "words"]],
      ["Cookie: sid=abc", ["sid=abc"]],
    ];
    for (const [input, leaks] of samples) {
      const { text, hits } = sanitize(input, COMPACTION_EXTRA_PATTERNS);
      ok(hits >= 1, `expected hit for ${input}`);
      ok(text.includes("[REDACTED]"), `expected REDACTED in ${text}`);
      for (const leak of leaks) {
        ok(!text.includes(leak), `"${leak}" leaked in ${text}`);
      }
    }
  });

  it("is not part of the default set", () => {
    strictEqual(sanitize("token: 1M").hits, 0);
  });
});
