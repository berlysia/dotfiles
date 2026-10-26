import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    tableCells: false,
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
  it("has the nine representative rows with the expected modules and genre", () => {
    const expected: Array<
      [string, string[], string | undefined, boolean, boolean]
    > = [
      [
        "design",
        ["fact", "business", "polish", "notation", "check"],
        "tech",
        true,
        true,
      ],
      [
        "procedure",
        ["fact", "business", "action", "polish", "notation", "check"],
        "business",
        false,
        true,
      ],
      [
        "report",
        ["fact", "business", "polish", "notation", "check"],
        "business",
        false,
        true,
      ],
      [
        "reference",
        ["fact", "business", "polish", "notation", "check"],
        undefined,
        true,
        true,
      ],
      [
        "caller",
        ["fact", "caller", "polish", "notation", "check"],
        undefined,
        false,
        true,
      ],
      [
        "book",
        ["fact", "book", "polish", "notation", "check"],
        "tech",
        false,
        false,
      ],
      [
        "essay",
        ["fact", "keep", "polish", "notation", "check"],
        "essay",
        false,
        false,
      ],
      [
        "rewrite-default",
        ["fact", "keep", "polish", "notation", "check"],
        undefined,
        false,
        false,
      ],
      [
        "compose-default",
        ["fact", "business", "polish", "notation", "check"],
        undefined,
        false,
        false,
      ],
    ];
    assert.equal(rowsOf().length, expected.length);
    for (const [id, modules, genre, stockBoundary, tableCells] of expected) {
      const resolved = resolveModules(find(id));
      assert.deepEqual(
        resolved.modules.map((module) => module.id),
        modules,
        id,
      );
      assert.equal(resolved.genre, genre, id);
      assert.equal(resolved.stockBoundary, stockBoundary, id);
      assert.equal(resolved.tableCells, tableCells, id);
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

// The skills live in the repository next to home/, so these read the sources,
// never the deployed copy.
const skill = (path: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../../.skills/${path}`, import.meta.url)),
    "utf8",
  );

describe("tanteki's document types map to the profiles table", () => {
  const section = () => {
    const text = skill("tanteki/references/document-types.md");
    const start = text.indexOf("## 検査コマンドの指定値");
    assert.ok(start >= 0);
    const end = text.indexOf("\n## ", start + 1);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const table = () =>
    section()
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(2)
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );

  it("lists the seven kinds in two columns", () => {
    const rows = table();
    assert.ok(rows.every((cells) => cells.length === 2));
    const mapping = Object.fromEntries(
      rows.map(([kind, profile]) => [
        /`([a-z-]+)`/u.exec(kind ?? "")?.[1],
        /`([a-z-]+)`/u.exec(profile ?? "")?.[1],
      ]),
    );
    assert.deepEqual(mapping, {
      "design-doc": "design",
      prd: "design",
      adr: "design",
      rfc: "design",
      stock: "reference",
      flow: "procedure",
      record: "report",
    });
  });

  it("names only rows of profiles.json, with the flags the text under the table states", () => {
    const flags: Record<string, [boolean, boolean]> = {
      design: [true, true],
      reference: [true, true],
      procedure: [false, true],
      report: [false, true],
    };
    for (const [, profile] of table()) {
      const id = /`([a-z-]+)`/u.exec(profile ?? "")?.[1] ?? "";
      const found = find(id);
      assert.deepEqual([found.stockBoundary, found.tableCells], flags[id], id);
    }
    const text = section();
    assert.match(
      text,
      /`design` と `reference` は.*`stock-boundary`.*`table-cell-length`.*両方/u,
    );
    assert.match(text, /`procedure` と `report` は `table-cell-length` だけ/u);
  });
});

describe("the ja-check skill runs the checks the profiles need", () => {
  const text = () => skill("ja-check/SKILL.md");
  it("passes --profile to every check of a tanteki document, the final draft included", () => {
    assert.match(text(), /check` はすべて `--profile/u);
    assert.match(text(), /最終稿にかける `check` も同じ指定/u);
  });
  it("runs textlint-global and names how its failures read", () => {
    const body = text();
    assert.ok(body.includes("textlint-global --format json"));
    for (const word of [
      "runtime not installed",
      "textlint: WARNING",
      "Cannot find",
    ])
      assert.ok(body.includes(word), word);
    assert.ok(!body.includes("lint.mjs"));
  });
});
