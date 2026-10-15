import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

export type NoPromoteResult =
  | { ok: true; patterns: string[] }
  | { ok: false; reason: string };

const BUILT_IN = "local/*";
const MAX_BYTES = 16 * 1024;
const MAX_LINES = 200;
const MAX_LINE_LENGTH = 200;

// repo-key と同じ正規化（NFKC と小文字化）
const normalize = (text: string): string =>
  text.normalize("NFKC").toLowerCase();

// 正規表現を使わない glob 照合。`*` は `/` を含む任意の文字列（空も含む）、
// ほかの文字はそのまま比べる。行ごとの DP で計算量はパターン長 × キー長
function globMatches(pattern: string, key: string): boolean {
  const tokens = pattern.replace(/\*+/g, "*");
  let row = Array.from({ length: key.length + 1 }, () => false);
  row[0] = true;
  for (const token of tokens) {
    const next = Array.from({ length: key.length + 1 }, () => false);
    if (token === "*") {
      let reachable = false;
      for (let j = 0; j <= key.length; j += 1) {
        reachable = reachable || row[j] === true;
        next[j] = reachable;
      }
    } else {
      for (let j = 1; j <= key.length; j += 1) {
        next[j] = row[j - 1] === true && key[j - 1] === token;
      }
    }
    row = next;
  }
  return row[key.length] === true;
}

export function matchesNoPromote(
  patterns: readonly string[],
  key: string,
): boolean {
  const normalizedKey = normalize(key);
  return patterns.some((pattern) =>
    globMatches(normalize(pattern), normalizedKey),
  );
}

const closed = (reason: string): NoPromoteResult => ({ ok: false, reason });

// 壊れている・読めないときは `ok: false`（すべての昇格を止める）。
// パターンの一部だけを使うと、昇格させたくない repo が昇格する側に倒れるため
export function readNoPromote(store: string): NoPromoteResult {
  let text: string;
  try {
    const fd = openSync(
      join(store, "no-promote"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return closed("no-promote is not a regular file");
      if (stat.size > MAX_BYTES)
        return closed("no-promote is larger than 16KB");
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, patterns: [BUILT_IN] };
    return closed(`cannot read no-promote: ${code ?? "unknown"}`);
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > MAX_LINES) return closed("no-promote has over 200 lines");
  const patterns = new Set<string>([BUILT_IN]);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length > MAX_LINE_LENGTH)
      return closed("no-promote has a line over 200 characters");
    if (line === "" || line.startsWith("#")) continue;
    patterns.add(normalize(line));
  }
  return { ok: true, patterns: [...patterns] };
}
