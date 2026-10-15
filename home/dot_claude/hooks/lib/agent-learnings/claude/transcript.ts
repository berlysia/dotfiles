import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { sep } from "node:path";
import { preprocessText } from "../core/entry-text.ts";

// worker と将来の Codex アダプタの境界
export type ReducedTranscript = {
  text: string; // 縮約と redaction 済み、末尾 60,000 字以内
  userTurns: number; // 範囲内の利用者の発言の数
  endOffset: number; // 読み終えたバイト位置（最後の改行の直後）
  firstLineHash: string; // ファイル 1 行目（改行を除く）の sha256。空ファイルは空文字列の sha256
  restarted: boolean; // fromOffset が使えず 0 から読んだ
};
// 断った理由は固定の文言だけにする。fs のエラー文にはパスが入りうるので、runs.log まで流さない
export type TranscriptRejection =
  | "not a regular file"
  | "not a .jsonl file"
  | "outside projects"
  | "unreadable"
  | "replaced";
export type TranscriptResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: TranscriptRejection };

// 1 回に読む範囲の上限。ファイル全体の大きさでは断らず、超えたら末尾のこの範囲だけを読む
export const TRANSCRIPT_READ_MAX_BYTES = 20 * 1024 * 1024;
// 1 行目のハッシュを取るために読む上限
const FIRST_LINE_MAX_BYTES = 1024 * 1024;
export const TRANSCRIPT_MAX_CHARS = 60_000;
const USER_MAX = 2_000;
const ASSISTANT_MAX = 1_000;
const ERROR_MAX = 200;

const fail = (
  reason: TranscriptRejection,
): { ok: false; reason: TranscriptRejection } => ({
  ok: false,
  reason,
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const truncateChars = (text: string, max: number): string => {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
};

type Opened = { fd: number; size: number };

// 差し替えに強い順序: lstat → realpath の配下確認 → O_NOFOLLOW で open → fd と realpath の dev/ino 照合
function openTranscript(
  transcriptPath: string,
  projectsDir: string,
): TranscriptResult<Opened> {
  let real: string;
  try {
    const lst = lstatSync(transcriptPath);
    if (!lst.isFile() || lst.isSymbolicLink())
      return fail("not a regular file");
    if (!transcriptPath.endsWith(".jsonl")) return fail("not a .jsonl file");
    real = realpathSync(transcriptPath);
    const root = realpathSync(projectsDir);
    if (!real.startsWith(root + sep)) return fail("outside projects");
  } catch {
    return fail("unreadable");
  }
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("unreadable");
  }
  try {
    const opened = fstatSync(fd);
    const now = statSync(real);
    if (!opened.isFile() || opened.dev !== now.dev || opened.ino !== now.ino) {
      closeSync(fd);
      return fail("replaced");
    }
    return { ok: true, value: { fd, size: opened.size } };
  } catch {
    closeSync(fd);
    return fail("unreadable");
  }
}

// 読まずに許可だけ確かめる。サイズは fd の fstat の値
export function checkTranscript(
  transcriptPath: string,
  projectsDir: string,
): TranscriptResult<{ size: number }> {
  const opened = openTranscript(transcriptPath, projectsDir);
  if (!opened.ok) return opened;
  closeSync(opened.value.fd);
  return { ok: true, value: { size: opened.value.size } };
}

// fd の position から length バイトを読む。短く読めたとき（読んでいる間に truncate された）は読めた分だけ返す
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

// compaction-testament と同じ判定。利用者が打った発言だけを返す
function typedUtterance(entry: Record<string, unknown>): string | null {
  if (entry["isCompactSummary"] === true || entry["isMeta"] === true)
    return null;
  const message = entry["message"];
  if (!isRecord(message)) return null;
  const content = message["content"];
  let utterance: string | null = null;
  if (typeof content === "string") {
    utterance = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        !isRecord(block) ||
        block["type"] !== "text" ||
        typeof block["text"] !== "string"
      )
        return null;
      parts.push(block["text"]);
    }
    utterance = parts.join("\n");
  }
  if (utterance === null) return null;
  const trimmed = utterance.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("<") ||
    trimmed.startsWith("Caveat:") ||
    trimmed.startsWith("[compaction-testament]")
  )
    return null;
  return trimmed;
}

function errorResults(entry: Record<string, unknown>): string[] {
  const message = entry["message"];
  if (!isRecord(message) || !Array.isArray(message["content"])) return [];
  const found: string[] = [];
  for (const block of message["content"]) {
    if (
      !isRecord(block) ||
      block["type"] !== "tool_result" ||
      block["is_error"] !== true
    )
      continue;
    const content = block["content"];
    if (typeof content === "string") found.push(content);
    else if (Array.isArray(content))
      found.push(
        content
          .map((part) =>
            isRecord(part) && typeof part["text"] === "string"
              ? part["text"]
              : "",
          )
          .join(" "),
      );
  }
  return found;
}

function assistantTexts(entry: Record<string, unknown>): string[] {
  const message = entry["message"];
  if (!isRecord(message)) return [];
  const content = message["content"];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isRecord(block) &&
    block["type"] === "text" &&
    typeof block["text"] === "string"
      ? [block["text"]]
      : [],
  );
}

// 読むのは 1 行目（1MB まで）、fromOffset の直前 1 バイト、窓（readMaxBytes + 1 バイトまで）だけ
function readRegion(
  fd: number,
  size: number,
  fromOffset: number,
  readMaxBytes: number,
): {
  region: string;
  endOffset: number;
  firstLineHash: string;
  restarted: boolean;
} {
  const head = readAt(fd, 0, Math.min(size, FIRST_LINE_MAX_BYTES));
  const headNewline = head.indexOf(0x0a);
  const firstLineHash = createHash("sha256")
    .update(headNewline < 0 ? head : head.subarray(0, headNewline))
    .digest("hex");

  const offsetUsable =
    Number.isInteger(fromOffset) &&
    fromOffset >= 0 &&
    fromOffset <= size &&
    (fromOffset === 0 || readAt(fd, fromOffset - 1, 1)[0] === 0x0a);
  const start = offsetUsable ? fromOffset : 0;
  const restarted = !offsetUsable;

  // 窓が start より後ろなら、直前が改行かを見るために 1 バイト前から読む
  const windowStart = Math.max(start, size - readMaxBytes);
  const trimmed = windowStart > start;
  const raw = trimmed
    ? readAt(fd, windowStart - 1, size - windowStart + 1)
    : readAt(fd, start, size - start);
  const body = trimmed ? raw.subarray(1) : raw;
  const bodyBase = trimmed ? windowStart : start;

  // 窓の本体の最後の改行の直後まで。無ければ（書きかけの巨大な行など）位置を進めない
  const lastNewline = body.lastIndexOf(0x0a);
  if (lastNewline < 0)
    return { region: "", endOffset: start, firstLineHash, restarted };
  const endOffset = bodyBase + lastNewline + 1;

  let regionStart = bodyBase;
  if (trimmed && raw[0] !== 0x0a) {
    // 窓が行の途中から始まる。その行は捨てて、次の行から読む
    regionStart = bodyBase + body.indexOf(0x0a) + 1;
  }
  const region =
    regionStart >= endOffset
      ? ""
      : body
          .subarray(regionStart - bodyBase, endOffset - bodyBase)
          .toString("utf8");
  return { region, endOffset, firstLineHash, restarted };
}

export function reduceTranscript(opts: {
  transcriptPath: string;
  projectsDir: string;
  fromOffset: number;
  extraRedact: readonly RegExp[];
  readMaxBytes?: number; // 既定は TRANSCRIPT_READ_MAX_BYTES。テストが境界を小さく作るために使う
}): TranscriptResult<ReducedTranscript> {
  const opened = openTranscript(opts.transcriptPath, opts.projectsDir);
  if (!opened.ok) return opened;
  let read: ReturnType<typeof readRegion>;
  try {
    read = readRegion(
      opened.value.fd,
      opened.value.size,
      opts.fromOffset,
      opts.readMaxBytes ?? TRANSCRIPT_READ_MAX_BYTES,
    );
  } finally {
    closeSync(opened.value.fd);
  }
  const { region, endOffset, firstLineHash, restarted } = read;

  const fragments: string[] = [];
  let userTurns = 0;
  const push = (label: string, raw: string, max: number): boolean => {
    const cleaned = truncateChars(preprocessText(raw, opts.extraRedact), max);
    if (cleaned === "") return false;
    fragments.push(`[${label}] ${cleaned}`);
    return true;
  };
  for (const line of region.split("\n")) {
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["isSidechain"] === true) continue;
    if (entry["type"] === "user") {
      const utterance = typedUtterance(entry);
      if (utterance !== null) {
        if (push("user", utterance, USER_MAX)) userTurns += 1;
      } else {
        for (const error of errorResults(entry))
          push("error", error, ERROR_MAX);
      }
    } else if (entry["type"] === "assistant") {
      for (const text of assistantTexts(entry))
        push("assistant", text, ASSISTANT_MAX);
    }
  }

  let text = fragments.join("\n");
  if (text.length > TRANSCRIPT_MAX_CHARS) {
    // 先頭から削る。途中で切れた断片は残さず、次の断片の先頭から始める
    text = text.slice(-TRANSCRIPT_MAX_CHARS);
    const boundary = text.indexOf("\n");
    text = boundary < 0 ? "" : text.slice(boundary + 1);
  }
  return {
    ok: true,
    value: {
      text,
      userTurns,
      endOffset,
      firstLineHash,
      restarted,
    },
  };
}
