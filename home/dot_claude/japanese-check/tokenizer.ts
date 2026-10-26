import { pathToFileURL } from "node:url";

export interface Token {
  surface: string;
  normalized: string;
  pos: string[];
  start: number;
  end: number;
}
export type Tokenizer = (text: string) => Token[];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function comparable(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function comparableInput(text: string) {
  let value = "";
  const offsets: Array<{ start: number; end: number }> = [];
  // A piece that normalization leaves alone keeps per-unit offsets; a changed
  // piece maps every normalized unit to the whole piece.
  const append = (piece: string, index: number, normalized: string) => {
    value += normalized;
    const unchanged = normalized === piece;
    for (let i = 0; i < normalized.length; i++) {
      offsets.push(
        unchanged
          ? { start: index + i, end: index + i + 1 }
          : { start: index, end: index + piece.length },
      );
    }
  };
  // A combining sequence must normalize together, while offsets still refer
  // to the original UTF-16 text. The engine may change case and symbol width.
  // The engine can split a grapheme (an emoji and its variation selector, or
  // "(" and the half-width semi-voiced mark that attaches to it come back as
  // two tokens), and both halves must not map to the same start. So a grapheme
  // is mapped per code point whenever that normalizes to the same text; "ｶﾞ"
  // becomes one "ガ" only together and stays mapped as a whole.
  for (const { segment, index } of new Intl.Segmenter("ja", {
    granularity: "grapheme",
  }).segment(text)) {
    const normalized = comparable(segment);
    const points = [...segment];
    if (points.map(comparable).join("") !== normalized) {
      append(segment, index, normalized);
      continue;
    }
    let offset = index;
    for (const point of points) {
      append(point, offset, comparable(point));
      offset += point.length;
    }
  }
  return { value, offsets };
}

// The messages are fixed text: they never carry a piece of the document, so the
// cli can print them.
export class AnalyzerOutputError extends Error {
  override name = "AnalyzerOutputError";
}

export function decodeTokens(json: string, text: string): Token[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data))
    throw new AnalyzerOutputError("Sudachi の出力が配列ではありません。");
  let cursor = 0;
  let originalEnd = 0;
  const input = comparableInput(text);
  const result = data.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.surface !== "string" ||
      !item.surface ||
      typeof item.normalized_form !== "string" ||
      !Array.isArray(item.poses) ||
      !item.poses.every((part: unknown) => typeof part === "string")
    ) {
      throw new AnalyzerOutputError("Sudachi の形態素データが不正です。");
    }
    const surface = comparable(item.surface);
    const found = input.value.indexOf(surface, cursor);
    const start = input.offsets[found]?.start;
    const end = input.offsets[found + surface.length - 1]?.end;
    if (
      found < 0 ||
      start === undefined ||
      end === undefined ||
      start < originalEnd ||
      input.value.slice(cursor, found).trim()
    ) {
      throw new AnalyzerOutputError(
        "Sudachi の形態素と入力位置を対応できません。",
      );
    }
    cursor = found + surface.length;
    originalEnd = end;
    return {
      surface: text.slice(start, end),
      normalized: item.normalized_form,
      pos: item.poses as string[],
      start,
      end,
    };
  });
  if (input.value.slice(cursor).trim())
    throw new AnalyzerOutputError("Sudachi が入力の末尾を解析していません。");
  return result;
}

// `entry` is the resolved file of the sudachi package found by deps.ts, so the
// file that was checked is the file that gets loaded. Importing by the bare name
// would let Node resolve it from elsewhere (a cwd, a parent directory).
export async function createTokenizer(entry: string): Promise<Tokenizer> {
  // Lazy import keeps structural commands independent of the large dictionary.
  const loaded: unknown = await import(pathToFileURL(entry).href);
  if (
    !record(loaded) ||
    typeof loaded.tokenize !== "function" ||
    !record(loaded.TokenizeMode) ||
    typeof loaded.TokenizeMode.C !== "number"
  )
    throw new Error("Sudachi の読み込み口が想定と違います。");
  const sudachiTokenize = loaded.tokenize as (
    input: string,
    mode: number,
  ) => string;
  const modeC = loaded.TokenizeMode.C;
  const cache = new Map<string, Token[]>();
  return (text) => {
    const cached = cache.get(text);
    if (cached) return cached;
    const tokens = decodeTokens(sudachiTokenize(text, modeC), text);
    cache.set(text, tokens);
    return tokens;
  };
}
