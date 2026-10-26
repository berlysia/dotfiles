// Two structure checks that read the lines of a document, not its words:
// `stock-boundary` (a document that records work in progress) and
// `table-cell-length` (a table cell longer than 60 characters). Both are
// rebuilt from the behaviour of tanteki's textlint rules, which judged a
// Markdown syntax tree; this file judges the lines of blockLines() instead, so
// the quoted source line and its column are kept and no parser is needed.
//
// Why not a Markdown parser dependency: the findings must carry the column in
// the original line, and a parser would add a dependency to the hook-side code.
// The differences from a syntax tree are listed in ADR-0054.
//
// Every pass below is linear in the length of the line. Nothing recurses and no
// regular expression has a nested quantifier or a back reference.

import type { BlockLine } from "./markdown.ts";
import type { Finding } from "./types.ts";

export interface BlockFlags {
  stockBoundary: boolean;
  tableCells: boolean;
}

const STOCK_RULE = "stock-boundary";
const TABLE_RULE = "table-cell-length";
export const BLOCK_RULES: readonly string[] = [STOCK_RULE, TABLE_RULE];

export const MAX_CELL_LENGTH = 60;

/** The rules that do not run for these flags (all of them without flags). */
export function inactiveBlockRules(flags: BlockFlags | undefined): string[] {
  return BLOCK_RULES.filter((rule) =>
    rule === STOCK_RULE ? !flags?.stockBoundary : !flags?.tableCells,
  );
}

const STOCK_TAIL = "作業追跡はチケットまたは進捗文書へ移してください。";
const stockReason = (label: string) =>
  `文書に${label}が含まれています。${STOCK_TAIL}`;

interface Pattern {
  source: string;
  flags: string;
  label: string;
}
// Fixed words and bounded character runs only. The URL pattern of the original
// rule is not used here: see urlFindings().
const PATTERNS: readonly Pattern[] = [
  {
    source: "進捗(?:状況)?\\s*[:：]\\s*[^\\n]+",
    flags: "g",
    label: "進捗の記述",
  },
  {
    source:
      "(?:状態|ステータス)\\s*[:：]\\s*(?:実装中|進行中|対応中|未着手|保留)",
    flags: "g",
    label: "作業状態の記述",
  },
  {
    source: "(?:\\b(?:PR|Pull Request)|プルリクエスト)\\s*[#＃]\\s*\\d+\\b",
    flags: "gi",
    label: "PR番号",
  },
];
const URL_LABEL = "PR・IssueまたはJiraのリンクURL";
const HEADING_WORDS =
  /^(?:(?:作業|実装|開発)の?)?(?:進捗(?:状況|報告)?|ステータス(?:詳細)?)(?:$|[\s:：])/u;
const HEADING_REASON = stockReason("進捗見出し");
const CHECKBOX_REASON = stockReason(
  "未完了または完了済みタスクのチェックボックス",
);
const CHECKBOX = /^(\s*)((?:[-+*]|\d+[.)])\s+\[[ xX]\])(?=\s|$)/u;
const SETEXT_UNDERLINE = /^\s*(?:=+|-+)\s*$/u;

const SCHEME = /https?:\/\//giu;
const URL_END = /[\s<>"')\]]/u;
// Searched inside the part after the scheme only, so the second slash of
// `http://pull/1` is not the start of `/pull/`.
const TRACKER_PATH =
  /\/(?:(?:pull|pulls|issues)\/\d+|browse\/[a-z][a-z0-9]{1,9}-\d+)/iu;

// The original rule is one regular expression whose `[^\s<>"')\]]*` runs to the
// end of the line from every `http://`, so a line of repeated `http://` took
// quadratic time. Here each stretch from a scheme to the next delimiter is cut
// out once and judged once, and the search for the next scheme starts where the
// stretch ends. The result is the same as the original match.
function urlFindings(row: BlockLine, found: Finding[]): void {
  const text = row.text;
  const scheme = new RegExp(SCHEME.source, SCHEME.flags);
  for (;;) {
    const hit = scheme.exec(text);
    if (hit === null) return;
    const bodyStart = hit.index + hit[0].length;
    let end = bodyStart;
    while (end < text.length && !URL_END.test(text.charAt(end))) end++;
    if (TRACKER_PATH.test(text.slice(bodyStart, end)))
      found.push({
        rule: STOCK_RULE,
        line: row.line,
        column: hit.index + 1,
        text: text.slice(hit.index, end),
        reason: stockReason(URL_LABEL),
      });
    scheme.lastIndex = Math.max(end, bodyStart);
  }
}

function stockFindings(
  lines: readonly BlockLine[],
  index: number,
  found: Finding[],
): void {
  const row = lines[index];
  if (row === undefined) return;
  const own: Finding[] = [];
  for (const pattern of PATTERNS)
    for (const hit of row.text.matchAll(
      new RegExp(pattern.source, pattern.flags),
    ))
      own.push({
        rule: STOCK_RULE,
        line: row.line,
        column: hit.index + 1,
        text: hit[0],
        reason: stockReason(pattern.label),
      });
  urlFindings(row, own);
  if (row.kind === "heading") {
    if (HEADING_WORDS.test(row.text.replace(/^ {0,3}#{1,6}\s*/u, "").trim()))
      own.push(headingFinding(row));
  } else if (row.kind === "paragraph") {
    // A Setext heading is a paragraph line whose very next line is the
    // underline: a dropped line (blank, fence, comment) in between breaks it.
    const next = lines[index + 1];
    if (
      next !== undefined &&
      !next.quote &&
      next.line === row.line + 1 &&
      next.kind === "separator" &&
      SETEXT_UNDERLINE.test(next.text) &&
      HEADING_WORDS.test(row.text.trim())
    )
      own.push(headingFinding(row));
  } else if (row.kind === "list") {
    const box = CHECKBOX.exec(row.text);
    if (box?.[1] !== undefined && box[2] !== undefined)
      own.push({
        rule: STOCK_RULE,
        line: row.line,
        column: box[1].length + 1,
        text: box[2],
        reason: CHECKBOX_REASON,
      });
  }
  own.sort((a, b) => a.column - b.column);
  found.push(...own);
}

function headingFinding(row: BlockLine): Finding {
  return {
    rule: STOCK_RULE,
    line: row.line,
    column: 1,
    text: row.text,
    reason: HEADING_REASON,
  };
}

// ---- table-cell-length ----

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

const ESCAPABLE = new Set([..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"]);
const ENTITY_LIMIT = 32;
// The names that show up in tables. A name that is not here stays as written,
// which is how Markdown treats an unknown name too.
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  divide: "÷",
  middot: "·",
  bull: "•",
  deg: "°",
  plusmn: "±",
  yen: "¥",
  euro: "€",
  pound: "£",
  cent: "¢",
  sect: "§",
  para: "¶",
  laquo: "«",
  raquo: "»",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
};
const BARE_URL = /https?:\/\//uy;
const AUTOLINK_SCHEME = /[A-Za-z][A-Za-z0-9+.-]{1,31}:/uy;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

// The first index in `sorted` that is >= value, or -1.
function firstAtLeast(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return low < sorted.length ? low : -1;
}

interface Closer {
  at: number;
  paren: boolean;
}

// What a cell looks like to a reader, built in one left-to-right pass. The
// brackets of a link are not nested: `[` takes the nearest `](` or `][` after
// it as its end, so a hostile `[[[[…` costs a binary search each, not a
// recursion.
function visibleText(cell: string): string {
  const closers: Closer[] = [];
  const closerAt: number[] = [];
  const parens: number[] = [];
  const brackets: number[] = [];
  const runs = new Map<number, number[]>();
  for (let at = 0; at < cell.length; at++) {
    const char = cell.charAt(at);
    if (char === "]") {
      brackets.push(at);
      const after = cell.charAt(at + 1);
      if (after === "(" || after === "[") {
        closers.push({ at, paren: after === "(" });
        closerAt.push(at);
      }
    } else if (char === ")") parens.push(at);
    else if (char === "`") {
      const start = at;
      while (cell.charAt(at + 1) === "`") at++;
      const length = at - start + 1;
      const list = runs.get(length);
      if (list) list.push(start);
      else runs.set(length, [start]);
    }
  }
  // The end of a link whose `[` is at `open`: where its `](` or `][` starts and
  // the index just after the destination or label. null: no link here.
  const linkEnd = (open: number): { from: number; to: number } | null => {
    const index = firstAtLeast(closerAt, open + 1);
    const closer = index < 0 ? undefined : closers[index];
    if (closer === undefined) return null;
    const list = closer.paren ? parens : brackets;
    const last = firstAtLeast(list, closer.at + 2);
    const end = last < 0 ? undefined : list[last];
    return end === undefined ? null : { from: closer.at, to: end + 1 };
  };

  const parts: string[] = [];
  let skipFrom = -1;
  let skipTo = -1;
  for (let at = 0; at < cell.length;) {
    if (skipFrom >= 0 && at > skipFrom) skipFrom = -1;
    if (at === skipFrom) {
      at = skipTo;
      skipFrom = -1;
      continue;
    }
    const char = cell.charAt(at);
    if (char === "\\") {
      const next = cell.charAt(at + 1);
      if (next !== "" && ESCAPABLE.has(next)) {
        parts.push(next);
        at += 2;
      } else {
        parts.push(char);
        at++;
      }
    } else if (char === "`") {
      let end = at;
      while (cell.charAt(end + 1) === "`") end++;
      const length = end - at + 1;
      const list = runs.get(length);
      const index = list ? firstAtLeast(list, end + 1) : -1;
      const close = index < 0 || !list ? undefined : list[index];
      if (close === undefined) {
        parts.push(cell.slice(at, end + 1));
        at = end + 1;
      } else {
        parts.push(cell.slice(end + 1, close));
        at = close + length;
      }
    } else if (char === "!" && cell.charAt(at + 1) === "[") {
      // An image shows its alt text, which is the part between the brackets.
      if (linkEnd(at + 1)) at++;
      else {
        parts.push(char);
        at++;
      }
    } else if (char === "[") {
      const end = linkEnd(at);
      if (end && skipFrom < 0) {
        skipFrom = end.from;
        skipTo = end.to;
      } else if (!end) parts.push(char);
      at++;
    } else if (char === "<") {
      at = readAngle(cell, at, parts);
    } else if (char === "&") {
      at = readReference(cell, at, parts);
    } else if (char === "*" || char === "~") {
      at++;
    } else if (char === "_") {
      const before = cell.slice(at - 1, at);
      const after = cell.charAt(at + 1);
      const inside =
        before !== "" &&
        after !== "" &&
        WORD_CHARACTER.test(before) &&
        WORD_CHARACTER.test(after);
      if (inside) parts.push(char);
      at++;
    } else if (char === "h" || char === "H") {
      BARE_URL.lastIndex = at;
      const hit = BARE_URL.exec(cell);
      if (hit === null) {
        parts.push(char);
        at++;
      } else {
        let end = at + hit[0].length;
        while (end < cell.length && !/[\s<]/u.test(cell.charAt(end))) end++;
        parts.push(cell.slice(at, end));
        at = end;
      }
    } else {
      parts.push(char);
      at++;
    }
  }
  return parts.join("");
}

// `<` at `at`: an autolink shows its URL, `<br>` is a line break, any other tag
// shows nothing. The look-ahead stops at the first character that cannot belong
// (a space or `<` for an autolink, `<` for a tag), so a run of `<` costs the
// distance to the next `<` each.
function readAngle(cell: string, at: number, parts: string[]): number {
  AUTOLINK_SCHEME.lastIndex = at + 1;
  const scheme = AUTOLINK_SCHEME.exec(cell);
  if (scheme !== null) {
    let end = at + 1 + scheme[0].length;
    while (end < cell.length) {
      const char = cell.charAt(end);
      if (char === ">" || char === "<" || /\s/u.test(char)) break;
      end++;
    }
    if (cell.charAt(end) === ">") {
      parts.push(cell.slice(at + 1, end));
      return end + 1;
    }
  }
  let end = at + 1;
  if (cell.charAt(end) === "/") end++;
  if (/[A-Za-z]/u.test(cell.charAt(end))) {
    while (
      end < cell.length &&
      cell.charAt(end) !== ">" &&
      cell.charAt(end) !== "<"
    )
      end++;
    if (cell.charAt(end) === ">") {
      if (/^<br\s*\/?\s*>$/iu.test(cell.slice(at, end + 1))) parts.push("\n");
      return end + 1;
    }
  }
  parts.push("<");
  return at + 1;
}

// `&` at `at`: a numeric or named reference is decoded when its `;` is within
// ENTITY_LIMIT characters; otherwise the `&` is an ordinary character.
function readReference(cell: string, at: number, parts: string[]): number {
  const limit = Math.min(cell.length, at + ENTITY_LIMIT);
  let end = at + 1;
  while (end < limit && cell.charAt(end) !== ";") end++;
  if (cell.charAt(end) === ";" && end > at + 1) {
    const body = cell.slice(at + 1, end);
    const numeric = /^#(?:[xX]([0-9a-fA-F]{1,6})|(\d{1,7}))$/u.exec(body);
    if (numeric) {
      const code = numeric[1] ? parseInt(numeric[1], 16) : Number(numeric[2]);
      parts.push(
        code >= 1 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : "\ufffd",
      );
      return end + 1;
    }
    const named = Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : undefined;
    if (named !== undefined) {
      parts.push(named);
      return end + 1;
    }
  }
  parts.push("&");
  return at + 1;
}

// Cells of a table row, split at `|` that is not escaped. What lies outside the
// leading and the trailing `|` is not a cell.
function cellsOf(text: string): { start: number; raw: string }[] {
  const pieces: { start: number; end: number }[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text.charAt(at);
    if (char === "\\") at++;
    else if (char === "|") {
      pieces.push({ start, end: at });
      start = at + 1;
    }
  }
  pieces.push({ start, end: text.length });
  const cells = pieces.slice(1);
  const last = pieces.at(-1);
  if (last !== undefined && text.slice(last.start, last.end).trim() === "")
    cells.pop();
  return cells.map((piece) => ({
    start: piece.start,
    raw: text.slice(piece.start, piece.end),
  }));
}

function tableFindings(row: BlockLine, found: Finding[]): void {
  for (const cell of cellsOf(row.text)) {
    const trimmed = cell.raw.trim();
    if (trimmed === "") continue;
    const visible = visibleText(trimmed).trim();
    // A grapheme count never exceeds the UTF-16 length, so a short string is
    // below the limit without segmenting it.
    if (visible.length <= MAX_CELL_LENGTH) continue;
    let length = 0;
    for (const _ of segmenter.segment(visible)) length++;
    if (length <= MAX_CELL_LENGTH) continue;
    found.push({
      rule: TABLE_RULE,
      line: row.line,
      column: cell.start + (cell.raw.length - cell.raw.trimStart().length) + 1,
      text: trimmed,
      reason: `表のセルが${length}文字あります。各セルは${MAX_CELL_LENGTH}文字以内にし、詳しい説明は表の外の見出しと段落へ移してください。条件や例外は削らないでください。`,
    });
  }
}

export function blockFindings(
  lines: readonly BlockLine[],
  flags: BlockFlags,
): Finding[] {
  const found: Finding[] = [];
  if (!flags.stockBoundary && !flags.tableCells) return found;
  lines.forEach((row, index) => {
    if (row.quote) return;
    if (flags.stockBoundary) stockFindings(lines, index, found);
    if (flags.tableCells && row.kind === "table") tableFindings(row, found);
  });
  return found;
}
