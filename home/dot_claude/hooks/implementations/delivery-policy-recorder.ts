#!/usr/bin/env -S bun run --silent

/**
 * Records the user's answer to the question `delivery-policy ask` prints:
 * how far an agent may take finished work in this repo. Only `tool_response`
 * is read, because PostToolUse's `tool_input` can carry what the model wrote.
 * The question in the response is rebuilt from the repo this hook resolves
 * itself and must match exactly, so the user saw what the mechanism
 * generated, naming the repo that gets recorded.
 *
 * Anything that does not fit is reported, never recorded. A question that is
 * not a Delivery policy question is left alone without a word.
 */

import { defineHook } from "cc-hooks-ts";
import {
  appendLedger,
  buildDeliveryPolicyQuestion,
  createGh,
  type Gh,
  isDeliveryPolicyQuestion,
  isScope,
  passwdHome,
  resolveRepo,
  type Scope,
} from "../lib/delivery-policy.ts";
import { deepEqualIgnoringKeyOrder } from "../lib/workflow-approval.ts";

const PREFIX = "[delivery-policy-recorder]";
const RESPONSE_KEYS = new Set(["questions", "answers", "annotations"]);

function hasNotes(annotations: unknown): boolean {
  if (typeof annotations !== "object" || annotations === null) return false;
  return Object.values(annotations).some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { notes?: unknown }).notes === "string",
  );
}

export interface RecorderDeps {
  /** The passwd home, or null when it could not be determined. Never read from the environment. */
  home: string | null;
  /** gh bound to the directory whose repo the question must name. */
  ghFor: (cwd: string) => Gh;
  now: () => Date;
}

export type RecordOutcome =
  | { kind: "ignore" }
  | { kind: "skip"; reason: string }
  | { kind: "recorded"; repo: string; scope: Scope };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function recordDeliveryPolicyAnswer(
  toolResponse: unknown,
  deps: RecorderDeps,
  cwd: string,
): Promise<RecordOutcome> {
  const r = isPlainObject(toolResponse) ? toolResponse : undefined;
  if (r === undefined || !isDeliveryPolicyQuestion(r.questions)) {
    return { kind: "ignore" };
  }
  if (Object.hasOwn(r, "afkTimeoutMs")) {
    return { kind: "skip", reason: "利用者が離席していた（afk の時間切れ）" };
  }
  if (Object.hasOwn(r, "response")) {
    return {
      kind: "skip",
      reason:
        "回答が選択肢ではなく自由記述だった。発言として扱い、内容に答える",
    };
  }
  // The client sends `annotations` on plain answers too (e.g. previews), so
  // only a string `notes` means the user wrote something beside the choice.
  // Same test as the Document Workflow approval recorder.
  if (hasNotes(r.annotations)) {
    return {
      kind: "skip",
      reason: "回答に annotations（notes）が付いていた。先にその指摘を扱う",
    };
  }
  if (!Object.keys(r).every((k) => RESPONSE_KEYS.has(k))) {
    return { kind: "skip", reason: "回答に未知のキーが含まれていた" };
  }
  const { questions, answers } = r;
  if (!Array.isArray(questions) || questions.length !== 1) {
    return { kind: "skip", reason: "質問が 1 つでなかった" };
  }
  const question = questions[0];
  if (!isPlainObject(question) || typeof question.question !== "string") {
    return { kind: "skip", reason: "質問の形が違う" };
  }
  if (!isPlainObject(answers)) {
    return { kind: "skip", reason: "answers が object でなかった" };
  }
  const keys = Object.keys(answers);
  if (keys.length !== 1 || keys[0] !== question.question) {
    return { kind: "skip", reason: "answers のキーが質問文と一致しない" };
  }
  const answer = answers[question.question];
  if (!isScope(answer)) {
    return {
      kind: "skip",
      reason: "答えが選択肢（commit / pr / merge）の外だった",
    };
  }
  if (deps.home === null) {
    return { kind: "skip", reason: "passwd の home を決められなかった" };
  }
  const resolved = await resolveRepo(deps.ghFor(cwd));
  if (!resolved.ok) {
    return {
      kind: "skip",
      reason: `repo を決められなかった（${resolved.reason}）`,
    };
  }
  const rebuilt = buildDeliveryPolicyQuestion(
    resolved.repo.nameWithOwner,
    resolved.repo.url,
  );
  if (!deepEqualIgnoringKeyOrder(rebuilt, questions)) {
    return {
      kind: "skip",
      reason: `質問が、この cwd の repo（${resolved.repo.nameWithOwner}）から作った質問と一致しない`,
    };
  }
  appendLedger(deps.home, {
    repo: resolved.repo.nameWithOwner,
    scope: answer,
    at: deps.now().toISOString(),
  });
  return { kind: "recorded", repo: resolved.repo.nameWithOwner, scope: answer };
}

function replyOutput(text: string) {
  return {
    event: "PostToolUse" as const,
    output: {
      systemMessage: `${PREFIX} ${text}`,
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext: `${PREFIX} ${text}`,
      },
    },
  };
}

export function createRecorderHook(deps: RecorderDeps) {
  return defineHook({
    trigger: { PostToolUse: true },
    run: async (context) => {
      // The matcher is a regex that could match a similarly named tool.
      if (context.input.tool_name !== "AskUserQuestion") {
        return context.success({});
      }
      try {
        const toolResponse: unknown = context.input.tool_response;
        const questions = (toolResponse as { questions?: unknown } | null)
          ?.questions;
        if (!isDeliveryPolicyQuestion(questions)) {
          return context.success({});
        }
        // Nothing is said for a subagent: its call is not the user's answer,
        // and a reason line would be addressed to the wrong reader.
        if (context.input.agent_id !== undefined) {
          return context.success({});
        }
        const outcome = await recordDeliveryPolicyAnswer(
          toolResponse,
          deps,
          context.input.cwd,
        );
        switch (outcome.kind) {
          case "ignore":
            return context.success({});
          case "skip":
            return context.json(
              replyOutput(`記録していない。${outcome.reason}`),
            );
          case "recorded":
            return context.json(
              replyOutput(`${outcome.repo} を ${outcome.scope} と記録した`),
            );
        }
      } catch (error) {
        console.error("[delivery-policy-recorder] internal error:", error);
        return context.json(
          replyOutput(
            `記録中にエラーが起きた（${String(error).slice(0, 200)}）。記録できなかった可能性がある。\`delivery-policy show\` で確認する。`,
          ),
        );
      }
    },
  });
}

const hook = createRecorderHook({
  home: passwdHome(),
  // The hook's own timeout is 15 s; one gh call must end before it.
  ghFor: (cwd) => {
    const gh = createGh(cwd);
    return (args) => gh(args, { timeoutMs: 10_000 });
  },
  now: () => new Date(),
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
