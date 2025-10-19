/**
 * Tests for path-utils.ts
 */

import { describe, it, mock } from "node:test";
import { strictEqual } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expandTilde,
  expandRelativePath,
  normalizePath,
  makeRelativeToCwd,
  normalizePathForMatching,
  normalizePattern,
} from "../../lib/path-utils.ts";

describe("path-utils", () => {
  describe("expandTilde", () => {
    it("should expand tilde to home directory", () => {
      const result = expandTilde("~/workspace/project");
      strictEqual(result, join(homedir(), "workspace/project"));
    });

    it("should not modify absolute paths", () => {
      const result = expandTilde("/absolute/path");
      strictEqual(result, "/absolute/path");
    });

    it("should not modify relative paths", () => {
      const result = expandTilde("./relative/path");
      strictEqual(result, "./relative/path");
    });

    it("should not modify bare relative paths", () => {
      const result = expandTilde("relative/path");
      strictEqual(result, "relative/path");
    });

    it("should handle home directory path", () => {
      const result = expandTilde("~");
      strictEqual(result, "~");
    });

    it("should handle tilde with trailing slash", () => {
      const result = expandTilde("~/");
      strictEqual(result, join(homedir(), ""));
    });
  });

  describe("expandRelativePath", () => {
    it("should expand ./ relative path with default cwd", () => {
      const result = expandRelativePath("./src/file.ts");
      strictEqual(result, join(process.cwd(), "src/file.ts"));
    });

    it("should expand bare relative path with default cwd", () => {
      const result = expandRelativePath("src/file.ts");
      strictEqual(result, join(process.cwd(), "src/file.ts"));
    });

    it("should expand relative path with custom base", () => {
      const result = expandRelativePath("src/file.ts", "/custom/base");
      strictEqual(result, "/custom/base/src/file.ts");
    });

    it("should not modify absolute paths", () => {
      const result = expandRelativePath("/absolute/path");
      strictEqual(result, "/absolute/path");
    });

    it("should not modify tilde paths", () => {
      const result = expandRelativePath("~/workspace/file");
      strictEqual(result, "~/workspace/file");
    });

    it("should handle ./ with custom base", () => {
      const result = expandRelativePath("./file.ts", "/custom");
      strictEqual(result, "/custom/file.ts");
    });
  });

  describe("normalizePath", () => {
    it("should expand both tilde and relative by default", () => {
      const result = normalizePath("~/./workspace/file.ts");
      // Note: Node's join() resolves ./ automatically
      strictEqual(result, join(homedir(), "./workspace/file.ts"));
    });

    it("should only expand tilde when expandRelative is false", () => {
      const result = normalizePath("~/workspace/file.ts", {
        expandRelative: false,
      });
      strictEqual(result, join(homedir(), "workspace/file.ts"));
    });

    it("should only expand relative when expandTilde is false", () => {
      const result = normalizePath("./file.ts", { expandTilde: false });
      strictEqual(result, join(process.cwd(), "file.ts"));
    });

    it("should not expand when both options are false", () => {
      const result = normalizePath("~/./file.ts", {
        expandTilde: false,
        expandRelative: false,
      });
      strictEqual(result, "~/./file.ts");
    });

    it("should make path absolute with makeAbsolute option", () => {
      const result = normalizePath("file.ts", { makeAbsolute: true });
      strictEqual(result, join(process.cwd(), "file.ts"));
    });
  });

  describe("makeRelativeToCwd", () => {
    it("should convert absolute path within cwd to relative", () => {
      const cwd = process.cwd();
      const result = makeRelativeToCwd(`${cwd}/src/file.ts`);
      strictEqual(result, "./src/file.ts");
    });

    it("should convert cwd itself to .", () => {
      const cwd = process.cwd();
      const result = makeRelativeToCwd(cwd);
      strictEqual(result, ".");
    });

    it("should return null for paths outside cwd", () => {
      const result = makeRelativeToCwd("/other/path/file.ts");
      strictEqual(result, null);
    });

    it("should return null for relative paths", () => {
      const result = makeRelativeToCwd("./relative/path");
      strictEqual(result, null);
    });

    it("should return null for tilde paths", () => {
      const result = makeRelativeToCwd("~/workspace/file");
      strictEqual(result, null);
    });
  });

  describe("normalizePathForMatching", () => {
    it("should expand tilde in path", () => {
      const result = normalizePathForMatching(
        "~/workspace/file.ts",
        "~/workspace/**"
      );
      strictEqual(result, join(homedir(), "workspace/file.ts"));
    });

    it("should convert relative to absolute when pattern is absolute", () => {
      const result = normalizePathForMatching("src/file.ts", "/absolute/**");
      strictEqual(result, join(process.cwd(), "src/file.ts"));
    });

    it("should convert absolute to relative when pattern is ./ ", () => {
      const cwd = process.cwd();
      const result = normalizePathForMatching(
        `${cwd}/src/file.ts`,
        "./src/**"
      );
      strictEqual(result, "./src/file.ts");
    });

    it("should keep absolute path for ./** pattern (gitignore style)", () => {
      const cwd = process.cwd();
      const absPath = `${cwd}/src/file.ts`;
      const result = normalizePathForMatching(absPath, "./**");
      strictEqual(result, absPath); // Should NOT convert to relative for ./**
    });

    it("should not convert path outside cwd to relative", () => {
      const result = normalizePathForMatching("/other/path/file.ts", "./src/**");
      strictEqual(result, "/other/path/file.ts");
    });

    it("should handle tilde in both path and pattern", () => {
      const result = normalizePathForMatching(
        "~/workspace/file.ts",
        "~/workspace/**"
      );
      const expected = join(homedir(), "workspace/file.ts");
      strictEqual(result, expected);
    });
  });

  describe("normalizePattern", () => {
    it("should expand tilde in pattern", () => {
      const result = normalizePattern("~/workspace/**");
      strictEqual(result, join(homedir(), "workspace/**"));
    });

    it("should expand ./ in pattern (except ./**)", () => {
      const result = normalizePattern("./src/**");
      strictEqual(result, join(process.cwd(), "src/**"));
    });

    it("should preserve ./** gitignore pattern by default", () => {
      const result = normalizePattern("./**");
      strictEqual(result, "./**");
    });

    it("should expand ./** when preserveGitignorePatterns is false", () => {
      const result = normalizePattern("./**", {
        preserveGitignorePatterns: false,
      });
      strictEqual(result, join(process.cwd(), "**"));
    });

    it("should not modify absolute patterns", () => {
      const result = normalizePattern("/absolute/path/**");
      strictEqual(result, "/absolute/path/**");
    });

    it("should not modify ** pattern", () => {
      const result = normalizePattern("**");
      strictEqual(result, "**");
    });
  });

  describe("edge cases", () => {
    it("expandTilde should handle empty string", () => {
      const result = expandTilde("");
      strictEqual(result, "");
    });

    it("expandRelativePath should handle empty string", () => {
      const result = expandRelativePath("");
      strictEqual(result, process.cwd());
    });

    it("makeRelativeToCwd should handle empty string", () => {
      const result = makeRelativeToCwd("");
      strictEqual(result, null);
    });

    it("normalizePathForMatching should handle empty path", () => {
      const result = normalizePathForMatching("", "**");
      strictEqual(result, "");
    });

    it("normalizePattern should handle empty pattern", () => {
      const result = normalizePattern("");
      strictEqual(result, "");
    });
  });
});
