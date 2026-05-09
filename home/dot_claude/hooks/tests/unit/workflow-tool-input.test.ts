#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { isWorkflowDocumentEdit } from "../../lib/workflow-tool-input.ts";

describe("workflow-tool-input.ts", () => {
  describe("isWorkflowDocumentEdit", () => {
    const wfDir = "/tmp/wf";

    it("detects spec.md edit via Write tool", () => {
      const r = isWorkflowDocumentEdit(
        "Write",
        { file_path: "/tmp/wf/spec.md", content: "x" },
        wfDir,
      );
      strictEqual(r.isEdit, true);
      strictEqual(r.targetType, "spec");
      strictEqual(r.targetPath, "/tmp/wf/spec.md");
    });

    it("detects plan-numbered edit via Edit tool", () => {
      const r = isWorkflowDocumentEdit(
        "Edit",
        { file_path: "/tmp/wf/plan-2.md", old_string: "a", new_string: "b" },
        wfDir,
      );
      strictEqual(r.targetType, "plan-numbered");
    });

    it("detects single-layer plan.md edit", () => {
      const r = isWorkflowDocumentEdit(
        "Edit",
        { file_path: "/tmp/wf/plan.md", old_string: "a", new_string: "b" },
        wfDir,
      );
      strictEqual(r.targetType, "plan");
    });

    it("detects lessons-learned.md as separate targetType", () => {
      const r = isWorkflowDocumentEdit(
        "Write",
        { file_path: "/tmp/wf/lessons-learned.md", content: "x" },
        wfDir,
      );
      strictEqual(r.targetType, "lessons-learned");
    });

    it("returns isEdit=false for unrelated file", () => {
      const r = isWorkflowDocumentEdit(
        "Edit",
        { file_path: "/tmp/other.ts", old_string: "a", new_string: "b" },
        wfDir,
      );
      strictEqual(r.isEdit, false);
      strictEqual(r.targetType, null);
    });

    it("returns isEdit=false for non-edit tools (Bash)", () => {
      const r = isWorkflowDocumentEdit("Bash", { command: "ls" }, wfDir);
      strictEqual(r.isEdit, false);
    });

    it("handles MultiEdit tool", () => {
      const r = isWorkflowDocumentEdit(
        "MultiEdit",
        { file_path: "/tmp/wf/spec.md", edits: [] },
        wfDir,
      );
      strictEqual(r.targetType, "spec");
    });

    it("handles NotebookEdit via notebook_path", () => {
      const r = isWorkflowDocumentEdit(
        "NotebookEdit",
        { notebook_path: "/tmp/wf/plan-1.md", new_source: "x" },
        wfDir,
      );
      strictEqual(r.targetType, "plan-numbered");
    });
  });
});
