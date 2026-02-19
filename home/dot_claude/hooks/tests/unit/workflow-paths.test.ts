#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  getWorkflowDir,
  getPlanPath,
  getResearchPath,
  getStatePath,
  getReviewCachePath,
  getReviewMarkdownPath,
  getReviewJsonPath,
  isWorkflowDocumentPath,
  isPlanFile,
  getWorkflowDirRelative,
  resolveReviewOutputPaths,
} from "../../lib/workflow-paths.ts";
import { EnvironmentHelper } from "./test-helpers.ts";

describe("workflow-paths.ts", () => {
  const envHelper = new EnvironmentHelper();

  afterEach(() => {
    envHelper.restore();
  });

  describe("getWorkflowDir", () => {
    it("returns .tmp/ when DOCUMENT_WORKFLOW_DIR is not set", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      const cwd = "/project";
      strictEqual(getWorkflowDir(cwd), resolve(cwd, ".tmp"));
    });

    it("returns session dir when DOCUMENT_WORKFLOW_DIR is set", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234");
      const cwd = "/project";
      strictEqual(
        getWorkflowDir(cwd),
        resolve(cwd, ".tmp/sessions/abcd1234"),
      );
    });

    it("ignores empty DOCUMENT_WORKFLOW_DIR", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", "");
      const cwd = "/project";
      strictEqual(getWorkflowDir(cwd), resolve(cwd, ".tmp"));
    });
  });

  describe("path accessors", () => {
    it("getPlanPath returns plan.md in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(getPlanPath("/project"), resolve("/project", ".tmp/plan.md"));
    });

    it("getResearchPath returns research.md in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(
        getResearchPath("/project"),
        resolve("/project", ".tmp/research.md"),
      );
    });

    it("getStatePath returns workflow-state.json in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(
        getStatePath("/project"),
        resolve("/project", ".tmp/workflow-state.json"),
      );
    });

    it("getReviewCachePath returns plan-review.cache.json in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234");
      strictEqual(
        getReviewCachePath("/project"),
        resolve("/project", ".tmp/sessions/abcd1234/plan-review.cache.json"),
      );
    });

    it("getReviewMarkdownPath returns plan-review.md in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234");
      strictEqual(
        getReviewMarkdownPath("/project"),
        resolve("/project", ".tmp/sessions/abcd1234/plan-review.md"),
      );
    });

    it("getReviewJsonPath returns plan-review.json in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234");
      strictEqual(
        getReviewJsonPath("/project"),
        resolve("/project", ".tmp/sessions/abcd1234/plan-review.json"),
      );
    });

    it("all paths respect DOCUMENT_WORKFLOW_DIR", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/xyz");
      const cwd = "/project";
      const dir = resolve(cwd, ".tmp/sessions/xyz");
      strictEqual(getPlanPath(cwd), resolve(dir, "plan.md"));
      strictEqual(getResearchPath(cwd), resolve(dir, "research.md"));
      strictEqual(getStatePath(cwd), resolve(dir, "workflow-state.json"));
    });
  });

  describe("isWorkflowDocumentPath", () => {
    it("returns true for plan.md in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(isWorkflowDocumentPath("/project", ".tmp/plan.md"), true);
    });

    it("returns true for research.md in workflow dir", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(isWorkflowDocumentPath("/project", ".tmp/research.md"), true);
    });

    it("returns false for unrelated file", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(isWorkflowDocumentPath("/project", "src/app.ts"), false);
    });

    it("returns true for session-specific plan.md when env is set", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234");
      strictEqual(
        isWorkflowDocumentPath("/project", ".tmp/sessions/abcd1234/plan.md"),
        true,
      );
    });

    it("returns false for default plan.md when session env is set", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234");
      strictEqual(isWorkflowDocumentPath("/project", ".tmp/plan.md"), false);
    });

    it("handles absolute paths", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(
        isWorkflowDocumentPath("/project", "/project/.tmp/plan.md"),
        true,
      );
    });
  });

  describe("isPlanFile", () => {
    it("returns true for legacy plan.md", () => {
      strictEqual(isPlanFile("/project/.tmp/plan.md"), true);
    });

    it("returns true for session-specific plan.md", () => {
      strictEqual(
        isPlanFile("/project/.tmp/sessions/abcd1234/plan.md"),
        true,
      );
    });

    it("returns false for non-plan file", () => {
      strictEqual(isPlanFile("/project/src/app.ts"), false);
    });

    it("returns false for plan.mdx", () => {
      strictEqual(isPlanFile("/project/.tmp/plan.mdx"), false);
    });
  });

  describe("resolveReviewOutputPaths", () => {
    it("resolves review output files in the given directory", () => {
      const dir = "/project/.tmp/sessions/abcd1234";
      const paths = resolveReviewOutputPaths(dir);
      strictEqual(paths.cachePath, resolve(dir, "plan-review.cache.json"));
      strictEqual(paths.markdownPath, resolve(dir, "plan-review.md"));
      strictEqual(paths.jsonPath, resolve(dir, "plan-review.json"));
    });

    it("works with legacy .tmp directory", () => {
      const dir = "/project/.tmp";
      const paths = resolveReviewOutputPaths(dir);
      strictEqual(paths.cachePath, resolve(dir, "plan-review.cache.json"));
      strictEqual(paths.markdownPath, resolve(dir, "plan-review.md"));
      strictEqual(paths.jsonPath, resolve(dir, "plan-review.json"));
    });
  });

  describe("getWorkflowDirRelative", () => {
    it("returns .tmp when env is not set", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      strictEqual(getWorkflowDirRelative(), ".tmp");
    });

    it("returns env value when set", () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234");
      strictEqual(getWorkflowDirRelative(), ".tmp/sessions/abcd1234");
    });
  });
});
