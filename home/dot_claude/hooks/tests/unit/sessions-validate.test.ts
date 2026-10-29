#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateSession } from "../../lib/sessions/validate-session.ts";

const FIXTURE = readFileSync(
  new URL("../fixtures/sessions/dir-basic/201.json", import.meta.url),
  "utf8",
);
const base = JSON.parse(FIXTURE) as Record<string, unknown>;
const withFields = (patch: Record<string, unknown>): string =>
  JSON.stringify({ ...base, ...patch });
const without = (key: string): string => {
  const copy = { ...base };
  delete copy[key];
  return JSON.stringify(copy);
};

describe("validateSession", () => {
  it("accepts the fixture and returns only the six fields", () => {
    const result = validateSession(FIXTURE, 201);
    deepStrictEqual(result, {
      ok: true,
      value: {
        pid: 201,
        procStart: "100201",
        sessionId: "00000000-0000-4000-8000-000000000201",
        cwd: "/fixture/repo-a",
        name: "alpha",
        status: "idle",
      },
    });
  });

  it("rejects a pid that differs from the file name", () => {
    deepStrictEqual(validateSession(FIXTURE, 999), { ok: false });
  });

  for (const pid of [0, -1, 1.5, 2 ** 53, "201"]) {
    it(`rejects pid ${String(pid)}`, () => {
      const filePid = typeof pid === "number" ? pid : 201;
      strictEqual(validateSession(withFields({ pid }), filePid).ok, false);
    });
  }

  it("maps an unknown status to unknown", () => {
    const result = validateSession(withFields({ status: "paused" }), 201);
    strictEqual(result.ok && result.value.status, "unknown");
  });
  for (const status of ["busy", "waiting"]) {
    it(`keeps status ${status}`, () => {
      const result = validateSession(withFields({ status }), 201);
      strictEqual(result.ok && result.value.status, status);
    });
  }
  it("rejects a missing status", () => {
    strictEqual(validateSession(without("status"), 201).ok, false);
  });
  it("rejects a non-string status", () => {
    strictEqual(validateSession(withFields({ status: 1 }), 201).ok, false);
  });

  for (const name of [42, null, ["x"]]) {
    it(`maps name ${JSON.stringify(name)} to null`, () => {
      const result = validateSession(withFields({ name }), 201);
      strictEqual(result.ok, true);
      strictEqual(result.ok && result.value.name, null);
    });
  }
  it("maps a missing name to null", () => {
    const result = validateSession(without("name"), 201);
    strictEqual(result.ok && result.value.name, null);
  });

  it("lower-cases an upper-case UUID", () => {
    const result = validateSession(
      withFields({ sessionId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" }),
      201,
    );
    strictEqual(
      result.ok && result.value.sessionId,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
  });
  for (const sessionId of [
    "not-a-uuid",
    5,
    "00000000-0000-4000-8000-00000000020z",
  ]) {
    it(`rejects sessionId ${String(sessionId)}`, () => {
      strictEqual(validateSession(withFields({ sessionId }), 201).ok, false);
    });
  }

  for (const cwd of [
    "relative/path",
    "/a\u0000b",
    "/a\nb",
    "/a\u007fb",
    "/a\u0085b",
    5,
    "",
  ]) {
    it(`rejects cwd ${JSON.stringify(cwd)}`, () => {
      strictEqual(validateSession(withFields({ cwd }), 201).ok, false);
    });
  }

  for (const procStart of ["1".repeat(21), "", "12a", 123, "-1", " 1"]) {
    it(`rejects procStart ${JSON.stringify(procStart)}`, () => {
      strictEqual(validateSession(withFields({ procStart }), 201).ok, false);
    });
  }
  it("accepts a 20-digit procStart", () => {
    strictEqual(
      validateSession(withFields({ procStart: "1".repeat(20) }), 201).ok,
      true,
    );
  });

  const nonObjects: ReadonlyArray<readonly [string, string]> = [
    ["array", "[]"],
    ["null", "null"],
    ["truncated", "{"],
    ["number", "5"],
    ["deep unclosed", "[".repeat(65536)],
    ["deep closed", "[".repeat(32768) + "]".repeat(32768)],
  ];
  for (const [label, text] of nonObjects) {
    it(`rejects ${label} without throwing`, () => {
      deepStrictEqual(validateSession(text, 201), { ok: false });
    });
  }
});
