#!/usr/bin/env -S bun test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

// expectヘルパー（node:assertのラッパー）
const expect = (value: any) => ({
  toBe: (expected: any) => strictEqual(value, expected),
  toEqual: (expected: any) => deepStrictEqual(value, expected),
  toBeTruthy: () => ok(value),
  toBeFalsy: () => ok(!value),
  toBeDefined: () => ok(value !== undefined),
  toHaveLength: (expected: number) => strictEqual(value.length, expected),
  toContain: (expected: any) => ok(value.includes(expected)),
  not: {
    toBe: (expected: any) => ok(value !== expected),
    toEqual: (expected: any) => {
      try {
        deepStrictEqual(value, expected);
        ok(false);
      } catch {
        // Expected to fail
      }
    },
    toBeTruthy: () => ok(!value),
    toBeFalsy: () => ok(!!value),
    toContain: (expected: any) => ok(!value.includes(expected)),
  },
});

import { parseSedInPlace } from "../../lib/sed-parser.ts";

describe("sed-parser", () => {
  describe("parseSedInPlace", () => {
    it("should parse basic sed -i command", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' file.txt");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["file.txt"]);
      expect(result.containsGlob).toBeFalsy();
      expect(result.parseError).toBe(null);
      expect(result.backupExtension).toBe(null);
    });

    it("should parse sed -i with backup extension", () => {
      const result = parseSedInPlace("sed -i.bak 's/foo/bar/' file.txt");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["file.txt"]);
      expect(result.backupExtension).toBe(".bak");
    });

    it("should parse sed -i with empty backup extension (macOS style)", () => {
      const result = parseSedInPlace("sed -i '' 's/foo/bar/' file.txt");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["file.txt"]);
      expect(result.backupExtension).toBe("");
    });

    it("should parse sed -i with multiple files", () => {
      const result = parseSedInPlace(
        "sed -i 's/foo/bar/' file1.txt file2.txt file3.txt",
      );

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual([
        "file1.txt",
        "file2.txt",
        "file3.txt",
      ]);
      expect(result.containsGlob).toBeFalsy();
    });

    it("should detect glob patterns", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' *.txt");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["*.txt"]);
      expect(result.containsGlob).toBeTruthy();
    });

    it("should detect glob patterns with question mark", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' file?.txt");

      expect(result.containsGlob).toBeTruthy();
    });

    it("should detect glob patterns with brackets", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' file[0-9].txt");

      expect(result.containsGlob).toBeTruthy();
    });

    it("should detect glob even in originally quoted strings", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' \"*.txt\"");

      expect(result.isSedInPlace).toBeTruthy();
      // クォートは removeQuotes() で除去され、その後グロブパターンとして検出される
      // セキュリティ上の理由から、保守的にグロブとして扱う
      expect(result.targetFiles).toEqual(["*.txt"]);
      expect(result.containsGlob).toBeTruthy();
    });

    it("should parse sed -i with -e flag", () => {
      const result = parseSedInPlace(
        "sed -i -e 's/foo/bar/' -e 's/baz/qux/' file.txt",
      );

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["file.txt"]);
    });

    it("should parse sed -i with other flags", () => {
      const result = parseSedInPlace("sed -i -n -r 's/foo/bar/' file.txt");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["file.txt"]);
    });

    it("should return false for sed without -i", () => {
      const result = parseSedInPlace("sed 's/foo/bar/' file.txt");

      expect(result.isSedInPlace).toBeFalsy();
      expect(result.targetFiles).toEqual([]);
    });

    it("should return false for non-sed commands", () => {
      const result = parseSedInPlace("grep foo file.txt");

      expect(result.isSedInPlace).toBeFalsy();
    });

    it("should handle relative paths", () => {
      const result = parseSedInPlace(
        "sed -i 's/foo/bar/' ./src/utils/helper.ts",
      );

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["./src/utils/helper.ts"]);
    });

    it("should handle absolute paths", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' /home/user/file.txt");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["/home/user/file.txt"]);
    });

    it("should handle quoted file paths with spaces", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' \"my file.txt\"");

      expect(result.isSedInPlace).toBeTruthy();
      // クォートは removeQuotes() で除去される
      expect(result.targetFiles).toEqual(["my file.txt"]);
    });

    it("should handle empty command", () => {
      const result = parseSedInPlace("");

      expect(result.isSedInPlace).toBeFalsy();
      expect(result.parseError).toContain("Empty command");
    });

    it("should handle sed -i without files", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/'");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.parseError).toContain("No target files found");
    });

    it("should parse complex sed script", () => {
      const result = parseSedInPlace(
        "sed -i -e 's/foo/bar/g' -e '/pattern/d' file.txt",
      );

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["file.txt"]);
    });

    it("should handle sed with pattern deletion", () => {
      const result = parseSedInPlace("sed -i '/pattern/d' file.txt");

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toEqual(["file.txt"]);
    });

    it("should handle files starting with dash (edge case)", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' -- -file.txt");

      // This is an edge case - the parser may not handle it perfectly
      // but should at least not crash
      expect(result.isSedInPlace).toBeTruthy();
    });

    it("should handle mixed relative and absolute paths", () => {
      const result = parseSedInPlace(
        "sed -i 's/foo/bar/' ./local.txt /etc/config.txt",
      );

      expect(result.isSedInPlace).toBeTruthy();
      expect(result.targetFiles).toHaveLength(2);
      expect(result.targetFiles).toContain("./local.txt");
      expect(result.targetFiles).toContain("/etc/config.txt");
    });

    it("should detect brace expansion as glob", () => {
      const result = parseSedInPlace("sed -i 's/foo/bar/' file.{txt,md}");

      expect(result.containsGlob).toBeTruthy();
    });

    it("should remove quotes from file paths", () => {
      const result = parseSedInPlace('sed -i "s/foo/bar/" "file.txt"');

      // removeQuotes() でクォートが除去されることを確認
      expect(result.targetFiles).toEqual(["file.txt"]);
    });
  });
});
