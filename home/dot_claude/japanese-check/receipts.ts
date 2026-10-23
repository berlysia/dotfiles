import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicJson,
  defaultStateDir,
  digest,
  fail,
  missing,
  object,
  prepareState,
  RECEIPTS_DIR,
} from "./state.ts";

export const CHECKER_VERSION_FILES = [
  "analyze.ts",
  "markdown.ts",
  "tokenizer.ts",
  "state.ts",
  "receipts.ts",
  "cli.ts",
];

export function checkerVersion(): string {
  const root = dirname(fileURLToPath(import.meta.url));
  return digest(
    CHECKER_VERSION_FILES.map((name) =>
      readFileSync(join(root, name), "utf8"),
    ).join("\n"),
  );
}

export interface Receipt {
  schema: 1;
  documentHash: string;
  bodyHash: string;
  comparisonHash: string | null;
  checkerHash: string;
  candidates: number;
  review: string | null;
  disposition: "checked" | "draft" | "excluded";
}

export type Verification = {
  status: "ready" | "missing" | "stale" | "needs-review" | "draft" | "excluded";
  hash: string;
  receipt: Receipt | null;
  // Set when the receipt file exists but cannot be parsed; a new check
  // overwrites it.
  corrupt?: true;
};

function receiptPath(stateDir: string, file: string): string {
  return join(stateDir, RECEIPTS_DIR, `${digest(realpathSync(file))}.json`);
}

function loadReceipt(
  stateDir: string,
  file: string,
): Receipt | null | "corrupt" {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(receiptPath(stateDir, file), "utf8"));
  } catch (error) {
    if (missing(error)) return null;
    // Unreadable content is recoverable by a new check; I/O errors are not.
    if (error instanceof SyntaxError) return "corrupt";
    fail(error);
  }
  if (
    !object(value) ||
    value.schema !== 1 ||
    typeof value.documentHash !== "string" ||
    typeof value.bodyHash !== "string" ||
    typeof value.checkerHash !== "string" ||
    (value.comparisonHash !== null &&
      typeof value.comparisonHash !== "string") ||
    !Number.isSafeInteger(value.candidates) ||
    Number(value.candidates) < 0 ||
    (value.review !== null && typeof value.review !== "string") ||
    !["checked", "draft", "excluded"].includes(String(value.disposition))
  ) {
    return "corrupt";
  }
  return value as unknown as Receipt;
}

export function verify(
  file: string,
  stateDir = defaultStateDir(),
): Verification {
  const hash = digest(readFileSync(file));
  const receipt = loadReceipt(stateDir, file);
  if (receipt === "corrupt")
    return { status: "stale", hash, receipt: null, corrupt: true };
  if (!receipt) return { status: "missing", hash, receipt };
  if (
    receipt.documentHash !== hash ||
    receipt.checkerHash !== checkerVersion()
  ) {
    return { status: "stale", hash, receipt };
  }
  const status =
    receipt.disposition === "draft"
      ? "draft"
      : receipt.disposition === "excluded"
        ? "excluded"
        : receipt.candidates > 0 && !receipt.review
          ? "needs-review"
          : "ready";
  return { status, hash, receipt };
}

export function recordCheck(
  file: string,
  expectedHash: string,
  body: string,
  candidates: number,
  stateDir = defaultStateDir(),
  comparisonHash: string | null = null,
): Verification {
  prepareState(stateDir);
  if (digest(readFileSync(file)) !== expectedHash)
    throw new Error("検査中に文書が変更されました。再検査してください。");
  const previous = verify(file, stateDir);
  const receipt: Receipt = {
    schema: 1,
    documentHash: expectedHash,
    bodyHash: digest(body),
    comparisonHash,
    checkerHash: checkerVersion(),
    candidates,
    disposition: "checked",
    review:
      previous.status === "ready" &&
      previous.receipt?.bodyHash === digest(body) &&
      previous.receipt.comparisonHash === comparisonHash
        ? previous.receipt.review
        : null,
  };
  atomicJson(receiptPath(stateDir, file), receipt);
  return verify(file, stateDir);
}

export function recordDecision(
  file: string,
  expectedHash: string,
  reason: string,
  disposition: "checked" | "draft" | "excluded",
  stateDir = defaultStateDir(),
): Verification {
  prepareState(stateDir);
  if (!reason.trim()) throw new Error("判断の理由を指定してください。");
  const current = verify(file, stateDir);
  if (current.hash !== expectedHash)
    throw new Error("判断対象の本文が変更されています。");
  if (
    disposition === "checked" &&
    (current.status === "missing" ||
      current.status === "stale" ||
      current.receipt?.disposition !== "checked")
  )
    throw new Error("先に現在の本文へ check を実行してください。");
  const receipt: Receipt = {
    schema: 1,
    documentHash: current.hash,
    bodyHash: current.receipt?.bodyHash ?? current.hash,
    checkerHash: checkerVersion(),
    comparisonHash: current.receipt?.comparisonHash ?? null,
    candidates: current.receipt?.candidates ?? 0,
    review: reason.trim(),
    disposition,
  };
  atomicJson(receiptPath(stateDir, file), receipt);
  return verify(file, stateDir);
}
