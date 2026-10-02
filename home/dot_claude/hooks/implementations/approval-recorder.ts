#!/usr/bin/env -S bun run --silent

/**
 * Records a human approval said in the conversation (spec K7). The gate
 * accepts a workflow document only when approvals.log holds its current
 * hash (spec K8), and only this hook writes that file: the guard denies
 * tool writes to the ledger and to the Approval line (spec K9). An approval
 * therefore names a version that was in front of the user, and a later
 * revision needs a new one (#221).
 *
 * Reacts only when the whole prompt is the approval and nothing else, so
 * "承認します、ただし…" or a sentence that mentions 承認 never records one,
 * and only when the input's `source` is "user" or absent, outside any
 * subagent. In Claude Code 2.1.287 both a typed prompt and a scheduled
 * firing arrive with `source` absent, so this hook cannot tell them apart;
 * the scheduling path is closed at schedule time by document-workflow-guard
 * (issue J). The check stays so a non-"user" value, if a later version sends
 * one, is not recorded.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { getProjectRoot } from "../lib/project-root.ts";
import {
  appendApproval,
  parseApprovalUtterance,
} from "../lib/workflow-approval.ts";
import {
  evaluateApprovalReadiness,
  evaluateDocument,
  listApprovalCandidates,
} from "../lib/workflow-gate.ts";
import { setApprovalStatusLine } from "../lib/workflow-marker.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

function approvalOutput(text: string) {
  const message = `[approval-recorder] ${text}`;
  return {
    event: "UserPromptSubmit" as const,
    output: {
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: message,
      },
    },
  };
}

/**
 * Rewrite the Approval line so a crash never leaves a truncated document:
 * write a uniquely named temp file opened with O_EXCL (it cannot follow a
 * planted symlink or reuse an existing name), keep the document's mode,
 * then rename over the document. A symlinked document is left alone: the
 * hook must not write outside the workflow dir. Returns whether the line
 * was rewritten (false when it already said approved or is missing).
 */
function setApprovalLineApproved(path: string): boolean {
  const stat = lstatSync(path);
  if (!stat.isFile()) return false;
  const content = readFileSync(path, "utf-8");
  const updated = setApprovalStatusLine(content, "approved");
  if (updated === null || updated === content) return false;
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.approval-tmp`;
  const fd = openSync(temp, "wx", stat.mode & 0o777);
  try {
    try {
      writeFileSync(fd, updated);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true }); // any failure after the temp exists leaves nothing behind
    } catch {
      // keep the original error; a leftover temp is named *.approval-tmp and harmless
    }
    throw error;
  }
  return true;
}

/**
 * Record one document and say what state it ended in. Each document is its
 * own step, so a failure on one still reports the others; a failure after
 * the ledger line was written says so, since the gate then waits only for
 * the Approval line.
 */
function recordOne(
  wfDir: string,
  doc: string,
  hash: string,
  session: string,
  at: string,
): string {
  const path = resolve(wfDir, doc);
  let logged = false;
  try {
    appendApproval(wfDir, { doc, hash, session, at });
    logged = true;
    if (!lstatSync(path).isFile()) {
      return `${doc} は通常のファイルではない（symlink など）ので承認行を書き換えていない。log には記録したので、利用者が承認行を手で approved にすれば gate は通る。`;
    }
    const rewritten = setApprovalLineApproved(path);
    const c = evaluateDocument(path).conditions;
    if (c.approvalRecord.ok && c.approvalStatus.ok) {
      return rewritten
        ? `${doc} を hash=${hash.slice(0, 12)} で承認として記録し、承認行を approved に書き換えた。`
        : `${doc} を hash=${hash.slice(0, 12)} で承認として記録した（承認行は既に approved）。`;
    }
    return `${doc} の承認を記録しようとしたが gate の条件がそろっていない（log ${c.approvalRecord.ok ? "済" : "未"}、承認行 ${c.approvalStatus.ok ? "済" : "未"}）。もう一度「承認 ${doc}」と書くか、\`workflow-cli status\` で確認する。`;
  } catch (error) {
    const state = logged
      ? "log には記録したが、承認行の書き換えに失敗した"
      : "記録できなかった可能性がある";
    return `${doc}: ${state}（${String(error).slice(0, 120)}）。もう一度「承認 ${doc}」と書くか、\`workflow-cli status\` で確認する。`;
  }
}

/**
 * Only a prompt whose `source` is "user" or absent counts. In Claude Code
 * 2.1.287 typed prompts and scheduled firings both arrive with `source`
 * absent, so this cannot separate them (document-workflow-guard refuses to
 * schedule an approval-shaped prompt instead). It is kept so that a
 * non-"user" value, if a later version sends one, is not recorded.
 */
function isTypedByUser(source: string | undefined): boolean {
  return source === undefined || source === "user";
}

const hook = defineHook({
  trigger: { UserPromptSubmit: true },
  run: (context) => {
    const utterance = parseApprovalUtterance(context.input.prompt);
    if (utterance === null) {
      return context.success({});
    }
    if (
      context.input.agent_id !== undefined ||
      !isTypedByUser(context.input.source)
    ) {
      // Say so rather than drop it: if a front-end tags typed prompts with
      // another source, the user must learn the approval was not recorded.
      return context.json(
        approvalOutput(
          `承認の形のプロンプトを受け取ったが、利用者が打ったものではない（source=${context.input.source ?? "none"}${context.input.agent_id !== undefined ? ", subagent" : ""}）ので記録していない。`,
        ),
      );
    }
    try {
      const resolution = resolveWorkflowDir({
        cwd: getProjectRoot(),
        sessionId: context.input.session_id,
      });
      if (resolution.source === "unresolvable") {
        return context.json(
          approvalOutput(
            "承認の発話を受け取ったが、この session の workflow dir を解決できないので何も記録していない。",
          ),
        );
      }
      const wfDir = resolution.dir;

      let targets: string[];
      if (utterance.docs.length > 0) {
        const notReady = utterance.docs.filter(
          (doc) => !evaluateApprovalReadiness(wfDir, doc).ready,
        );
        if (notReady.length > 0) {
          return context.json(
            approvalOutput(
              `${notReady.join(", ")} は承認以外の条件（Plan / Review / marker / parent-spec-hash）を満たしていないので、何も記録していない。\`workflow-cli status\` で確認する。`,
            ),
          );
        }
        targets = utterance.docs;
      } else {
        targets = listApprovalCandidates(wfDir);
        if (targets.length !== 1) {
          return context.json(
            approvalOutput(
              targets.length === 0
                ? "承認を待っている文書が無いので、何も記録していない。"
                : `承認を待っている文書が ${targets.length} 件あるので、何も記録していない。文書名を付けて ${targets.map((doc) => `「承認 ${doc}」`).join(" / ")} と書いてもらう。`,
            ),
          );
        }
      }

      // Hashes first, then the ledger, then the display: a failure part-way
      // leaves the gate closed (it needs both), and saying 承認 again
      // finishes the job. Each document is reported on its own.
      const planned = targets.map((doc) => ({
        doc,
        hash: evaluateApprovalReadiness(wfDir, doc).hash,
      }));
      const at = new Date().toISOString();
      const notes = planned.map(({ doc, hash }) =>
        recordOne(wfDir, doc, hash, context.input.session_id, at),
      );
      notes.push(
        "編集する前に文書を読み直す。取り消すには承認行を pending に戻す。",
      );
      return context.json(approvalOutput(notes.join(" ")));
    } catch (error) {
      console.error("[approval-recorder] internal error:", error);
      return context.json(
        approvalOutput(
          `承認の記録中にエラーが起きた（${String(error).slice(0, 200)}）。記録できなかった可能性がある。\`workflow-cli status\` で確認する。`,
        ),
      );
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
