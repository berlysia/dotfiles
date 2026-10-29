#!/usr/bin/env node --test

// Self-consistency of the fixtures under tests/fixtures/sessions/.
//
// cli-output.v1*.json are the frozen --json v1 contract, written by hand and
// reviewed; they are not saved CLI output. dir-basic.inject.json is not a
// contract: it is the input that reproduces v1. When you change the inject
// table, look at the cli-output.v1*.json diff by eye in the same change; do
// not rewrite both together, or a contract-breaking change passes.
//
// V1_TOP_KEYS / V1_ROW_KEYS and the SHA-256 table below are fixed on purpose
// and must not follow the current types. Adding a field to SessionList does not
// touch this file; changing a frozen file does, which makes the break visible
// in review.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../fixtures/sessions/", import.meta.url));
const read = (name: string) => readFileSync(join(root, name), "utf8");
const readJson = (name: string) =>
  JSON.parse(read(name)) as Record<string, any>;

const V1_TOP_KEYS = [
  "invalid",
  "runningVersion",
  "scanned",
  "schemaVersion",
  "selfFound",
  "sessions",
  "shapeSuspect",
  "skipped",
  "verifiedWith",
];
const V1_ROW_KEYS = [
  "addressable",
  "branch",
  "duplicateName",
  "isSelf",
  "liveness",
  "name",
  "repo",
  "repoStatus",
  "sessionId",
  "status",
  "worktree",
];
const FROZEN_SHA256: Record<string, string> = {
  "cli-output.v1.json":
    "71febd64a42870026882742068508b8499afdbd619f4fecc02f0f43e3484759a",
  "cli-output.v1-self.json":
    "0f055fc4d33a0cdd9fcec3d20f677ee3921d1f8773ffcab44adf0d0920ef49d9",
  "cli-output.v1-extended.json":
    "978f6cefc721418a4c8b99546abc731b2845bc087df836d15d79ea299b9ac878",
  "cli-output.v1-degraded.json":
    "0c32f4a3678ed085f1a781f5234cbe454f7436e2d3debffc3c3fa1a39edc6f5d",
};

const listFiles = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
const sorted = (keys: string[]) => [...keys].sort();
const isSortedByCodeUnit = (ids: string[]) =>
  ids.every((id, i) => i === 0 || (ids[i - 1] as string) < id);

describe("sessions fixtures", () => {
  it("contain no home path, user name or non-zero 64-digit hex", () => {
    for (const file of listFiles("")) {
      const text = read(file);
      const label = `${file}`;
      ok(!text.includes("/home/"), `${label}: /home/`);
      ok(!text.includes("berlysia"), `${label}: user name`);
      for (const hex of `${file}\n${text}`.match(/[0-9a-f]{64}/g) ?? []) {
        ok(/^0+$/.test(hex), `${label}: non-zero 64-digit hex`);
      }
    }
  });

  it("dir-basic: the file name digits equal pid in every json", () => {
    const names = readdirSync(join(root, "dir-basic")).filter((n) =>
      n.endsWith(".json"),
    );
    deepStrictEqual(names.sort(), [
      "201.json",
      "202.json",
      "203.json",
      "204.json",
      "205.json",
    ]);
    for (const name of names) {
      const json = readJson(`dir-basic/${name}`);
      strictEqual(String(json.pid), name.replace(".json", ""), name);
    }
  });

  it("v1-extended reduces to v1 once futureField and the 3 unknown values are reverted", () => {
    const extended = readJson("cli-output.v1-extended.json");
    const v1 = readJson("cli-output.v1.json");
    ok("futureField" in extended);
    delete extended.futureField;
    const row = extended.sessions[0];
    const v1Row = v1.sessions[0];
    strictEqual(row.status, "sleeping");
    strictEqual(row.liveness, "zombie");
    strictEqual(row.repoStatus, "submodule");
    row.status = v1Row.status;
    row.liveness = v1Row.liveness;
    row.repoStatus = v1Row.repoStatus;
    deepStrictEqual(extended, v1);
  });

  it("v1 and v1-self have exactly the frozen top and row keys", () => {
    for (const name of ["cli-output.v1.json", "cli-output.v1-self.json"]) {
      const json = readJson(name);
      deepStrictEqual(sorted(Object.keys(json)), V1_TOP_KEYS, name);
      for (const row of json.sessions) {
        deepStrictEqual(sorted(Object.keys(row)), V1_ROW_KEYS, name);
      }
    }
  });

  it("v1-degraded is a degraded shape with the frozen top keys", () => {
    const json = readJson("cli-output.v1-degraded.json");
    deepStrictEqual(sorted(Object.keys(json)), V1_TOP_KEYS);
    strictEqual(json.selfFound, false);
    strictEqual(json.shapeSuspect, true);
    strictEqual(json.runningVersion, null);
    ok(json.skipped > 0);
    ok(Array.isArray(json.sessions));
  });

  it("v1-self marks only the 201 row as self", () => {
    const json = readJson("cli-output.v1-self.json");
    strictEqual(json.selfFound, true);
    deepStrictEqual(
      json.sessions.filter((r: any) => r.isSelf).map((r: any) => r.sessionId),
      [readJson("dir-basic/201.json").sessionId],
    );
  });

  it("unknown-schema has a schemaVersion no real version reaches and a non-array sessions", () => {
    const json = readJson("cli-output.unknown-schema.json");
    strictEqual(json.schemaVersion, 999);
    ok(!Array.isArray(json.sessions));
  });

  it("v1, v1-self and v1-extended list sessions in ascending sessionId order", () => {
    for (const name of [
      "cli-output.v1.json",
      "cli-output.v1-self.json",
      "cli-output.v1-extended.json",
    ]) {
      const ids = readJson(name).sessions.map((r: any) => r.sessionId);
      ok(isSortedByCodeUnit(ids), name);
    }
  });

  it("frozen v1 files keep their SHA-256", () => {
    for (const [name, expected] of Object.entries(FROZEN_SHA256)) {
      strictEqual(
        createHash("sha256")
          .update(readFileSync(join(root, name)))
          .digest("hex"),
        expected,
        `${name} is a frozen contract: add cli-output.v2*.json instead of editing it`,
      );
    }
  });

  it("order-for-display cases: expected is a permutation of the input sessionIds", () => {
    const cases = JSON.parse(read("order-for-display.cases.json")) as Array<{
      name: string;
      rows: Array<{ sessionId: string }>;
      expected: string[];
    }>;
    ok(cases.length > 0);
    for (const c of cases) {
      deepStrictEqual(
        sorted(c.expected),
        sorted(c.rows.map((r) => r.sessionId)),
        c.name,
      );
    }
  });
});
