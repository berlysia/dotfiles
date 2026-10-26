export type LineKind = "heading" | "list" | "table" | "paragraph";
export interface ProseLine {
  line: number;
  text: string;
  kind: LineKind;
}
// A comment that closes on the line it opens on, with the text between the
// delimiters. Whether it is a keep marker is decided in keep.ts.
export interface KeepComment {
  line: number;
  body: string;
}
// What blockLines() knows about a line. It is not a LineKind: the checks that
// read it (blocks.ts) need the separator lines that proseLines() drops, and a
// LineKind consumer must never see one.
export type BlockKind =
  | "heading"
  | "list"
  | "table"
  | "separator"
  | "paragraph";
export interface BlockLine {
  line: number;
  // The line as written, with only the HTML comments replaced by spaces of the
  // same length. Inline code, URLs and link destinations stay, and columns are
  // the same as in the original line.
  text: string;
  kind: BlockKind;
  quote: boolean;
}
export interface Paragraph {
  line: number;
  endLine: number;
  kind: LineKind;
  text: string;
}

// Spaces preserve UTF-16 offsets, including surrogate pairs, for CLI columns.
function blank(text: string): string {
  return " ".repeat(text.length);
}

function countBackticks(text: string): number {
  let count = 0;
  for (const char of text) if (char === "`") count++;
  return count;
}

export function proseLines(markdown: string): ProseLine[] {
  return scan(markdown).lines;
}

// A stretch of a prose line that scan() replaced with spaces. `link` is the
// `](...)` part of a link: the words of the link text on both sides of it read
// as one run. Everything else (code, an image, a bare URL, HTML, a comment) is
// a `barrier`: the words on its two sides do not belong together.
export interface MaskRange {
  start: number;
  end: number;
  kind: "link" | "barrier";
}
export interface ProseMask {
  line: number;
  // The line as written. A check that reports a range quotes it from here: the
  // prose text has the code, images and link destinations blanked out.
  raw: string;
  quote: boolean;
  ranges: MaskRange[];
}

// One entry per line of proseLines(), in the same order. Offsets are UTF-16
// offsets into the original line.
export function proseMasks(markdown: string): ProseMask[] {
  return scan(markdown).masks;
}

// Every line a structure check may look at: the lines of proseLines() plus the
// ones it drops for having no prose left (a URL alone, an inline code alone),
// separators, link reference definitions and nested list items indented by four
// or more spaces. Frontmatter, fences, comment-only lines and indented code are
// not returned.
export function blockLines(markdown: string): BlockLine[] {
  return scan(markdown).blocks;
}

export function keepComments(markdown: string): KeepComment[] {
  return scan(markdown).comments;
}

const INDENTED = /^(?: {4}|\t)/u;
const LIST_MARKER = /^\s*(?:[-+*]|\d+[.)])\s/u;
const REFERENCE_DEFINITION = /^\s*\[[^\]]+\]:/u;

// Judged on the text with only the comments blanked, in this order: a
// separator row such as `| --- |` must not count as a table row, and `---`
// must not count as a list.
function blockKind(text: string): BlockKind {
  if (/^ {0,3}#{1,6}\s/u.test(text)) return "heading";
  if (/^[-=|:\s]+$/u.test(text)) return "separator";
  if (LIST_MARKER.test(text)) return "list";
  if (/^\s*\|/u.test(text)) return "table";
  return "paragraph";
}

const MARK_BARRIER = 1;
const MARK_LINK = 2;

// Replaces every match with spaces. A position that an earlier stage already
// replaced keeps the earlier stage's mark, so the ranges never overlap.
// Why not String.replace with a callback: its offset argument sits after a
// capture-count-dependent number of arguments.
function blankMatches(
  text: string,
  pattern: RegExp,
  marks: Uint8Array,
  mark: number,
): string {
  let result = "";
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index;
    const end = start + found[0].length;
    result += text.slice(last, start) + blank(found[0]);
    last = end;
    for (let at = start; at < end; at++) if (marks[at] === 0) marks[at] = mark;
  }
  return result + text.slice(last);
}

function rangesOf(marks: Uint8Array): MaskRange[] {
  const ranges: MaskRange[] = [];
  for (let at = 0; at < marks.length;) {
    const mark = marks[at];
    if (mark === 0) {
      at++;
      continue;
    }
    const start = at;
    while (at < marks.length && marks[at] === mark) at++;
    ranges.push({
      start,
      end: at,
      kind: mark === MARK_LINK ? "link" : "barrier",
    });
  }
  return ranges;
}

// One pass yields both the prose and the comments, so the two agree on which
// lines are frontmatter, fences and code.
function scan(markdown: string): {
  lines: ProseLine[];
  comments: KeepComment[];
  masks: ProseMask[];
  blocks: BlockLine[];
} {
  const rows = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let frontmatter = rows[0]?.trim() === "---";
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  const result: ProseLine[] = [];
  const comments: KeepComment[] = [];
  const masks: ProseMask[] = [];
  const blocks: BlockLine[] = [];
  // Whether the line before this one (no blank or dropped line between) was
  // returned as a list item. A nested item indented by four spaces or more is a
  // list item only after one; anywhere else that indent is indented code.
  let afterList = false;
  for (const [index, raw] of rows.entries()) {
    const followsList = afterList;
    afterList = false;
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(raw)) frontmatter = false;
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(raw);
    if (fence) {
      if (
        marker?.[1]?.[0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
      continue;
    }
    if (marker?.[1]) {
      fence = { char: marker[1].charAt(0), length: marker[1].length };
      continue;
    }
    let text = "";
    const startedInComment = comment;
    const found: string[] = [];
    // Backticks outside comments so far on this line; an odd count at a `<!--`
    // means the comment starts inside an inline code span, which wins because
    // it started first. Backticks inside a comment belong to the comment.
    let ticks = 0;
    let bodyStart = -1;
    const marks = new Uint8Array(raw.length);
    for (let offset = 0; offset < raw.length;) {
      const open = comment ? -1 : raw.indexOf("<!--", offset);
      if (comment) {
        const end = raw.indexOf("-->", offset);
        if (end < 0) {
          text += blank(raw.slice(offset));
          marks.fill(MARK_BARRIER, offset);
          break;
        }
        if (bodyStart >= 0)
          found.push(raw.slice(bodyStart, Math.max(bodyStart, end)));
        bodyStart = -1;
        text += blank(raw.slice(offset, end + 3));
        marks.fill(MARK_BARRIER, offset, end + 3);
        offset = end + 3;
        comment = false;
      } else if (open >= 0) {
        text += raw.slice(offset, open);
        ticks += countBackticks(raw.slice(offset, open));
        bodyStart = ticks % 2 === 0 ? open + 4 : -1;
        offset = open;
        comment = true;
      } else {
        text += raw.slice(offset);
        break;
      }
    }
    // Indented code is judged on the raw line here: a comment at the start of
    // the line blanks the masked text, but the line is not an indented block.
    const indented = INDENTED.test(text);
    const definition = REFERENCE_DEFINITION.test(text);
    const continuesList = indented && followsList && LIST_MARKER.test(text);
    const codeLine =
      (!startedInComment && INDENTED.test(raw) && !continuesList) ||
      (definition && indented);
    if (!codeLine)
      for (const body of found) comments.push({ line: index + 1, body });
    if (text.trim() !== "" && (!indented || continuesList)) {
      const kind = blockKind(text);
      blocks.push({
        line: index + 1,
        text,
        kind,
        quote: /^\s*>/u.test(text),
      });
      afterList = kind === "list";
    }
    if (indented || definition) continue;
    text = blankMatches(text, /(`+)([^`]|(?!\1)`)*?\1/gu, marks, MARK_BARRIER);
    text = blankMatches(text, /!\[[^\]]*\]\([^\n]*?\)/gu, marks, MARK_BARRIER);
    text = blankMatches(text, /\]\([^\n]*?\)/gu, marks, MARK_LINK);
    // A bare URL ends at the first non-ASCII character: Japanese prose often
    // follows it with no space, as in "（https://…）。以下は…".
    text = blankMatches(
      text,
      /https?:\/\/[^\s<>)\u{80}-\u{10FFFF}]*/gu,
      marks,
      MARK_BARRIER,
    );
    text = blankMatches(text, /<[^>]*>/gu, marks, MARK_BARRIER);
    if (!text.trim() || /^\s*\|?\s*:?-{3,}/u.test(text)) continue;
    const kind: LineKind = /^ {0,3}#{1,6}\s/u.test(text)
      ? "heading"
      : /^\s*(?:[-+*]|\d+[.)])\s/u.test(text)
        ? "list"
        : /^\s*\|/u.test(text)
          ? "table"
          : "paragraph";
    // Judged before the marker is blanked, and on the leading `>` only: a `>`
    // inside a list item or a continuation line without one is not a quote.
    const quote = /^\s*>/u.test(text);
    text = text.replace(
      /^ {0,3}#{1,6}\s+|^\s*(?:[-+*]|\d+[.)])\s+|^\s*>\s?/u,
      blank,
    );
    result.push({ line: index + 1, text, kind });
    masks.push({ line: index + 1, raw, quote, ranges: rangesOf(marks) });
  }
  return { lines: result, comments, masks, blocks };
}

export function paragraphs(lines: ProseLine[]): Paragraph[] {
  const result: Paragraph[] = [];
  for (const row of lines) {
    const previous = result.at(-1);
    if (
      previous?.kind === "paragraph" &&
      row.kind === "paragraph" &&
      previous.endLine + 1 === row.line
    ) {
      previous.endLine = row.line;
      previous.text += `\n${row.text.trim()}`;
    } else {
      result.push({ ...row, endLine: row.line, text: row.text.trim() });
    }
  }
  return result;
}
