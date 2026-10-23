export type LineKind = "heading" | "list" | "table" | "paragraph";
export interface ProseLine {
  line: number;
  text: string;
  kind: LineKind;
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

export function proseLines(markdown: string): ProseLine[] {
  const rows = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let frontmatter = rows[0]?.trim() === "---";
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  const result: ProseLine[] = [];
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
    for (let offset = 0; offset < raw.length;) {
      const open = comment ? -1 : raw.indexOf("<!--", offset);
      if (comment) {
        const end = raw.indexOf("-->", offset);
        if (end < 0) {
          text += blank(raw.slice(offset));
          break;
        }
        text += blank(raw.slice(offset, end + 3));
        offset = end + 3;
        comment = false;
      } else if (open >= 0) {
        text += raw.slice(offset, open);
        offset = open;
        comment = true;
      } else {
        text += raw.slice(offset);
        break;
      }
    }
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
  return result;
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
