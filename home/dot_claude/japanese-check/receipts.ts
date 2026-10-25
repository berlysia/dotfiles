import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPENDENCIES, findDependency } from "./deps.ts";
import type { DependencyEntry } from "./deps.ts";
import { HASHED_PROFILE_FIELDS } from "./profiles.ts";
import { readFileBounded } from "./safe-read.ts";
import type { SafeReadResult } from "./safe-read.ts";
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
import { HASHED_WORD_FIELDS } from "./words.ts";
import { createHash } from "node:crypto";

// japanese-check の dir の、test 以外の全部の `.ts` と、結果に効くデータ。
// 足し忘れは、dir の実際の一覧と突き合わせる test が落とす。配布先に一覧に無い
// 古い `.ts` が残っても、ハッシュには入らない。
export const CHECKER_VERSION_FILES = [
  "analyze.ts",
  "cli.ts",
  "deps.ts",
  "keep.ts",
  "markdown.ts",
  "profiles.ts",
  "receipts.ts",
  "safe-read.ts",
  "secrets.ts",
  "state.ts",
  "tokenizer.ts",
  "tracking.ts",
  "types.ts",
  "words.ts",
  "data/words.json",
  "data/profiles.json",
];

const MAX_PART_BYTES = 1024 * 1024;

export interface CheckerVersionOptions {
  dir?: string | undefined;
  deps?: readonly DependencyEntry[] | undefined;
  read?: ((path: string, maxBytes: number) => SafeReadResult) | undefined;
}
export interface CheckerVersion {
  hash: string;
  // 読めなかった部品と見つからなかった依存の名前。ハッシュの計算は止めない
  missing: string[];
}

function selfDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(
  item: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(item)) return null;
  const picked: Record<string, unknown> = {};
  for (const name of fields)
    if (Object.hasOwn(item, name)) picked[name] = item[name];
  return picked;
}

// 結果に効く欄だけの JSON にする。正規化できないときは null（生のバイト列を使う）
function normalizeData(name: string, bytes: Buffer): string | null {
  const config =
    name === "data/words.json"
      ? { list: "entries", fields: HASHED_WORD_FIELDS as readonly string[] }
      : name === "data/profiles.json"
        ? { list: "rows", fields: HASHED_PROFILE_FIELDS as readonly string[] }
        : null;
  if (!config) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value[config.list])) return null;
  const items: Array<Record<string, unknown>> = [];
  for (const item of value[config.list] as unknown[]) {
    const picked = pick(item, config.fields);
    if (!picked) return null;
    items.push(picked);
  }
  return JSON.stringify({ schema: value.schema, [config.list]: items });
}

const versionCache = new Map<string, CheckerVersion>();

export function clearCheckerVersionCache(): void {
  versionCache.clear();
}

export function checkerVersion(
  options: CheckerVersionOptions = {},
): CheckerVersion {
  const dir = options.dir ?? selfDir();
  const deps = options.deps ?? DEPENDENCIES;
  const read = options.read ?? readFileBounded;
  const cacheKey = `${dir}\0${JSON.stringify(deps)}`;
  if (!options.read) {
    const cached = versionCache.get(cacheKey);
    if (cached) return cached;
  }
  const hash = createHash("sha256");
  const missingNames: string[] = [];
  const absent = (name: string) => {
    missingNames.push(name);
    hash.update(`\0missing\0${name.length}:${name}\0`);
  };
  const names = [...CHECKER_VERSION_FILES].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const name of names) {
    const result = read(join(dir, name), MAX_PART_BYTES);
    if (!result.ok) {
      absent(name);
      continue;
    }
    const normalized = normalizeData(name, result.bytes);
    const content =
      normalized === null ? result.bytes : Buffer.from(normalized, "utf8");
    hash.update(`${name}\0${content.length}\0`);
    hash.update(content);
    hash.update("\n");
  }
  for (const dep of [...deps].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const found = findDependency(dep.name, dir);
    if (found.ok) hash.update(`${dep.name}\0${found.version}\n`);
    else absent(dep.name);
  }
  const result: CheckerVersion = {
    hash: hash.digest("hex"),
    missing: missingNames,
  };
  if (!options.read) versionCache.set(cacheKey, result);
  return result;
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
  // Set only by a check run with --profile. They are all absent or none is:
  // profileHash needs profileId, and a reader needs a profile.
  profileId?: string;
  reader?: "adhd";
  profileHash?: string;
}

export type Verification = {
  status: "ready" | "missing" | "stale" | "needs-review" | "draft" | "excluded";
  hash: string;
  receipt: Receipt | null;
  // Set when the receipt file exists but cannot be parsed; a new check
  // overwrites it.
  corrupt?: true;
  // Set whenever a checker part or dependency could not be read at verify time,
  // whatever the status. It is not stored in the receipt: the checker hash of a
  // receipt written while parts were missing differs once they are back.
  checkerIncomplete?: true;
  checkerMissing?: string[];
};

export interface ReceiptOptions {
  dir?: string | undefined;
  deps?: readonly DependencyEntry[] | undefined;
}

export interface RecordedProfile {
  id: string;
  reader?: "adhd";
  hash: string;
}

export interface RecordCheckOptions extends ReceiptOptions {
  file: string;
  expectedHash: string;
  body: string;
  candidates: number;
  stateDir?: string;
  comparisonHash?: string | null;
  profile?: RecordedProfile | undefined;
}

const PROFILE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const PROFILE_HASH = /^[0-9a-f]{64}$/u;

function receiptPath(stateDir: string, file: string): string {
  return join(stateDir, RECEIPTS_DIR, `${digest(realpathSync(file))}.json`);
}

// A missing field and null mean the same thing; the returned receipt has neither.
function profileFields(
  value: Record<string, unknown>,
): Pick<Receipt, "profileId" | "reader" | "profileHash"> | null {
  const id = value.profileId ?? undefined;
  const reader = value.reader ?? undefined;
  const hash = value.profileHash ?? undefined;
  if (id !== undefined && (typeof id !== "string" || !PROFILE_ID.test(id)))
    return null;
  if (reader !== undefined && reader !== "adhd") return null;
  if (
    hash !== undefined &&
    (typeof hash !== "string" || !PROFILE_HASH.test(hash))
  )
    return null;
  if ((id === undefined) !== (hash === undefined)) return null;
  if (id === undefined && reader !== undefined) return null;
  const fields: Pick<Receipt, "profileId" | "reader" | "profileHash"> = {};
  if (id !== undefined) fields.profileId = id as string;
  if (reader !== undefined) fields.reader = "adhd";
  if (hash !== undefined) fields.profileHash = hash as string;
  return fields;
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
  const profile = profileFields(value);
  if (!profile) return "corrupt";
  const {
    profileId: _id,
    reader: _reader,
    profileHash: _hash,
    ...base
  } = value;
  return { ...base, ...profile } as unknown as Receipt;
}

export function verify(
  file: string,
  stateDir = defaultStateDir(),
  options: ReceiptOptions = {},
): Verification {
  const hash = digest(readFileSync(file));
  const version = checkerVersion(options);
  const incomplete: Pick<Verification, "checkerIncomplete" | "checkerMissing"> =
    version.missing.length > 0
      ? { checkerIncomplete: true, checkerMissing: version.missing }
      : {};
  const receipt = loadReceipt(stateDir, file);
  if (receipt === "corrupt")
    return {
      status: "stale",
      hash,
      receipt: null,
      corrupt: true,
      ...incomplete,
    };
  if (!receipt) return { status: "missing", hash, receipt, ...incomplete };
  if (receipt.documentHash !== hash || receipt.checkerHash !== version.hash) {
    return { status: "stale", hash, receipt, ...incomplete };
  }
  const status =
    receipt.disposition === "draft"
      ? "draft"
      : receipt.disposition === "excluded"
        ? "excluded"
        : receipt.candidates > 0 && !receipt.review
          ? "needs-review"
          : "ready";
  return { status, hash, receipt, ...incomplete };
}

export function recordCheck(options: RecordCheckOptions): Verification {
  const {
    file,
    expectedHash,
    body,
    candidates,
    profile,
    stateDir = defaultStateDir(),
    comparisonHash = null,
  } = options;
  const own: ReceiptOptions = { dir: options.dir, deps: options.deps };
  prepareState(stateDir);
  if (digest(readFileSync(file)) !== expectedHash)
    throw new Error("検査中に文書が変更されました。再検査してください。");
  const previous = verify(file, stateDir, own);
  const before = previous.receipt;
  // A review carries over only when nothing that shaped the check changed: the
  // text, the original, the checker (ready includes its hash), the profile and
  // reader, and how many candidates it found. A checker with missing parts never
  // proved the full rule set, so it does not carry a review either.
  const carries =
    previous.status === "ready" &&
    !previous.checkerIncomplete &&
    before?.bodyHash === digest(body) &&
    before.comparisonHash === comparisonHash &&
    before.profileId === profile?.id &&
    before.reader === profile?.reader &&
    before.profileHash === profile?.hash &&
    before.candidates === candidates;
  const receipt: Receipt = {
    schema: 1,
    documentHash: expectedHash,
    bodyHash: digest(body),
    comparisonHash,
    checkerHash: checkerVersion(own).hash,
    candidates,
    disposition: "checked",
    review: carries ? (before?.review ?? null) : null,
  };
  if (profile) {
    receipt.profileId = profile.id;
    if (profile.reader) receipt.reader = profile.reader;
    receipt.profileHash = profile.hash;
  }
  atomicJson(receiptPath(stateDir, file), receipt);
  return verify(file, stateDir, own);
}

export function recordDecision(
  file: string,
  expectedHash: string,
  reason: string,
  disposition: "checked" | "draft" | "excluded",
  stateDir = defaultStateDir(),
  options: ReceiptOptions = {},
): Verification {
  prepareState(stateDir);
  if (!reason.trim()) throw new Error("判断の理由を指定してください。");
  const current = verify(file, stateDir, options);
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
    checkerHash: checkerVersion(options).hash,
    comparisonHash: current.receipt?.comparisonHash ?? null,
    candidates: current.receipt?.candidates ?? 0,
    review: reason.trim(),
    disposition,
  };
  // Only a review keeps the profile the check ran under; a deferral or an
  // exclusion says nothing about which rules were applied.
  const before = current.receipt;
  if (disposition === "checked" && before?.profileId !== undefined) {
    receipt.profileId = before.profileId;
    if (before.reader) receipt.reader = before.reader;
    if (before.profileHash) receipt.profileHash = before.profileHash;
  }
  atomicJson(receiptPath(stateDir, file), receipt);
  return verify(file, stateDir, options);
}
