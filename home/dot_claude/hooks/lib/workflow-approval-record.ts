/**
 * The steps that turn a verified approval into a recorded one: append to the
 * ledger, rewrite the Approval line, then read the gate back. Shared by the
 * recorders so every route ends in the same state and the gate, which reads
 * only approvals.log, never learns which route was used.
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
import {
  type ApprovalDelegate,
  type ApprovalQuestion,
  type ApprovalVia,
  APPROVAL_QUESTION_TEXT,
  DECLINE_LABEL,
  DELEGATION_QUESTION_TEXT,
  WORKFLOW_DOC_NAME,
  MAX_DOCS_PER_QUESTION,
  appendApproval,
  buildApprovalQuestions,
  deepEqualIgnoringKeyOrder,
  describeAnswerShape,
  isAnswerValue,
  isApprovalLikeQuestion,
  matchApprovalAnswer,
  matchDelegationAnswer,
} from "./workflow-approval.ts";
import {
  evaluateApprovalReadiness,
  evaluateDocument,
  listApprovalCandidates,
  resolveDelegationOffer,
} from "./workflow-gate.ts";
import { setApprovalStatusLine } from "./workflow-marker.ts";

/**
 * Rewrite the Approval line so a crash never leaves a truncated document:
 * write a uniquely named temp file opened with O_EXCL (it cannot follow a
 * planted symlink or reuse an existing name), keep the document's mode,
 * then rename over the document. A symlinked document is left alone: the
 * hook must not write outside the workflow dir. Returns whether the line
 * was rewritten (false when it already said approved or is missing).
 */
export function setApprovalLineApproved(path: string): boolean {
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

export type RecordState = "recorded" | "loggedOnly" | "failed";

export interface RecordResult {
  doc: string;
  state: RecordState;
  hash: string;
  /** Machine-readable note on how the state came about. */
  detail?: string;
  /** Present when this record also delegates the spec's plan-N.md. */
  delegated?: true;
}

/**
 * Record one document and say what state it ended in. Never throws: each
 * document is its own step, so a failure on one still reports the others.
 * `loggedOnly` means the ledger line was written but the Approval line is
 * not approved yet, so the gate still waits.
 */
export function recordOne(
  wfDir: string,
  doc: string,
  hash: string,
  session: string,
  at: string,
  via: ApprovalVia,
  delegate?: ApprovalDelegate,
): RecordResult {
  const path = resolve(wfDir, doc);
  let logged = false;
  try {
    appendApproval(wfDir, {
      doc,
      hash,
      session,
      at,
      via,
      ...(delegate === undefined ? {} : { delegate }),
    });
    logged = true;
    if (!lstatSync(path).isFile()) {
      return { doc, state: "loggedOnly", hash, detail: "not-regular-file" };
    }
    const rewritten = setApprovalLineApproved(path);
    const c = evaluateDocument(path).conditions;
    if (c.approvalRecord.ok && c.approvalStatus.ok) {
      return {
        doc,
        state: "recorded",
        hash,
        detail: rewritten ? "rewritten" : "already-approved",
        ...(delegate === undefined ? {} : { delegated: true as const }),
      };
    }
    return {
      doc,
      state: c.approvalRecord.ok ? "loggedOnly" : "failed",
      hash,
      detail: `conditions:log=${c.approvalRecord.ok ? "ok" : "no"},line=${c.approvalStatus.ok ? "ok" : "no"}`,
    };
  } catch (error) {
    return {
      doc,
      state: logged ? "loggedOnly" : "failed",
      hash,
      detail: `error:${String(error).slice(0, 120)}`,
    };
  }
}

/**
 * The state of one document as a fact, the same for every route. A hook adds
 * its own route-specific way to retry.
 */
export function describeRecordResult(result: RecordResult): string {
  const { doc, hash } = result;
  switch (result.state) {
    case "recorded":
      return `${doc} を hash=${hash.slice(0, 12)} で承認として記録した${
        result.delegated ? "（Scope に収まる plan-N.md を委任）" : ""
      }`;
    case "loggedOnly":
      return `${doc} は log には記録したが承認行の書き換えに失敗した。\`workflow-cli status\` で確認する`;
    case "failed":
      return `${doc} は記録できなかった（何も書いていない）。\`workflow-cli status\` で確認する`;
  }
}

export type AnswerVerification =
  | { kind: "notApproval" }
  | { kind: "afk" }
  | { kind: "freeText"; text: string }
  | { kind: "malformed" }
  | { kind: "answerShape"; shape: string; docs: string[] }
  | { kind: "notCandidate"; docs: string[] }
  | { kind: "decline" }
  | { kind: "notes"; notes: string }
  | { kind: "recorded"; results: RecordResult[] };

const RESPONSE_KEYS = new Set(["questions", "answers", "annotations"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The document names the model put in the question, or null when the
 * options are not the shape the CLI generates. The names are model-chosen,
 * so they are checked here before anything resolves them against the
 * workflow dir or hands them to the gate.
 */
function extractDocNames(question: Record<string, unknown>): string[] | null {
  const { options } = question;
  if (!Array.isArray(options)) return null;
  const labels: string[] = [];
  for (const option of options) {
    if (!isPlainObject(option) || typeof option.label !== "string") return null;
    labels.push(option.label);
  }
  if (labels.filter((l) => l === DECLINE_LABEL).length !== 1) return null;
  const docs = labels.filter((l) => l !== DECLINE_LABEL);
  if (docs.length < 1 || docs.length > MAX_DOCS_PER_QUESTION) return null;
  if (new Set(docs).size !== docs.length) return null;
  if (!docs.every((d) => WORKFLOW_DOC_NAME.test(d))) return null;
  return docs;
}

/**
 * Decide whether an AskUserQuestion tool_response is a user's answer to the
 * question `workflow-cli ask-approval` generates, and record the approval if
 * so. Only `toolResponse` is read. The question is rebuilt from the current
 * state of the documents and must equal the one in the response, so what
 * the user saw was exactly what the mechanism generated, at the hashes that
 * are recorded. Anything that does not fit is reported, never recorded.
 * The answer may be a string or an array of strings; any other value is
 * reported as its own outcome, because asking again cannot change the shape
 * the client sends.
 */
export function verifyAndRecordApprovalAnswer(
  wfDir: string,
  toolResponse: unknown,
  session: string,
  now: Date = new Date(),
  projectRoot?: string,
): AnswerVerification {
  const r = isPlainObject(toolResponse) ? toolResponse : undefined;
  if (!isApprovalLikeQuestion(r?.questions)) return { kind: "notApproval" };
  if (r === undefined) return { kind: "notApproval" };
  if (Object.hasOwn(r, "afkTimeoutMs")) return { kind: "afk" };
  if (Object.hasOwn(r, "response")) {
    return typeof r.response === "string"
      ? { kind: "freeText", text: r.response }
      : { kind: "malformed" };
  }

  if (!Object.keys(r).every((k) => RESPONSE_KEYS.has(k))) {
    return { kind: "malformed" };
  }
  const { questions, answers, annotations } = r;
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 2
  ) {
    return { kind: "malformed" };
  }
  const question = questions[0];
  if (!isPlainObject(question) || typeof question.question !== "string") {
    return { kind: "malformed" };
  }
  if (!isPlainObject(answers)) return { kind: "malformed" };

  const docNames = extractDocNames(question);
  if (docNames === null) return { kind: "malformed" };

  const candidates = new Set(listApprovalCandidates(wfDir, projectRoot));
  const missing = docNames.filter((d) => !candidates.has(d));
  if (missing.length > 0) return { kind: "notCandidate", docs: missing };

  const hashes = new Map(
    docNames.map((d) => [d, evaluateApprovalReadiness(wfDir, d).hash]),
  );
  // The same call `workflow-cli ask-approval` makes, so the offer expected
  // here is the offer that was shown.
  const offer =
    projectRoot !== undefined && docNames.includes("spec.md")
      ? resolveDelegationOffer(wfDir, projectRoot)
      : null;
  let rebuilt: ApprovalQuestion[];
  try {
    rebuilt = buildApprovalQuestions(
      docNames.map((name) => ({ name, hash: hashes.get(name) ?? "" })),
      offer ?? undefined,
    );
  } catch {
    return { kind: "malformed" };
  }
  if (!deepEqualIgnoringKeyOrder(rebuilt, questions)) {
    return { kind: "malformed" };
  }

  // One answer per question, keyed by the question text.
  const expectedKeys = rebuilt.map((q) => q.question);
  if (
    Object.keys(answers).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(answers, key))
  ) {
    return { kind: "malformed" };
  }
  const answer = answers[APPROVAL_QUESTION_TEXT];

  if (isPlainObject(annotations)) {
    for (const entry of Object.values(annotations)) {
      if (isPlainObject(entry) && typeof entry.notes === "string") {
        return { kind: "notes", notes: entry.notes };
      }
    }
  }

  // Checked only now, after the question matched what the CLI generates, so
  // the report can say the question was right and asking again will not help.
  if (!isAnswerValue(answer)) {
    return {
      kind: "answerShape",
      shape: describeAnswerShape(answer),
      docs: docNames,
    };
  }

  const matched = matchApprovalAnswer(rebuilt, answer);
  switch (matched.kind) {
    case "decline":
      return { kind: "decline" };
    case "freeText":
      return { kind: "freeText", text: matched.text };
    case "invalid":
      return { kind: "malformed" };
    case "approve": {
      // The delegation answer counts only once the approval itself stands.
      let delegate = false;
      if (rebuilt.length === 2) {
        const delegationAnswer = answers[DELEGATION_QUESTION_TEXT];
        if (typeof delegationAnswer !== "string") return { kind: "malformed" };
        const delegation = matchDelegationAnswer(delegationAnswer);
        if (delegation === "other") {
          return { kind: "freeText", text: delegationAnswer };
        }
        delegate = delegation === "delegate";
      }
      const at = now.toISOString();
      return {
        kind: "recorded",
        results: matched.docs.map((doc) =>
          recordOne(
            wfDir,
            doc,
            hashes.get(doc) ?? "",
            session,
            at,
            "ask",
            delegate && doc === "spec.md" ? "plans-in-scope" : undefined,
          ),
        ),
      };
    }
  }
}
