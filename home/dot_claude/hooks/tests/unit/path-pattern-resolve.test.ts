import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  type MatchKind,
  resolvePathPattern,
  resolveTargetPath,
} from "../../lib/path-utils.ts";

const ctx = { cwd: "/repo", home: "/home/u" };
const R = (base: string, glob: string) => ({ base, glob });

describe("resolveTargetPath", () => {
  const cases: Array<[string, string]> = [
    ["/a/b", "/a/b"],
    ["a/b", "/repo/a/b"],
    ["./a", "/repo/a"],
    ["~/x", "/home/u/x"],
    ["~", "/home/u"],
    ["../x", "/x"],
    ["/tmp/../etc/passwd", "/etc/passwd"],
    ["/a//b/./c", "/a/b/c"],
    ["/a/b/", "/a/b"],
    ["/", "/"],
  ];
  for (const [raw, expected] of cases) {
    it(`${JSON.stringify(raw)} -> ${expected}`, () => {
      strictEqual(resolveTargetPath(raw, ctx), expected);
    });
  }
  it("strips a trailing slash from cwd and home", () => {
    strictEqual(
      resolveTargetPath("a", { cwd: "/repo/", home: "/home/u/" }),
      "/repo/a",
    );
    strictEqual(
      resolveTargetPath("~/a", { cwd: "/repo/", home: "/home/u/" }),
      "/home/u/a",
    );
  });
});

describe("resolvePathPattern", () => {
  type Row = [string, ReturnType<typeof R>[], ReturnType<typeof R>[]];
  // body, grant, restrict
  const rows: Row[] = [
    // rule 1, 2: leading slash is filesystem-absolute in the hook
    ["//**/.env", [R("/", "**/.env")], [R("/", "**/.env")]],
    ["/etc/passwd", [R("/", "etc/passwd")], [R("/", "etc/passwd")]],
    ["/tmp/**", [R("/", "tmp/**")], [R("/", "tmp/**")]],
    ["/", [R("/", "**")], [R("/", "**")]],
    // rule 3
    [
      "~/.config/**",
      [R("/home/u", ".config/**")],
      [R("/home/u", ".config/**")],
    ],
    ["~/.zshrc", [R("/home/u", ".zshrc")], [R("/home/u", ".zshrc")]],
    // rule 4
    ["./**", [R("/repo", "**")], [R("/repo", "**")]],
    ["./", [R("/repo", "**")], [R("/repo", "**")]],
    ["./a/**", [R("/repo", "a/**")], [R("/repo", "a/**")]],
    // rule 5: bare name, or **/name
    [
      ".env",
      [R("/repo", "**/.env")],
      [R("/repo", "**/.env"), R("/repo", "**/.env/**")],
    ],
    [
      "**/.env",
      [R("/repo", "**/.env")],
      [R("/repo", "**/.env"), R("/repo", "**/.env/**")],
    ],
    [
      "*.ts",
      [R("/repo", "**/*.ts")],
      [R("/repo", "**/*.ts"), R("/repo", "**/*.ts/**")],
    ],
    [
      "**/*.test.*",
      [R("/repo", "**/*.test.*")],
      [R("/repo", "**/*.test.*"), R("/repo", "**/*.test.*/**")],
    ],
    ["**", [R("/repo", "**")], [R("/repo", "**")]],
    ["**/**", [R("/repo", "**")], [R("/repo", "**")]],
    // rule 6: single directory
    ["src/**", [R("/repo", "src/**")], [R("/repo", "**/src/**")]],
    ["src/", [R("/repo", "src/**")], [R("/repo", "**/src/**")]],
    ["*.d/**", [R("/repo", "*.d/**")], [R("/repo", "**/*.d/**")]],
    // rule 7: every other relative shape
    [
      ".tmp/sessions/*/*.md",
      [R("/repo", ".tmp/sessions/*/*.md")],
      [R("/repo", ".tmp/sessions/*/*.md")],
    ],
    ["a/b/**", [R("/repo", "a/b/**")], [R("/repo", "a/b/**")]],
    ["**/src/**", [R("/repo", "**/src/**")], [R("/repo", "**/src/**")]],
    ["**/a/b", [R("/repo", "**/a/b")], [R("/repo", "**/a/b")]],
    ["src/*", [R("/repo", "src/*")], [R("/repo", "src/*")]],
    // negation resolves to nothing
    ["!.git/**", [], []],
    ["!../x/**", [], []],
    // unusable patterns
    ["", [], []],
    ["~", [], [R("/home/u", "")]],
    ["../x", [], [R("/x", "")]],
    ["a/../b", [], [R("/repo/b", "")]],
    ["/etc/../x", [], [R("/x", "")]],
    ["~/a/../b", [], [R("/home/u/b", "")]],
  ];
  for (const [body, grant, restrict] of rows) {
    for (const [kind, expected] of [
      ["grant", grant],
      ["restrict", restrict],
    ] as Array<[MatchKind, ReturnType<typeof R>[]]>) {
      it(`${JSON.stringify(body)} as ${kind}`, () => {
        deepStrictEqual(resolvePathPattern(body, ctx, kind), expected);
      });
    }
  }
  it("does not read cwd as a glob when it contains *", () => {
    deepStrictEqual(
      resolvePathPattern("src/**", { cwd: "/a*b", home: "/home/u" }, "grant"),
      [R("/a*b", "src/**")],
    );
  });
  it("normalizes cwd and home so a base lines up with a normalized target", () => {
    const dirty = { cwd: "/repo/.", home: "/home//u/" };
    deepStrictEqual(resolvePathPattern("./.env", dirty, "restrict"), [
      R("/repo", ".env"),
    ]);
    deepStrictEqual(resolvePathPattern("~/.ssh/**", dirty, "restrict"), [
      R("/home/u", ".ssh/**"),
    ]);
    deepStrictEqual(
      resolvePathPattern(
        "src/**",
        { cwd: "/a/../repo", home: "/home/u" },
        "grant",
      ),
      [R("/repo", "src/**")],
    );
    strictEqual(resolveTargetPath("a", dirty), "/repo/a");
    strictEqual(resolveTargetPath("~/a", dirty), "/home/u/a");
  });
  it("resolves against a root cwd or a root home", () => {
    deepStrictEqual(
      resolvePathPattern("./**", { cwd: "/", home: "/home/u" }, "grant"),
      [R("/", "**")],
    );
    deepStrictEqual(
      resolvePathPattern("~/x", { cwd: "/repo", home: "/" }, "grant"),
      [R("/", "x")],
    );
    strictEqual(resolveTargetPath("a", { cwd: "/", home: "/home/u" }), "/a");
  });
});
