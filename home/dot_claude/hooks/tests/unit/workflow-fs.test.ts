#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { realpathInsideWorkflowDir } from "../../lib/workflow-fs.ts";

describe("workflow-fs.ts", () => {
  describe("realpathInsideWorkflowDir", () => {
    it("returns null for symlink that escapes the workflow dir", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      const outsideTarget = join(tmpRoot, "outside.md");
      writeFileSync(outsideTarget, "outside");
      const linkInside = join(wfDir, "spec.md");
      symlinkSync(outsideTarget, linkInside);
      strictEqual(realpathInsideWorkflowDir(linkInside, wfDir), null);
    });

    it("returns the resolved path for a legitimate file inside workflow dir", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      const insideFile = join(wfDir, "spec.md");
      writeFileSync(insideFile, "content");
      strictEqual(realpathInsideWorkflowDir(insideFile, wfDir), insideFile);
    });

    it("returns null when the path does not exist", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      strictEqual(
        realpathInsideWorkflowDir(join(wfDir, "nonexistent.md"), wfDir),
        null,
      );
    });

    it("accepts the workflow dir itself", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      strictEqual(realpathInsideWorkflowDir(wfDir, wfDir), wfDir);
    });
  });
});
