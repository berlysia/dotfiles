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

export function keepComments(markdown: string): KeepComment[] {
  return scan(markdown).comments;
}

// One pass yields both the prose and the comments, so the two agree on which
// lines are frontmatter, fences and code.
function scan(markdown: string): {
  lines: ProseLine[];
  comments: KeepComment[];
} {
  const rows = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let frontmatter = rows[0]?.trim() === "---";
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  const result: ProseLine[] = [];
  const comments: KeepComment[] = [];
  for (const [index, raw] of rows.entries()) {
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
    for (let offset = 0; offset < raw.length;) {
      const open = comment ? -1 : raw.indexOf("<!--", offset);
      if (comment) {
        const end = raw.indexOf("-->", offset);
        if (end < 0) {
          text += blank(raw.slice(offset));
          break;
        }
        if (bodyStart >= 0)
          found.push(raw.slice(bodyStart, Math.max(bodyStart, end)));
        bodyStart = -1;
        text += blank(raw.slice(offset, end + 3));
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
    const codeLine =
      (!startedInComment && /^(?: {4}|\t)/u.test(raw)) ||
      /^\s*\[[^\]]+\]:/u.test(text);
    if (!codeLine)
      for (const body of found) comments.push({ line: index + 1, body });
    if (/^(?: {4}|\t)/u.test(text) || /^\s*\[[^\]]+\]:/u.test(text)) continue;
    text = text
      .replace(/(`+)([^`]|(?!\1)`)*?\1/gu, blank)
      .replace(/!\[[^\]]*\]\([^\n]*?\)/gu, blank)
      .replace(/\]\([^\n]*?\)/gu, blank)
      .replace(/https?:\/\/[^\s<>)]*/gu, blank)
      .replace(/<[^>]*>/gu, blank);
    if (!text.trim() || /^\s*\|?\s*:?-{3,}/u.test(text)) continue;
    const kind: LineKind = /^ {0,3}#{1,6}\s/u.test(text)
      ? "heading"
      : /^\s*(?:[-+*]|\d+[.)])\s/u.test(text)
        ? "list"
        : /^\s*\|/u.test(text)
          ? "table"
          : "paragraph";
    text = text.replace(
      /^ {0,3}#{1,6}\s+|^\s*(?:[-+*]|\d+[.)])\s+|^\s*>\s?/u,
      blank,
    );
    result.push({ line: index + 1, text, kind });
  }
  return { lines: result, comments };
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
