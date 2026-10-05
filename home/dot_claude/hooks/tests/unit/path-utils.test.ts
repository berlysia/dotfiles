/**
 * Tests for path-utils.ts
 */

import { strictEqual } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expandTilde } from "../../lib/path-utils.ts";

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

  describe("edge cases", () => {
    it("expandTilde should handle empty string", () => {
      const result = expandTilde("");
      strictEqual(result, "");
    });
  });
});
