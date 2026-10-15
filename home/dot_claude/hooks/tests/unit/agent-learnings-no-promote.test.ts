import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  matchesNoPromote,
  readNoPromote,
} from "../../lib/agent-learnings/core/no-promote.ts";

function withStore(fn: (store: string) => void): void {
  const store = mkdtempSync(join(tmpdir(), "agent-learnings-nopromote-"));
  try {
    fn(store);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
}
const m = (pattern: string, key: string): boolean =>
  matchesNoPromote([pattern], key);

describe("matchesNoPromote", () => {
  it("matches local/* against local keys only", () => {
    strictEqual(m("local/*", "local/foo-1a2b3c4d"), true);
    strictEqual(m("local/*", "github.com/a/b"), false);
  });
  it("lets * cross slashes but not match the parent itself", () => {
    strictEqual(m("github.com/acme/*", "github.com/acme/x"), true);
    strictEqual(m("github.com/acme/*", "github.com/acme/x/y"), true);
    strictEqual(m("github.com/acme/*", "github.com/acme"), false);
  });
  it("matches a literal pattern against the whole key only", () => {
    strictEqual(m("github.com/a/b", "github.com/a/b"), true);
    strictEqual(m("github.com/a/b", "github.com/a/bc"), false);
  });
  it("treats regex metacharacters literally", () => {
    strictEqual(m("a.b/*", "axb/c"), false);
    strictEqual(m("a.b/*", "a.b/c"), true);
  });
  it("normalizes case on both sides", () => {
    strictEqual(m("GitHub.com/Acme/*", "github.com/acme/x"), true);
  });
  it("is not vulnerable to catastrophic backtracking", () => {
    // 指数時間の実装ならここで終わらない。経過時間は assertion にしない（test-layout の規約）
    strictEqual(m(`${"*a".repeat(20)}*b`, "a".repeat(200)), false);
    strictEqual(m(`${"*a".repeat(100)}*b`, "a".repeat(2000)), false);
  });
  it("lets a lone * match everything including the empty key", () => {
    strictEqual(m("*", ""), true);
    strictEqual(m("*", "github.com/a/b"), true);
  });
  it("collapses consecutive stars", () => {
    strictEqual(m("a**b", "axxb"), true);
  });
});

describe("readNoPromote", () => {
  it("uses only the built-in local/* when the file is missing", () =>
    withStore((store) => {
      const r = readNoPromote(store);
      ok(r.ok);
      strictEqual(matchesNoPromote(r.patterns, "local/x-1a2b3c4d"), true);
      strictEqual(matchesNoPromote(r.patterns, "github.com/a/b"), false);
    }));
  it("keeps local/* even when the line was deleted from the file", () =>
    withStore((store) => {
      writeFileSync(join(store, "no-promote"), "github.com/acme/*\n");
      const r = readNoPromote(store);
      ok(r.ok);
      strictEqual(matchesNoPromote(r.patterns, "local/x-1a2b3c4d"), true);
      strictEqual(matchesNoPromote(r.patterns, "github.com/acme/x"), true);
    }));
  it("ignores blank lines and comments and trims whitespace", () =>
    withStore((store) => {
      writeFileSync(
        join(store, "no-promote"),
        "\n# comment\n  GitHub.com/Acme/*  \n\t\n#another\n",
      );
      const r = readNoPromote(store);
      ok(r.ok);
      deepStrictEqual([...r.patterns].sort(), ["github.com/acme/*", "local/*"]);
    }));
  it("fails closed for a symlink, a 17KB file, 201 lines or a 201-char line", () => {
    withStore((store) => {
      writeFileSync(join(store, "real"), "x/*\n");
      symlinkSync(join(store, "real"), join(store, "no-promote"));
      strictEqual(readNoPromote(store).ok, false);
    });
    withStore((store) => {
      writeFileSync(
        join(store, "no-promote"),
        "# ".concat("x".repeat(17 * 1024)),
      );
      strictEqual(readNoPromote(store).ok, false);
    });
    withStore((store) => {
      writeFileSync(
        join(store, "no-promote"),
        Array.from({ length: 201 }, (_, i) => `a/${i}`).join("\n"),
      );
      strictEqual(readNoPromote(store).ok, false);
    });
    withStore((store) => {
      writeFileSync(join(store, "no-promote"), `${"a".repeat(201)}\n`);
      strictEqual(readNoPromote(store).ok, false);
    });
  });
  it("accepts exactly 200 lines and a 200-char line", () => {
    withStore((store) => {
      writeFileSync(
        join(store, "no-promote"),
        Array.from({ length: 200 }, (_, i) => `a/${i}`).join("\n"),
      );
      strictEqual(readNoPromote(store).ok, true);
    });
    withStore((store) => {
      writeFileSync(join(store, "no-promote"), `${"a".repeat(200)}\n`);
      strictEqual(readNoPromote(store).ok, true);
    });
  });
  it("fails closed when the path is a directory", () =>
    withStore((store) => {
      mkdirSync(join(store, "no-promote"));
      strictEqual(readNoPromote(store).ok, false);
    }));
});
