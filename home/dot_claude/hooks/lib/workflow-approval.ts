/**
 * The approval ledger (spec K8): which version of a workflow document a
 * human approved. One JSON object per line, appended by approval-recorder
 * when the user says `承認` in the conversation. The gate trusts this file,
 * not the Approval Status line -- the line is display and the way to revoke.
 *
 * JSON Lines so document names and session ids need no delimiter rules of
 * their own. The reader keeps only the last line per document: approve,
 * revise, then revert to the approved text and the old approval does not
 * come back. `session` is audit only and never matched, so a wfDir copied by
 * task-handoff keeps its approvals for unchanged documents.
 *
 * A leaf module (node builtins only): the document hash is computed by the
 * gate, which is the only reader.
 */

import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const APPROVALS_LOG = "approvals.log";

// The keyword alone is case-insensitive; document names are not, so a
// case-insensitive filesystem cannot turn `PLAN.MD` into a ledger key the
// gate never looks up.
const UTTERANCE =
  /^(?:承認|[Aa][Pp][Pp][Rr][Oo][Vv][Ee])((?:[ \t　]+(?:spec\.md|plan\.md|plan-[0-9]+\.md))*)[ \t　]*[。.!！]?$/;

/** The document names in an approval utterance, or null when the prompt is not one. */
export function parseApprovalUtterance(
  prompt: string,
): { docs: string[] } | null {
  const match = UTTERANCE.exec(prompt.trim());
  if (!match) return null;
  const names = (match[1] ?? "")
    .trim()
    .split(/[ \t　]+/)
    .filter(Boolean);
  return { docs: [...new Set(names)] };
}

/**
 * Whether a prompt someone schedules would read as an approval when it
 * fires. Wider than parseApprovalUtterance on purpose: the prompt is also
 * checked after NFKC and with format characters (ZWSP, BOM...) removed, so a
 * front-end that normalizes the fired prompt cannot turn a refused-to-record
 * text into a recorded one. The extra denials (full-width `ＡＰＰＲＯＶＥ`)
 * cost nothing: nobody has a reason to schedule them.
 */
export function isApprovalShapedPrompt(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  if (parseApprovalUtterance(prompt) !== null) return true;
  const normalized = prompt.normalize("NFKC").replace(/\p{Cf}/gu, "");
  return parseApprovalUtterance(normalized) !== null;
}

export interface ApprovalRecord {
  doc: string;
  hash: string;
  session: string;
  at: string;
}

export interface LatestApprovals {
  latest: Map<string, ApprovalRecord>;
  /** Lines that were not a valid version-1 record. */
  ignoredLines: number;
  /** Set when the log exists but cannot be read; the caller must treat every document as unapproved. */
  readError?: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One line, one write on an O_APPEND descriptor, so concurrent appends never
 * interleave mid-line. O_NOFOLLOW: a symlink planted at the ledger's name
 * makes the append fail instead of writing into whatever it points at.
 */
export function appendApproval(wfDir: string, record: ApprovalRecord): void {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_NOFOLLOW;
  const fd = openSync(join(wfDir, APPROVALS_LOG), flags, 0o644);
  try {
    writeSync(fd, `${JSON.stringify({ v: 1, ...record })}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * The last valid record per document. Lines that are not JSON, not version
 * 1, or miss a field are skipped and counted, so a diagnosis can say the
 * ledger had lines it did not understand (a newer writer, a hand edit)
 * instead of silently treating them as absent. A log that cannot be read
 * (a directory, EACCES, ELOOP) is reported, not thrown: an exception would
 * reach the guard's catch, which allows the call.
 */
export function readLatestApprovals(wfDir: string): LatestApprovals {
  const latest = new Map<string, ApprovalRecord>();
  let text: string;
  try {
    text = readFileSync(join(wfDir, APPROVALS_LOG), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { latest, ignoredLines: 0 };
    }
    return { latest, ignoredLines: 0, readError: code ?? String(error) };
  }
  let ignoredLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record === null) {
      ignoredLines++;
      continue;
    }
    latest.set(record.doc, record);
  }
  return { latest, ignoredLines };
}

function parseRecord(line: string): ApprovalRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, doc, hash, session, at } = value as Record<string, unknown>;
  if (v !== 1) return null;
  if (
    typeof doc !== "string" ||
    typeof session !== "string" ||
    typeof at !== "string"
  )
    return null;
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) return null;
  return { doc, hash, session, at };
}

// --- AskUserQuestion approval question (spec K3 / K4 / K7) ---------------
//
// The question text is generated by `workflow-cli ask-approval` and compared
// whole by the recorder, so what the user sees is only ever what the
// mechanism produced. Everything here is pure.

export const APPROVAL_QUESTION_TEXT =
  "Document Workflow の承認: 承認する文書にチェックを付けてください（議論したいときは Esc）";
export const APPROVAL_QUESTION_PREFIX = "Document Workflow の承認";
export const APPROVAL_HEADER = "承認";
export const DECLINE_LABEL = "承認しない";
export const DECLINE_DESCRIPTION = "今は承認しない（何を直すか伝える）";
export const HASH_PREFIX = "hash=";
export const HASH_PREFIX_LENGTH = 12;
// AskUserQuestion allows 2-4 options; one is the decline option.
export const MAX_DOCS_PER_QUESTION = 3;
export const WORKFLOW_DOC_NAME = /^(spec|plan|plan-[1-9][0-9]*)\.md$/;

export interface ApprovalDoc {
  name: string;
  hash: string;
}
export interface ApprovalOption {
  label: string;
  description: string;
}
export interface ApprovalQuestion {
  question: string;
  header: string;
  multiSelect: true;
  options: ApprovalOption[];
}

/** Keeps the input order. Throws instead of silently truncating or fixing the list. */
export function buildApprovalQuestions(
  docs: readonly ApprovalDoc[],
): ApprovalQuestion[] {
  if (docs.length < 1 || docs.length > MAX_DOCS_PER_QUESTION) {
    throw new Error(
      `approval question needs 1-${MAX_DOCS_PER_QUESTION} documents, got ${docs.length}`,
    );
  }
  const names = new Set<string>();
  for (const { name } of docs) {
    if (!WORKFLOW_DOC_NAME.test(name)) {
      throw new Error(`not a workflow document name: ${JSON.stringify(name)}`);
    }
    if (names.has(name)) throw new Error(`duplicate document: ${name}`);
    names.add(name);
  }
  return [
    {
      question: APPROVAL_QUESTION_TEXT,
      header: APPROVAL_HEADER,
      multiSelect: true,
      options: [
        ...docs.map(({ name, hash }) => ({
          label: name,
          description: `${HASH_PREFIX}${hash.slice(0, HASH_PREFIX_LENGTH)}`,
        })),
        { label: DECLINE_LABEL, description: DECLINE_DESCRIPTION },
      ],
    },
  ];
}

/**
 * Whether any question looks like a Document Workflow approval, including
 * paraphrases that bypass the CLI. Shared by the guard and the recorder so
 * both draw the same line. Total: any input, including hostile getters,
 * yields a boolean.
 */
export function isApprovalLikeQuestion(questions: unknown): boolean {
  try {
    if (!Array.isArray(questions)) return false;
    return questions.some((q: unknown) => {
      if (typeof q !== "object" || q === null) return false;
      const { question, options } = q as {
        question?: unknown;
        options?: unknown;
      };
      const text = typeof question === "string" ? question : "";
      if (text.startsWith(APPROVAL_QUESTION_PREFIX)) return true;
      if (!Array.isArray(options)) return false;
      const labels = options.map((o: unknown) =>
        typeof o === "object" && o !== null
          ? (o as { label?: unknown }).label
          : undefined,
      );
      if (labels.includes(DECLINE_LABEL)) return true;
      return (
        text.includes("承認") &&
        labels.some((l) => typeof l === "string" && WORKFLOW_DOC_NAME.test(l))
      );
    });
  } catch {
    return false;
  }
}

export type ApprovalAnswer =
  | { kind: "approve"; docs: string[] }
  | { kind: "decline" }
  | { kind: "freeText"; text: string }
  | { kind: "invalid"; reason: "decline-mixed" };

/** multiSelect answers arrive as one string joined with ", ". */
export function matchApprovalAnswer(
  expected: readonly ApprovalQuestion[],
  answerValue: string,
): ApprovalAnswer {
  const labels = new Set(expected[0]?.options.map((o) => o.label) ?? []);
  const parts = answerValue.split(", ");
  if (!parts.every((p) => labels.has(p))) {
    return { kind: "freeText", text: answerValue };
  }
  const unique = [...new Set(parts)];
  const declined = unique.includes(DECLINE_LABEL);
  if (declined) {
    return unique.length === 1
      ? { kind: "decline" }
      : { kind: "invalid", reason: "decline-mixed" };
  }
  return { kind: "approve", docs: unique };
}

/** Structural equality where object key order is irrelevant and array order is not. */
export function deepEqualIgnoringKeyOrder(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const bArr = b as unknown[];
    return (
      a.length === bArr.length &&
      a.every((v, i) => deepEqualIgnoringKeyOrder(v, bArr[i]))
    );
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every(
    (k) =>
      Object.hasOwn(bObj, k) && deepEqualIgnoringKeyOrder(aObj[k], bObj[k]),
  );
}
