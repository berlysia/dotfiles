import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultStateDir(cwd = process.cwd()): string {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git")))
      return join(dir, ".tmp", "japanese-check");
    if (dirname(dir) === dir) return join(start, ".tmp", "japanese-check");
  }
}

export function checkerVersion(): string {
  const root = dirname(fileURLToPath(import.meta.url));
  return digest(
    ["analyze.ts", "markdown.ts", "tokenizer.ts", "receipts.ts", "cli.ts"]
      .map((name) => readFileSync(join(root, name), "utf8"))
      .join("\n"),
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
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

function fail(error: unknown): never {
  console.error("[japanese-check receipts]", error);
  throw error;
}

function prepareState(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(stateDir, ".gitignore"), "*\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!object(error) || error.code !== "EEXIST") fail(error);
  }
}

function atomicJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
}

function receiptPath(stateDir: string, file: string): string {
  return join(stateDir, "receipts", `${digest(realpathSync(file))}.json`);
}

function loadReceipt(stateDir: string, file: string): Receipt | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(receiptPath(stateDir, file), "utf8"));
  } catch (error) {
    if (missing(error)) return null;
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
    throw new Error("日本語検査の記録が不正です。");
  }
  return value as unknown as Receipt;
}

export function verify(
  file: string,
  stateDir = defaultStateDir(),
): Verification {
  const hash = digest(readFileSync(file));
  const receipt = loadReceipt(stateDir, file);
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

function sessionDir(session: string, stateDir: string): string {
  // Session IDs are hashed, never interpreted as paths.
  return join(stateDir, "sessions", digest(session));
}

export function track(
  file: string,
  session: string,
  stateDir = defaultStateDir(),
): void {
  prepareState(stateDir);
  const path = realpathSync(file);
  atomicJson(
    join(sessionDir(session, stateDir), "documents", `${digest(path)}.json`),
    { path },
  );
}

export function tracked(
  session: string,
  stateDir = defaultStateDir(),
): string[] {
  const dir = join(sessionDir(session, stateDir), "documents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (missing(error)) return [];
    fail(error);
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!object(value) || typeof value.path !== "string")
        throw new Error("文書の追跡記録が不正です。");
      return value.path;
    })
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch (error) {
        if (missing(error)) return false;
        fail(error);
      }
    });
}

export function baseline(
  session: string,
  files: string[],
  stateDir = defaultStateDir(),
): Record<string, string> {
  prepareState(stateDir);
  const path = join(sessionDir(session, stateDir), "baseline.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (!missing(error)) fail(error);
    const hashes = Object.fromEntries(
      files.map((file) => [file, digest(readFileSync(file))]),
    );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, JSON.stringify(hashes), { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (!object(writeError) || writeError.code !== "EEXIST") fail(writeError);
      return baseline(session, files, stateDir);
    }
    return hashes;
  }
  if (
    !object(value) ||
    !Object.values(value).every((hash) => typeof hash === "string")
  )
    throw new Error("文書の開始状態が不正です。");
  return value as Record<string, string>;
}
