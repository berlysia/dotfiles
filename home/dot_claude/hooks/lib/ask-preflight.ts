// lib/ask-preflight.ts
//
// Pure parts of the ask-preflight hook: which AskUserQuestion calls are let
// through unchecked, the fixed deny text, the decision rows and their summary.
//
// The hook bounces a question once per user input so the model can check
// whether it needs to ask. Every exclusion below only ever lets a question
// through; a miss in this file costs one extra model round trip, never an
// approval or an irreversible step. Rationale: docs/decisions/0044-*.md.

import { createHash } from "node:crypto";
import {
  extractQuestionTexts,
  hasPrefilledAnswer,
} from "./ask-user-question-input.ts";
import { isDeliveryPolicyQuestion } from "./delivery-policy.ts";
import { isApprovalLikeQuestion } from "./workflow-approval.ts";

export const PREFLIGHT_REASON =
  "AskUserQuestion を出す前に点検する。(1) この質問と同じ対象・同じ選択肢について、利用者のこれまでの発言か過去の AskUserQuestion への回答に、答えがはっきり書かれている（その後に事情が変わっていれば該当しない）。(2) ファイル、コード、文書を読めば決まる。(3) 規則か承認済みの計画が、すでに決めている手順である。(4) 自分の推奨を受けるかどうかだけを聞く確認で、争点がなく、作業ツリーの中で完結し、元に戻せる。どれかに該当すれば聞かずに進め、該当した番号と根拠を 1 行で報告する。どれにも該当しなければ、同じ質問を AskUserQuestion でもう一度出す（次は通る）。文章で聞き直さない。次の質問は、該当しても聞く: 承認、元に戻せない操作、外部への送信・公開、設計判断（API・アーキテクチャ・データモデル）、スコープ、利用者の意図の解釈、規則が人間への確認を定めている質問（Scope Guard の戦略、reframer の後の進め方、委任、利用者の提案が問題に合わないときの判断）";

// --- irreversible-operation words -----------------------------------------

// shell-verb lists in lib/destructive-verbs.ts are not reused: they are
// verbs of commands, and a question's wording is prose.
//
// Inflections are generated from the base word because a boundary-matched
// "delete" misses "deleting" and "pushed". Over-generated forms ("pushd") are
// harmless: a wrong match only lets a question through.
const ASCII_BASE_WORDS = [
  "push",
  "merge",
  "force",
  "delete",
  "remove",
  "rm",
  "reset",
  "rebase",
  "amend",
  "drop",
  "deploy",
  "publish",
  "release",
  "send",
  "apply",
  "restart",
  "overwrite",
  "truncate",
  "kill",
  "revoke",
  "uninstall",
];

// Forms the suffix rules below cannot produce.
const ASCII_IRREGULAR_FORMS = [
  "dropped",
  "dropping",
  "resetting",
  "sent",
  "applies",
  "applied",
  "overwrote",
  "overwritten",
];

function inflect(base: string): string[] {
  if (base === "rm") return [base];
  const stem = base.endsWith("e") ? base.slice(0, -1) : base;
  return [base, `${base}s`, `${base}es`, `${base}d`, `${base}ed`, `${stem}ing`];
}

const ASCII_WORD_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_])(?:${[...ASCII_BASE_WORDS.flatMap(inflect), ...ASCII_IRREGULAR_FORMS].join("|")})(?![A-Za-z0-9_])`,
  "i",
);

// Case-sensitive on purpose: "pr" appears in ordinary words and file names.
const PR_PATTERN = /(?<![A-Za-z0-9_])PRs?(?![A-Za-z0-9_])/;

const JAPANESE_WORDS = [
  "プッシュ",
  "マージ",
  "削除",
  "消し",
  "消す",
  "消去",
  "上書き",
  "リセット",
  "取り消",
  "デプロイ",
  "公開",
  "リリース",
  "送信",
  "送っ",
  "送る",
  "再起動",
  "課金",
  "支払",
];

function mentionsIrreversibleOperation(text: string): boolean {
  return (
    ASCII_WORD_PATTERN.test(text) ||
    PR_PATTERN.test(text) ||
    JAPANESE_WORDS.some((word) => text.includes(word))
  );
}

// --- judgement ---------------------------------------------------------------

/** Question text plus option labels beyond this are not matched at all. */
export const MAX_MATCHED_CHARS = 4000;

export interface PreflightFacts {
  toolInput: unknown;
  hasAgentId: boolean;
  /** `listApprovalCandidates` returned at least one document. */
  hasApprovalCandidates: boolean;
  hasSignFailureMarker: boolean;
}

export type PassReason =
  | "subagent"
  | "approval-candidates"
  | "approval-question"
  | "delivery-policy-question"
  | "prefilled-answer"
  | "judge-failed"
  | "too-long"
  | "irreversible-word"
  | "sign-failure";

export type PreflightVerdict =
  | { kind: "pass"; reason: PassReason }
  | { kind: "bounce-candidate" };

function pass(reason: PassReason): PreflightVerdict {
  return { kind: "pass", reason };
}

/**
 * Whether the call is let through, or is a candidate for the one bounce per
 * user input. Whether that bounce already happened is the caller's to check.
 * Total: any input yields a verdict.
 */
export function judgeAskPreflight(facts: PreflightFacts): PreflightVerdict {
  try {
    if (facts.hasAgentId) return pass("subagent");
    if (facts.hasApprovalCandidates) return pass("approval-candidates");
    const questions = (facts.toolInput as { questions?: unknown } | null)
      ?.questions;
    if (isApprovalLikeQuestion(questions)) return pass("approval-question");
    if (isDeliveryPolicyQuestion(questions)) {
      return pass("delivery-policy-question");
    }
    if (hasPrefilledAnswer(facts.toolInput)) return pass("prefilled-answer");
    const texts = extractQuestionTexts(facts.toolInput);
    if (texts === null) return pass("judge-failed");
    const joined = texts.join("\n");
    if (joined.length - (texts.length - 1) > MAX_MATCHED_CHARS) {
      return pass("too-long");
    }
    if (mentionsIrreversibleOperation(joined)) {
      return pass("irreversible-word");
    }
    if (facts.hasSignFailureMarker) return pass("sign-failure");
    return { kind: "bounce-candidate" };
  } catch {
    return pass("judge-failed");
  }
}

// --- correlation hash ----------------------------------------------------------

/**
 * A correlation id for "the same question again inside one session": the
 * question text and labels, whitespace folded, mixed with a per-session salt.
 * It is not a protection of the text; the rows hold no text at all.
 */
export function questionHash(toolInput: unknown, salt: string): string | null {
  const texts = extractQuestionTexts(toolInput);
  if (texts === null) return null;
  const folded = texts.join(" ").replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update(`${salt}\n${folded}`)
    .digest("hex")
    .slice(0, 16);
}

// --- decision rows ----------------------------------------------------------------

export type DecisionKind = "bounce" | "pass" | "prompt";

export interface DecisionRow {
  at: string;
  sessionId: string;
  kind: DecisionKind;
  /** A fixed kind label (a PassReason, or "preflight" for a bounce); never question text. */
  reason?: string;
  hash?: string;
}

/**
 * decisions.jsonl stops growing here, and a summary reads no further: the
 * file lives until the notification is out, so it needs a bound of its own.
 */
export const DECISIONS_MAX_BYTES = 1024 * 1024;

export function formatDecisionRow(row: DecisionRow): string {
  return `${JSON.stringify(row)}\n`;
}

function isDecisionKind(value: unknown): value is DecisionKind {
  return value === "bounce" || value === "pass" || value === "prompt";
}

function parseDecisionRow(line: string): DecisionRow | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { at, sessionId, kind, reason, hash } = value as Record<
    string,
    unknown
  >;
  if (typeof at !== "string" || typeof sessionId !== "string") return null;
  if (!isDecisionKind(kind)) return null;
  if (reason !== undefined && typeof reason !== "string") return null;
  if (hash !== undefined && typeof hash !== "string") return null;
  return {
    at,
    sessionId,
    kind,
    ...(reason === undefined ? {} : { reason }),
    ...(hash === undefined ? {} : { hash }),
  };
}

/** Lines that cannot be read are skipped, not counted. */
export function parseDecisionRows(text: string): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const row = parseDecisionRow(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

// --- summary and notification --------------------------------------------------------

export const NOTIFY_AT_BOUNCES = 30;
/** Below this share of bounces that were not asked again, the notice carries the back-out steps. */
const WITHDRAWAL_RATE_THRESHOLD = 0.1;

export interface DecisionSummary {
  bounces: number;
  /** Bounces followed by a later prompt in the same session. */
  eligible: number;
  /** Eligible bounces with no same-hash pass between the bounce and that prompt. */
  notReturned: number;
  rate: number | null;
  /** Prompt rows after the first of the most recent 30 bounces. */
  promptsSinceRecent: number;
}

export function summarizeDecisions(
  rows: readonly DecisionRow[],
): DecisionSummary {
  const bounceIndexes: number[] = [];
  let eligible = 0;
  let notReturned = 0;
  rows.forEach((bounce, i) => {
    if (bounce.kind !== "bounce") return;
    bounceIndexes.push(i);
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (next === undefined || next.sessionId !== bounce.sessionId) continue;
      if (next.kind === "prompt") {
        eligible++;
        const asked = rows
          .slice(i + 1, j)
          .some(
            (between) =>
              between.kind === "pass" &&
              between.sessionId === bounce.sessionId &&
              between.hash !== undefined &&
              between.hash === bounce.hash,
          );
        if (!asked) notReturned++;
        return;
      }
    }
  });
  const recent = bounceIndexes.slice(-NOTIFY_AT_BOUNCES);
  const firstRecent = recent[0];
  const promptsSinceRecent =
    firstRecent === undefined
      ? 0
      : rows.slice(firstRecent + 1).filter((r) => r.kind === "prompt").length;
  return {
    bounces: bounceIndexes.length,
    eligible,
    notReturned,
    rate: eligible === 0 ? null : notReturned / eligible,
    promptsSinceRecent,
  };
}

const COUNT_NOTE = "累計は decisions.jsonl に残る分で数えた。";

/**
 * Built from fixed text and numbers only: rows are data on disk that the
 * model can write, and nothing read from them may reach a message.
 */
export function buildNotificationMessage(summary: DecisionSummary): string {
  const head = `[ask-preflight] AskUserQuestion の点検の差し戻しが ${summary.bounces} 件に達した。${COUNT_NOTE}`;
  if (summary.promptsSinceRecent === 0) {
    return `${head}利用者の入力で走る分岐の記録が無い。settings の UserPromptSubmit に ask-preflight のエントリがあるか確かめる。`;
  }
  const rate = summary.rate;
  if (rate === null) {
    return `${head}出直さなかった割合は、分母が 0 で数えられなかった。文章での質問と言い換えた出し直しは transcript の再計測で確かめる。`;
  }
  const share = `出直さなかった割合は ${(rate * 100).toFixed(1)}%（${summary.notReturned}/${summary.eligible}）。`;
  const remeasure =
    "文章での質問と言い換えた出し直しは transcript の再計測で確かめる。";
  if (rate >= WITHDRAWAL_RATE_THRESHOLD) {
    return `${head}${share}${remeasure}`;
  }
  return `${head}${share}10% を下回っており、差し戻しの大半が空振りしている可能性がある。${remeasure}外す手順: 1. 点検表の (4) を固定文から外す。2. それでも足りなければ settings の ask-preflight のエントリを消して chezmoi apply する。3. 動いている session を起動し直す（それまでは差し戻しが続く）。外した後、AskUserQuestion が差し戻されないことを 1 回確かめる。`;
}
