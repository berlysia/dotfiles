import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  parseLearningsFile,
  serializeLearningsFile,
  type LearningsFile,
} from "../../lib/agent-learnings/core/learnings-file.ts";

const SAMPLE = [
  "<!-- agent-learnings format: 1; key: github.com/berlysia/foo -->",
  "",
  "# Learnings: github.com/berlysia/foo",
  "",
  "## bun test は --preload を読まない",
  "<!-- id: L-3f9c0a1b2d4e; seen: 3; repos: github.com/berlysia/foo; updated: 2026-10-15; extra: kept -->",
  "bunfig.toml の [test] preload に書く。",
  "",
  "## 二つ目",
  "<!-- id: L-000000000001; seen: 1; repos: github.com/berlysia/foo,github.com/berlysia/bar; updated: 2026-10-14 -->",
  "本文。",
  "",
].join("\n");

describe("parseLearningsFile", () => {
  it("round-trips the canonical form", () => {
    const parsed = parseLearningsFile(SAMPLE);
    ok(parsed.ok);
    strictEqual(serializeLearningsFile(parsed.value), SAMPLE);
  });
  it("parses metadata and keeps unknown keys", () => {
    const parsed = parseLearningsFile(SAMPLE);
    ok(parsed.ok);
    const first = parsed.value.entries[0];
    strictEqual(first?.id, "L-3f9c0a1b2d4e");
    strictEqual(first?.seen, 3);
    deepStrictEqual(first?.extra, [["extra", "kept"]]);
    deepStrictEqual(parsed.value.entries[1]?.repos, [
      "github.com/berlysia/foo",
      "github.com/berlysia/bar",
    ]);
  });
  it("marks an unknown format as read-only", () => {
    const parsed = parseLearningsFile(SAMPLE.replace("format: 1", "format: 2"));
    ok(parsed.ok);
    strictEqual(parsed.value.readOnly, true);
  });
  it("marks a file without the format marker as read-only, keeping no entries", () => {
    const parsed = parseLearningsFile("# 手で書いたメモ\n");
    ok(parsed.ok);
    strictEqual(parsed.value.readOnly, true);
    strictEqual(parsed.value.entries.length, 0);
  });
  it("fails when a heading is not followed by a meta line", () => {
    strictEqual(
      parseLearningsFile(
        SAMPLE.replace("<!-- id: L-3f9c0a1b2d4e", "x <!-- id: L-3f9c0a1b2d4e"),
      ).ok,
      false,
    );
  });
  it("fails when a body spans two lines", () => {
    strictEqual(
      parseLearningsFile(SAMPLE.replace("本文。", "本文。\n続き")).ok,
      false,
    );
  });
  it("fails on a malformed id or repo key", () => {
    strictEqual(
      parseLearningsFile(SAMPLE.replace("L-3f9c0a1b2d4e", "L-XYZ")).ok,
      false,
    );
    strictEqual(
      parseLearningsFile(
        SAMPLE.replace("repos: github.com/berlysia/foo;", "repos: ../x;"),
      ).ok,
      false,
    );
  });
  it("round-trips an entry with empty repos (a common entry added outside any repo)", () => {
    const file: LearningsFile = {
      format: 1,
      key: "common",
      readOnly: false,
      entries: [
        {
          id: "L-0000000000aa",
          title: "t",
          body: "b",
          seen: 1,
          repos: [],
          updated: "2026-10-15",
          extra: [],
        },
      ],
    };
    const text = serializeLearningsFile(file);
    ok(text.includes("repos: ; updated"));
    const parsed = parseLearningsFile(text);
    ok(parsed.ok);
    deepStrictEqual(parsed.value, file);
  });
  it("round-trips an empty file", () => {
    const empty: LearningsFile = {
      format: 1,
      key: "local/x-1a2b3c4d",
      readOnly: false,
      entries: [],
    };
    const text = serializeLearningsFile(empty);
    strictEqual(
      text,
      "<!-- agent-learnings format: 1; key: local/x-1a2b3c4d -->\n\n# Learnings: local/x-1a2b3c4d\n",
    );
    const parsed = parseLearningsFile(text);
    ok(parsed.ok);
    deepStrictEqual(parsed.value, empty);
  });
});
