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

import {
  canApproveSedTargets,
  checkFilePermissions,
} from "../../lib/file-permission-inference.ts";

import { sourced } from "../sourced-rules.ts";

const ctx = { cwd: "/repo", home: "/home/u" };

describe("file-permission-inference", () => {
  describe("checkFilePermissions", () => {
    it("should permit file matching Edit pattern", () => {
      const result = checkFilePermissions(
        ["src/utils.ts"],
        sourced(["Edit(./**)", "Bash(git *)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
      expect(result.fileResults).toHaveLength(1);
      expect(result.fileResults[0]?.permitted).toBeTruthy();
      expect(result.fileResults[0]?.matchedPattern).toContain("Edit");
    });

    it("should permit file matching MultiEdit pattern", () => {
      const result = checkFilePermissions(
        ["src/utils.ts"],
        sourced(["MultiEdit(src/**)", "Bash(git *)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
      expect(result.fileResults[0]?.permitted).toBeTruthy();
      expect(result.fileResults[0]?.matchedPattern).toContain("MultiEdit");
    });

    it("should permit all files when all match", () => {
      const result = checkFilePermissions(
        ["src/utils.ts", "src/helper.ts", "lib/index.ts"],
        sourced(["Edit(./**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
      expect(result.fileResults).toHaveLength(3);
      for (const fileResult of result.fileResults) {
        expect(fileResult.permitted).toBeTruthy();
      }
    });

    it("should deny when one file does not match", () => {
      const result = checkFilePermissions(
        ["src/utils.ts", "config.json"],
        sourced(["Edit(src/**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeFalsy();
      expect(result.firstDeniedFile).toBe("config.json");
      expect(result.fileResults[0]?.permitted).toBeTruthy();
      expect(result.fileResults[1]?.permitted).toBeFalsy();
    });

    it("should deny when no Edit patterns exist", () => {
      const result = checkFilePermissions(
        ["src/utils.ts"],
        sourced(["Bash(git *)", "Read(./**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeFalsy();
      expect(result.fileResults[0]?.deniedReason).toContain(
        "No Edit/MultiEdit patterns",
      );
    });

    it("should handle absolute paths", () => {
      const result = checkFilePermissions(
        ["/home/user/project/src/utils.ts"],
        sourced(["Edit(//home/user/project/**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
    });

    it("anchors a /path Edit rule at the settings root of its source", () => {
      const rules = sourced(["Edit(/src/**)"], "/started/here");
      expect(
        checkFilePermissions(["/started/here/src/a.ts"], rules, ctx)
          .allFilesPermitted,
      ).toBeTruthy();
      expect(
        checkFilePermissions(["/src/a.ts"], rules, ctx).allFilesPermitted,
      ).toBeFalsy();
    });

    it("should handle relative paths starting with ./", () => {
      const result = checkFilePermissions(
        ["./src/utils.ts"],
        sourced(["Edit(./**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
    });

    it("should handle wildcards in patterns", () => {
      const result = checkFilePermissions(
        ["src/components/Button.tsx"],
        sourced(["Edit(src/**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
    });

    it("should handle mixed file extensions", () => {
      const result = checkFilePermissions(
        ["src/utils.ts", "src/styles.css"],
        sourced(["Edit(src/**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
    });

    it("should provide detailed results for each file", () => {
      const result = checkFilePermissions(
        ["src/allowed.ts", "config/denied.json"],
        sourced(["Edit(src/**)"]),
        ctx,
      );

      expect(result.fileResults).toHaveLength(2);

      // First file permitted
      expect(result.fileResults[0]?.filePath).toBe("src/allowed.ts");
      expect(result.fileResults[0]?.permitted).toBeTruthy();
      expect(result.fileResults[0]?.matchedPattern).toBeDefined();

      // Second file denied
      expect(result.fileResults[1]?.filePath).toBe("config/denied.json");
      expect(result.fileResults[1]?.permitted).toBeFalsy();
      expect(result.fileResults[1]?.deniedReason).toBeDefined();
    });

    it("should match pattern with multiple directory levels", () => {
      const result = checkFilePermissions(
        ["src/deep/nested/path/file.ts"],
        sourced(["Edit(src/**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
    });

    it("should handle empty file list", () => {
      const result = checkFilePermissions([], sourced(["Edit(./**)"]), ctx);

      expect(result.allFilesPermitted).toBeTruthy();
      expect(result.fileResults).toHaveLength(0);
    });

    it("should try multiple patterns until match", () => {
      const result = checkFilePermissions(
        ["config/settings.json"],
        sourced(["Edit(src/**)", "Edit(config/**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
      expect(result.fileResults[0]?.matchedPattern).toContain("config");
    });

    it("should handle files in current directory", () => {
      const result = checkFilePermissions(
        ["README.md"],
        sourced(["Edit(./**)"]),
        ctx,
      );

      expect(result.allFilesPermitted).toBeTruthy();
    });
  });

  describe("canApproveSedTargets", () => {
    it("should return true when all files permitted", () => {
      const result = canApproveSedTargets(
        ["src/utils.ts", "src/index.ts"],
        sourced(["Edit(src/**)"]),
        ctx,
      );

      expect(result).toBeTruthy();
    });

    it("should return false when any file denied", () => {
      const result = canApproveSedTargets(
        ["src/utils.ts", "config.json"],
        sourced(["Edit(src/**)"]),
        ctx,
      );

      expect(result).toBeFalsy();
    });

    it("should return false when no Edit patterns", () => {
      const result = canApproveSedTargets(
        ["file.txt"],
        sourced(["Bash(git *)"]),
        ctx,
      );

      expect(result).toBeFalsy();
    });
  });
});

describe("relative targets and patterns share cwd", () => {
  it("does not reach a same-named directory above cwd", () => {
    const deep = { cwd: "/r/src/proj", home: "/home/u" };
    strictEqual(
      canApproveSedTargets(["config/a.json"], sourced(["Edit(src/**)"]), deep),
      false,
    );
    strictEqual(
      canApproveSedTargets(["src/a.ts"], sourced(["Edit(src/**)"]), deep),
      true,
    );
  });
  it("ignores a negated allow pattern", () => {
    strictEqual(
      canApproveSedTargets(
        ["src/a.ts"],
        sourced(["Edit(!node_modules/**)"]),
        ctx,
      ),
      false,
    );
  });
  it("matches a wildcard-free home pattern", () => {
    strictEqual(
      canApproveSedTargets(["~/.zshrc"], sourced(["Edit(~/.zshrc)"]), ctx),
      true,
    );
  });
});
