import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { hasControlChars as sceneHasControlChars } from "../../lib/agent-learnings/core/scene-state.ts";
import {
  hasControlChars,
  patchSections,
  patchTargetPaths,
} from "../../lib/agent-learnings/codex/patch-paths.ts";

const mdOnly = (path: string) => path.endsWith(".md");
const sections = (text: string, include = mdOnly) =>
  patchSections(text, { include });

describe("patchTargetPaths", () => {
  it("reads the shape observed on codex-cli 0.163.0", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: /r/a.txt",
      "*** Add File: /r/a.txt",
      "+bye",
      "*** End Patch",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), ["/r/a.txt", "/r/a.txt"]);
  });
  it("returns both the source and the destination of a move", () => {
    const patch = "*** Update File: /r/a.ts\n*** Move to: /r/b.ts\n@@\n-x\n+y";
    deepStrictEqual(patchTargetPaths(patch), ["/r/a.ts", "/r/b.ts"]);
  });
  it("ignores header look-alikes inside the diff body", () => {
    const patch = [
      "+*** Update File: x",
      " *** Update File: y",
      "-*** Add File: z",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), []);
  });
  it("keeps a CRLF header (the CR is not part of the path) and drops NUL, over 4096 bytes, or an empty path", () => {
    const patch = [
      "*** Update File: /r/cr.ts\r",
      "*** Update File: /r/nul\u0000.ts",
      `*** Update File: /${"a".repeat(4097)}`,
      "*** Update File: ",
      "*** Update File: /r/ok.ts",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), ["/r/cr.ts", "/r/ok.ts"]);
  });
  it("stops at 64 paths", () => {
    const patch = Array.from(
      { length: 70 },
      (_, i) => `*** Add File: /r/f${i}.ts`,
    ).join("\n");
    deepStrictEqual(patchTargetPaths(patch).length, 64);
  });
  it("returns Delete File and Move to paths as before", () => {
    const patch =
      "*** Delete File: docs/a.md\n*** Update File: x.md\n*** Move to: y.md";
    deepStrictEqual(patchTargetPaths(patch), ["docs/a.md", "x.md", "y.md"]);
  });
  it("accepts CRLF and trailing space or tab", () => {
    const patch =
      "*** Add File: docs/a.md\r\n*** Add File: docs/b.md  \n*** Add File: docs/d.md\t";
    deepStrictEqual(patchTargetPaths(patch), [
      "docs/a.md",
      "docs/b.md",
      "docs/d.md",
    ]);
  });
  it("does not accept a leading space, and leaves the sections open", () => {
    const patch = [
      "  *** Add File: docs/c.md",
      "*** Update File: docs/a.md",
      "+one",
      " *** Add File: docs/b.md",
      "+two",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), ["docs/a.md"]);
    deepStrictEqual(sections(patch).sections, [
      { path: "docs/a.md", body: "one\ntwo" },
    ]);
  });
  it("does not make a path header out of an empty path", () => {
    deepStrictEqual(
      patchTargetPaths("*** Update File:   \n*** Update File:"),
      [],
    );
  });
  it("keeps the leading space of the path", () => {
    deepStrictEqual(patchTargetPaths("*** Add File:   x"), ["  x"]);
  });
  it("does not count dropped headers toward the 64", () => {
    const bad = Array.from(
      { length: 10 },
      (_, i) => `*** Add File: /r/b${i}\u0000`,
    );
    const good = Array.from(
      { length: 64 },
      (_, i) => `*** Add File: /r/g${i}.ts`,
    );
    deepStrictEqual(patchTargetPaths([...bad, ...good].join("\n")).length, 64);
  });
  it("agrees with scene-state hasControlChars on code 0x00-0x7f", () => {
    for (let code = 0; code < 0x80; code++) {
      const text = `a${String.fromCharCode(code)}b`;
      strictEqual(
        hasControlChars(text),
        sceneHasControlChars(text),
        String(code),
      );
    }
  });
  it("keeps only a single CR, trims tab, keeps U+00A0 in the path", () => {
    const patch = [
      "*** Add File: docs/a.md\r\r",
      "*** Add File: docs/b.md\t",
      "*** Add File: docs/c.md\u00a0",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), ["docs/b.md", "docs/c.md\u00a0"]);
  });
  it("measures the 4096-byte limit before trimming", () => {
    const path = "a".repeat(4096 - "*** Add File: ".length - 1);
    const line = `*** Add File: ${path}`;
    strictEqual(Buffer.byteLength(line), 4095);
    deepStrictEqual(patchTargetPaths(`${line}  `), []);
    deepStrictEqual(patchTargetPaths(line), [path]);
  });
  it("counts at most 64 path headers in both paths and sections", () => {
    const patch = Array.from(
      { length: 65 },
      (_, i) => `*** Add File: docs/f${i}.md\n+x`,
    ).join("\n");
    strictEqual(patchTargetPaths(patch).length, 64);
    strictEqual(sections(patch).sections.length, 64);
  });
  it("imports only node: modules", () => {
    const source = readFileSync(
      new URL(
        "../../lib/agent-learnings/codex/patch-paths.ts",
        import.meta.url,
      ),
      "utf8",
    );
    for (const m of source.matchAll(
      /^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm,
    )) {
      ok(m[1]?.startsWith("node:"), m[1]);
    }
  });
});

describe("patchSections", () => {
  it("collects + lines of an included section and strips + and one trailing CR", () => {
    const r = sections(
      "*** Add File: docs/a.md\r\n+hello\r\n+\u001b[0m\n context\n-removed\n+world",
    );
    deepStrictEqual(r.sections, [
      { path: "docs/a.md", body: "hello\n\u001b[0m\nworld" },
    ]);
    strictEqual(r.truncated, false);
  });
  it("does not collect sections excluded by include, and they spend no budget", () => {
    const patch = [
      "*** Add File: src/a.ts",
      ...Array.from({ length: 300 }, () => `+${"x".repeat(1023)}`),
      "*** Add File: docs/a.md",
      "+ok",
    ].join("\n");
    const r = sections(patch);
    deepStrictEqual(r.sections, [{ path: "docs/a.md", body: "ok" }]);
    strictEqual(r.truncated, false);
  });
  it("stops collecting at 256 KB and says so; paths are still found", () => {
    const patch = [
      "*** Add File: docs/y.md",
      ...Array.from({ length: 300 }, () => `+${"x".repeat(1023)}`),
      "*** Add File: docs/z.md",
      "+z",
    ].join("\n");
    strictEqual(sections(patch).truncated, true);
    deepStrictEqual(patchTargetPaths(patch), ["docs/y.md", "docs/z.md"]);
  });
  it("treats End of File as a mark inside the section", () => {
    for (const eol of ["\n", "\r\n"]) {
      const patch = [
        "*** Update File: docs/a.md",
        "+one",
        "*** End of File",
        "+two",
      ].join(eol);
      deepStrictEqual(sections(patch).sections, [
        { path: "docs/a.md", body: "one\ntwo" },
      ]);
    }
  });
  it("moves the section path to the Move to right after Update File", () => {
    deepStrictEqual(
      sections("*** Update File: notes.txt\n*** Move to: docs/a.md\n+x")
        .sections,
      [{ path: "docs/a.md", body: "x" }],
    );
    deepStrictEqual(
      sections("*** Update File: docs/a.md\n+x\n*** Move to: notes.txt\n+y")
        .sections,
      [{ path: "docs/a.md", body: "x" }],
    );
    deepStrictEqual(
      sections("*** Update File: notes.txt\n\n*** Move to: docs/a.md\n+x")
        .sections,
      [],
    );
    deepStrictEqual(
      sections("*** Add File: docs/a.md\n*** Move to: notes.txt\n+x").sections,
      [{ path: "docs/a.md", body: "" }],
    );
  });
  it("keeps the section path when the Move to is dropped or over the cap", () => {
    deepStrictEqual(
      sections("*** Update File: notes.txt\n*** Move to: docs/a.md\u0000\n+x")
        .sections,
      [],
    );
    const filler = Array.from(
      { length: 63 },
      (_, i) => `*** Delete File: f${i}`,
    );
    const patch = [
      ...filler,
      "*** Update File: notes.txt",
      "*** Move to: docs/a.md",
      "+x",
    ].join("\n");
    deepStrictEqual(sections(patch).sections, []);
    strictEqual(patchTargetPaths(patch).includes("docs/a.md"), false);
  });
  it("closes the section at a dropped header", () => {
    deepStrictEqual(
      sections("*** Add File: docs/a.md\n+x\n*** Add File: docs/b\u0000.md\n+y")
        .sections,
      [{ path: "docs/a.md", body: "x" }],
    );
    deepStrictEqual(
      sections(`*** Add File: /${"a".repeat(4097)}\n+y`).sections,
      [],
    );
  });
  it("closes the section at Delete File and End Patch", () => {
    deepStrictEqual(
      sections(
        "*** Add File: docs/a.md\n+x\n*** Delete File: q\n+y\n*** End Patch\n+z",
      ).sections,
      [{ path: "docs/a.md", body: "x" }],
    );
  });
});
