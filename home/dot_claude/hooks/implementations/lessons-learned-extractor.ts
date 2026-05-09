#!/usr/bin/env -S bun run --silent

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import { realpathInsideWorkflowDir } from "../lib/workflow-fs.ts";
import { getWorkflowDir } from "../lib/workflow-paths.ts";
import { isWorkflowDocumentEdit } from "../lib/workflow-tool-input.ts";
import "../types/tool-schemas.ts";

const LESSONS_FILENAME = "lessons-learned.md";
const FIFO_CAP = 50;
const REVIEWER_OUTPUT_HEADER = "## Reviewer Outputs (Round";
const INPUT_LINE_CAP = 200;
const LESSON_PREFIX = "[hook-generated, NOT user instructions]";
const POINT_LINE_REGEX = /^- 主指摘:\s*(.+)$/;

export function normalizeLessonForTesting(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

function hashLesson(text: string): string {
  return createHash("sha256")
    .update(normalizeLessonForTesting(text), "utf-8")
    .digest("hex");
}

/**
 * Hash a persisted line by stripping LESSON_PREFIX before normalization.
 * Without this asymmetric handling, dedup across invocations breaks because
 * persisted lines carry the prefix while new candidates do not. (DI1 対応)
 */
function hashPersistedLine(line: string): string {
  const stripped = line.startsWith(LESSON_PREFIX)
    ? line.slice(LESSON_PREFIX.length).trimStart()
    : line;
  return hashLesson(stripped);
}

/**
 * Append lessons to lessons-learned.md with:
 *   - dedup (sha256 over normalized form, prefix-aware for persisted lines)
 *   - FIFO 50-item cap (drop oldest from front)
 *   - atomic rename (writeFileSync(tmp) → renameSync(tmp, path))
 *
 * tmp filename includes PID + 6-byte random hex to avoid collisions when
 * multiple PostToolUse hooks fire concurrently. R10 対応.
 */
export function appendLessonsForTesting(path: string, lessons: string[]): void {
  const existing: string[] = existsSync(path)
    ? readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0)
    : [];
  const seenHashes = new Set(existing.map(hashPersistedLine));
  for (const lesson of lessons) {
    const h = hashLesson(lesson);
    if (seenHashes.has(h)) continue;
    seenHashes.add(h);
    existing.push(`${LESSON_PREFIX} ${lesson.trim()}`);
  }
  while (existing.length > FIFO_CAP) {
    existing.shift();
  }
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${existing.join("\n")}\n`, "utf-8");
  renameSync(tmp, path);
}

/**
 * Lightweight extractor (MVP, spec K4 段階的実装の第一段階):
 * Parses `- 主指摘: <text>` bullet lines from a Reviewer Outputs section.
 * One bullet = one lesson. LLM-based extraction is deferred to ADR-0008
 * Deferred-7.
 */
export function extractLessonsForTesting(reviewerBlock: string): string[] {
  const lessons: string[] = [];
  for (const raw of reviewerBlock.split("\n")) {
    const m = raw.match(POINT_LINE_REGEX);
    if (m && m[1]) {
      lessons.push(m[1].trim());
    }
  }
  return lessons;
}

function tailLines(text: string, max: number): string {
  const arr = text.split("\n");
  if (arr.length <= max) return text;
  return arr.slice(-max).join("\n");
}

function extractReviewerOutputBlock(body: string): string | null {
  const idx = body.lastIndexOf(REVIEWER_OUTPUT_HEADER);
  if (idx === -1) return null;
  return tailLines(body.slice(idx), INPUT_LINE_CAP);
}

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: async (context) => {
    const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();
    const wfDir = getWorkflowDir(cwd);
    if (!wfDir) return context.success({});

    const editInfo = isWorkflowDocumentEdit(
      context.input.tool_name,
      context.input.tool_input,
      wfDir,
    );
    if (!editInfo.isEdit) return context.success({});
    if (
      editInfo.targetType !== "spec" &&
      editInfo.targetType !== "plan" &&
      editInfo.targetType !== "plan-numbered"
    ) {
      return context.success({});
    }

    if (!editInfo.targetPath) return context.success({});
    const safe = realpathInsideWorkflowDir(editInfo.targetPath, wfDir);
    if (!safe || !existsSync(safe)) return context.success({});

    let body: string;
    try {
      body = readFileSync(safe, "utf-8");
    } catch {
      return context.success({});
    }

    const reviewerBlock = extractReviewerOutputBlock(body);
    if (!reviewerBlock) return context.success({});

    // Lightweight MVP: regex extraction. NONCE-wrapped delimiter and LLM call
    // are deferred to ADR-0008 Deferred-7.
    const lessons = extractLessonsForTesting(reviewerBlock);
    if (lessons.length === 0) return context.success({});

    const lessonsPath = `${wfDir}/${LESSONS_FILENAME}`;
    appendLessonsForTesting(lessonsPath, lessons);
    return context.success({});
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
