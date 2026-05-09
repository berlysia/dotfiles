#!/usr/bin/env node --test

import { match, strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendLessonsForTesting,
  extractLessonsForTesting,
  normalizeLessonForTesting,
} from "../../implementations/lessons-learned-extractor.ts";

function setupWfDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "lle-")));
}

describe("lessons-learned-extractor pure helpers", () => {
  it("normalizeLesson: NFC + trim + collapse whitespace", () => {
    const a = normalizeLessonForTesting("  fixture を 実コードから 取れ  ");
    const b = normalizeLessonForTesting("fixture を 実コードから 取れ");
    strictEqual(a, b);
  });

  it("appendLessons enforces FIFO 50 cap", () => {
    const wfDir = setupWfDir();
    const path = join(wfDir, "lessons-learned.md");
    for (let i = 0; i < 60; i++) {
      appendLessonsForTesting(path, [`lesson ${i}`]);
    }
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    strictEqual(lines.length, 50);
    // FIFO: oldest (lesson 0-9) deleted, lesson 10-59 retained
    match(lines[0]!, /\blesson 10\b/);
    match(lines[49]!, /\blesson 59\b/);
  });

  it("appendLessons dedups across invocations (LESSON_PREFIX 非対称対応)", () => {
    const wfDir = setupWfDir();
    const path = join(wfDir, "lessons-learned.md");
    appendLessonsForTesting(path, ["lesson A"]);
    // Second round: same content with different whitespace should be deduped
    appendLessonsForTesting(path, ["  lesson  A  "]);
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    strictEqual(lines.length, 1, "dedup should work across invocations");
  });

  it("appendLessons writes atomically (file ends with newline)", () => {
    const wfDir = setupWfDir();
    const path = join(wfDir, "lessons-learned.md");
    appendLessonsForTesting(path, ["line 1", "line 2"]);
    const content = readFileSync(path, "utf-8");
    strictEqual(content.endsWith("\n"), true);
  });

  it("extractLessons (lightweight) parses '- 主指摘:' lines from Reviewer Outputs section", () => {
    const reviewerBlock = [
      "## Reviewer Outputs (Round 1)",
      "",
      "### logic-validator",
      "- verdict: pass",
      "- 主指摘: K4 の入力ソースが現運用と乖離している",
      "",
      "### scope-justification-reviewer",
      "- verdict: needs-evidence",
      "- 主指摘: P12 軽量パス却下根拠が薄い",
      "",
    ].join("\n");
    const lessons = extractLessonsForTesting(reviewerBlock);
    strictEqual(lessons.length, 2);
    match(lessons[0]!, /K4 の入力ソース/);
    match(lessons[1]!, /軽量パス却下根拠/);
  });

  it("extractLessons returns empty for block without bullet markers", () => {
    const block = "## Reviewer Outputs (Round 1)\nNo structured findings.";
    const lessons = extractLessonsForTesting(block);
    strictEqual(lessons.length, 0);
  });
});
