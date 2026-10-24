import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  HASHED_PROFILE_FIELDS,
  loadProfiles,
  PROFILE_FIELDS,
  resolveModules,
  UNHASHED_PROFILE_FIELDS,
  validateProfiles,
} from "../../../japanese-check/profiles.ts";
import type { ProfileRow } from "../../../japanese-check/profiles.ts";
import { GENRES, READERS, STRUCTURES } from "../../../japanese-check/types.ts";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "x-row",
    label: "見出し",
    signals: ["手がかり"],
    structure: "business",
    action: false,
    stockBoundary: false,
    ...overrides,
  };
}
const defaults = () => [
  row({ id: "rewrite-default", structure: "keep" }),
  row({ id: "compose-default" }),
];

function rowsOf(): ProfileRow[] {
  const loaded = loadProfiles();
  assert.ok(loaded.ok);
  return loaded.rows;
}
function find(id: string): ProfileRow {
  const found = rowsOf().find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}
const ids = (row: ProfileRow, reader?: "adhd") =>
  resolveModules(row, reader).modules.map((module) => module.id);

describe("profiles table shipped with the checker", () => {
  it("has the eight representative rows with the expected modules and genre", () => {
    const expected: Array<[string, string[], string | undefined, boolean]> = [
      [
        "design",
        ["fact", "business", "polish", "notation", "check"],
        "tech",
        true,
      ],
      [
        "procedure",
        ["fact", "business", "action", "polish", "notation", "check"],
        "business",
        false,
      ],
      [
        "report",
        ["fact", "business", "polish", "notation", "check"],
        "business",
        false,
      ],
      [
        "caller",
        ["fact", "caller", "polish", "notation", "check"],
        undefined,
        false,
      ],
      ["book", ["fact", "book", "polish", "notation", "check"], "tech", false],
      [
        "essay",
        ["fact", "keep", "polish", "notation", "check"],
        "essay",
        false,
      ],
      [
        "rewrite-default",
        ["fact", "keep", "polish", "notation", "check"],
        undefined,
        false,
      ],
      [
        "compose-default",
        ["fact", "business", "polish", "notation", "check"],
        undefined,
        false,
      ],
    ];
    assert.equal(rowsOf().length, expected.length);
    for (const [id, modules, genre, stockBoundary] of expected) {
      const resolved = resolveModules(find(id));
      assert.deepEqual(
        resolved.modules.map((module) => module.id),
        modules,
        id,
      );
      assert.equal(resolved.genre, genre, id);
      assert.equal(resolved.stockBoundary, stockBoundary, id);
      assert.ok(!("genre" in resolved) || genre !== undefined, id);
    }
  });

  it("adds action and replaces the structure for the adhd reader, except for caller", () => {
    for (const item of rowsOf()) {
      const resolved = resolveModules(item, "adhd");
      const list = resolved.modules.map((module) => module.id);
      assert.ok(list.includes("action"), item.id);
      if (item.id === "caller") {
        assert.ok(list.includes("caller"), item.id);
        assert.equal(
          resolved.modules.find((module) => module.id === "action")?.scope,
          "no-section-move",
        );
      } else {
        assert.ok(list.includes("business"), item.id);
        assert.ok(!list.includes("keep") && !list.includes("book"), item.id);
        assert.equal(
          resolved.modules.find((module) => module.id === "action")?.scope,
          "all",
        );
      }
    }
  });

  it("starts every list with fact and ends it with check, with or without a reader", () => {
    for (const item of rowsOf()) {
      for (const reader of [undefined, "adhd" as const]) {
        const list = ids(item, reader);
        assert.equal(list[0], "fact", item.id);
        assert.equal(list.at(-1), "check", item.id);
      }
    }
  });

  it("keeps every row within the enumerations", () => {
    for (const item of rowsOf()) {
      assert.ok((STRUCTURES as readonly string[]).includes(item.structure));
      assert.ok(item.genre === undefined || GENRES.includes(item.genre));
      assert.ok(
        !item.action || ["business", "caller"].includes(item.structure),
      );
    }
    assert.deepEqual([...READERS], ["adhd"]);
  });
});

describe("profiles validation", () => {
  it("rejects the whole table for duplicate ids, missing defaults, a wrong schema or too many rows", () => {
    assert.equal(
      validateProfiles({
        schema: 1,
        rows: [...defaults(), row({ id: "dup" }), row({ id: "dup" })],
      }).ok,
      false,
    );
    assert.equal(
      validateProfiles({ schema: 1, rows: [row({ id: "rewrite-default" })] })
        .ok,
      false,
    );
    assert.equal(validateProfiles({ schema: 2, rows: defaults() }).ok, false);
    assert.equal(validateProfiles({ schema: 1, rows: "x" }).ok, false);
    const many = Array.from({ length: 65 }, (_, i) => row({ id: `r${i}` }));
    assert.equal(
      validateProfiles({ schema: 1, rows: [...defaults(), ...many] }).ok,
      false,
    );
  });

  it("skips only the invalid rows and reports one fixed warning for each", () => {
    const result = validateProfiles({
      schema: 1,
      rows: [
        ...defaults(),
        row({ id: "bad-structure", structure: "x" }),
        row({ id: "Bad Id" }),
        row({ id: "bad-signal", signals: ["改行\nあり"] }),
        row({ id: "bad-action", action: true, structure: "keep" }),
        row({ id: "good" }),
      ],
    });
    assert.ok(result.ok);
    assert.deepEqual(
      result.rows.map((item) => item.id),
      ["rewrite-default", "compose-default", "good"],
    );
    assert.equal(result.warnings.length, 4);
    for (const warning of result.warnings) {
      assert.ok(!/bad-|Bad Id|改行/u.test(warning), warning);
    }
  });

  it("warns about unknown fields without echoing them", () => {
    const result = validateProfiles({
      schema: 1,
      rows: [...defaults(), row({ id: "extra", secretField: "token-value" })],
    });
    assert.ok(result.ok);
    assert.equal(result.warnings.length, 1);
    assert.ok(!result.warnings[0]?.includes("secretField"));
    assert.ok(result.rows.some((item) => item.id === "extra"));
  });

  it("splits the validated fields into hashed and unhashed ones exactly", () => {
    const all = [...PROFILE_FIELDS].sort();
    const split = [...HASHED_PROFILE_FIELDS, ...UNHASHED_PROFILE_FIELDS].sort();
    assert.deepEqual(split, all);
  });
});

describe("profiles loading", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-profiles-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;
  function copy(content: string | Buffer): string {
    const dir = join(root, `case-${++number}`);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "profiles.json"), content);
    return dir;
  }

  it("does not use a table larger than 64 KB", () => {
    const result = loadProfiles(copy(Buffer.alloc(64 * 1024 + 1, 0x20)));
    assert.equal(result.ok, false);
  });

  it("does not use a broken JSON table and hides its content", () => {
    const result = loadProfiles(copy('{"schema": 1, "rows": [secret-text'));
    assert.ok(!result.ok);
    assert.ok(!result.reason.includes("secret-text"));
  });

  it("does not use a missing table", () => {
    const result = loadProfiles(join(root, "nowhere"));
    assert.equal(result.ok, false);
  });
});
