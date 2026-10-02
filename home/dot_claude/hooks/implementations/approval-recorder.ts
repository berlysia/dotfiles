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

import { defineHook } from "cc-hooks-ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { parseApprovalUtterance } from "../lib/workflow-approval.ts";
import {
  describeRecordResult,
  recordOne,
} from "../lib/workflow-approval-record.ts";
import {
  evaluateApprovalReadiness,
  listApprovalCandidates,
} from "../lib/workflow-gate.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

/** `userText` is shown to the user when it should differ from what the model reads. */
function approvalOutput(text: string, userText?: string) {
  return {
    event: "UserPromptSubmit" as const,
    output: {
      systemMessage: `[approval-recorder] ${userText ?? text}`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: `[approval-recorder] ${text}`,
      },
    },
  };
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
        if (targets.length === 0) {
          return context.json(
            approvalOutput(
              "承認を待っている文書が無いので、何も記録していない。",
            ),
          );
        }
        if (targets.length > 1) {
          const text = `承認を待っている文書が ${targets.length} 件あるので記録していない。\`workflow-cli ask-approval\` を実行し、その出力をそのまま AskUserQuestion に渡して聞き直す。`;
          return context.json(
            approvalOutput(
              text,
              `${text}質問が出ない場合は \`approve <文書名…>\` と打つ（例: \`approve ${targets.join(" ")}\`）。`,
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
      const notes = planned.map(
        ({ doc, hash }) =>
          `${describeRecordResult(
            recordOne(
              wfDir,
              doc,
              hash,
              context.input.session_id,
              at,
              "utterance",
            ),
          )}。`,
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
