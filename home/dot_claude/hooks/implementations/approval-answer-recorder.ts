#!/usr/bin/env -S bun run --silent

/**
 * Records a human approval given by answering the AskUserQuestion that
 * `workflow-cli ask-approval` generates (spec K2/K3). Only `tool_response`
 * is read: PostToolUse's `tool_input` can carry a value the model wrote, so
 * nothing in it may decide what is recorded. The question in the response is
 * rebuilt from the current state of the documents and must match exactly, so
 * the user saw what the mechanism generated, at the hashes that are recorded.
 *
 * Anything that does not fit is reported, never recorded. An ordinary
 * AskUserQuestion (no approval-like question) is left alone: this hook says
 * nothing, so a question used as a general channel is not disturbed.
 */

import { defineHook } from "cc-hooks-ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { isApprovalLikeQuestion } from "../lib/workflow-approval.ts";
import {
  describeRecordResult,
  type AnswerVerification,
  verifyAndRecordApprovalAnswer,
} from "../lib/workflow-approval-record.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

const PREFIX = "[approval-answer-recorder]";
const RETRY_COMMAND = "`workflow-cli ask-approval`";

interface Reply {
  /** What the model reads. */
  text: string;
  /** What the user sees, when it should carry more than the model's text. */
  userText?: string;
}

function replyOutput({ text, userText }: Reply) {
  return {
    event: "PostToolUse" as const,
    output: {
      systemMessage: `${PREFIX} ${userText ?? text}`,
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext: `${PREFIX} ${text}`,
      },
    },
  };
}

function describeVerification(result: AnswerVerification): Reply | null {
  switch (result.kind) {
    case "notApproval":
      return null;
    case "afk":
      return {
        text: "記録していない。利用者が離席していた。利用者が戻って発言するまで質問を出し直さない。",
      };
    case "freeText":
      return {
        text: `記録していない。利用者の入力は承認ではなく発言として扱い、内容に答える。入力: ${JSON.stringify(result.text)}`,
      };
    case "malformed":
      return {
        text: `承認の質問の形と違うので記録していない。${RETRY_COMMAND} の出力をそのまま AskUserQuestion に渡してやり直す。`,
        userText: `承認の質問の形と違うので記録していない。${RETRY_COMMAND} の出力をそのまま渡してやり直すか、利用者が \`approve <文書名>\` と打つ。`,
      };
    case "notCandidate":
      return {
        text: `記録していない。${result.docs.join(", ")} は承認待ちでなくなった（版が変わった、または既に承認済み）。${RETRY_COMMAND} からやり直す。`,
      };
    case "decline":
      return {
        text: "記録していない。利用者は承認しなかった。何を直すか聞く。",
      };
    case "notes":
      return {
        text: `記録していない。利用者の指摘があるので先にこの指摘を扱う。指摘: ${JSON.stringify(result.notes)}`,
      };
    case "recorded": {
      const failed = result.results.filter((r) => r.state !== "recorded");
      const sentences = result.results.map((r) => {
        const base = describeRecordResult(r);
        return r.state === "recorded"
          ? `${base}。`
          : `${base}。${RETRY_COMMAND} をもう一度呼ぶとこの文書が質問に出る。`;
      });
      sentences.push(
        "編集する前に文書を読み直す。取り消すには承認行を pending に戻す。",
      );
      const text = sentences.join(" ");
      if (failed.length === 0) return { text };
      return {
        text,
        userText: `${text} model が質問を出し直さないときは \`approve ${failed.map((r) => r.doc).join(" ")}\` と打つ。`,
      };
    }
  }
}

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    // The matcher is a regex that could match a similarly named tool.
    if (context.input.tool_name !== "AskUserQuestion") {
      return context.success({});
    }
    try {
      const toolResponse: unknown = context.input.tool_response;
      const questions = (toolResponse as { questions?: unknown } | null)
        ?.questions;
      if (!isApprovalLikeQuestion(questions)) {
        return context.success({});
      }
      if (context.input.agent_id !== undefined) {
        return context.json(
          replyOutput({
            text: "承認の質問への回答だが、subagent の中の呼び出しなので記録していない。",
          }),
        );
      }
      const resolution = resolveWorkflowDir({
        cwd: getProjectRoot(),
        sessionId: context.input.session_id,
      });
      if (resolution.source === "unresolvable") {
        return context.json(
          replyOutput({
            text: "承認の質問への回答だが、この session の workflow dir を解決できないので何も記録していない。",
          }),
        );
      }
      const reply = describeVerification(
        verifyAndRecordApprovalAnswer(
          resolution.dir,
          toolResponse,
          context.input.session_id,
        ),
      );
      if (reply === null) return context.success({});
      return context.json(replyOutput(reply));
    } catch (error) {
      console.error("[approval-answer-recorder] internal error:", error);
      return context.json(
        replyOutput({
          text: `承認の記録中にエラーが起きた（${String(error).slice(0, 200)}）。記録できなかった可能性がある。\`workflow-cli status\` で確認する。`,
        }),
      );
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
