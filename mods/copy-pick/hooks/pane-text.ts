import type {
  RenderSurface,
  SessionMessage,
  UiCopyArgs,
  UiCopyResult,
} from "claude-code";
import { extractItems, type PickItem } from "./extract-items";

export type PaneText = {
  items: PickItem[];
  lines: string[];
  logClass?: "read-failed";
};

export type SelectionText = {
  message: string | null;
  copiedText: string | null;
  logClass?: "copy-failed";
};

export const COMMAND_TEXT = "手元のペインで項目を選ぶ";
export const COMMAND_CONTEXT =
  "利用者が選んだ項目をクリップボードへ送る。項目の本文は手元のペインに表示する";

export function commandReply(): { text: string; context: string[] } {
  return { text: COMMAND_TEXT, context: [COMMAND_CONTEXT] };
}

export async function readPaneText(
  read: () => Promise<SessionMessage[]>,
  query: string,
): Promise<PaneText> {
  try {
    const messages = await read();
    const { items, droppedCount } = extractItems(messages, query);
    const lines: string[] = [];
    if (items.length === 0) lines.push("該当なし");

    const truncatedCount = items.filter((item) => item.truncated).length;
    if (truncatedCount > 0) {
      lines.push(`64 KiB で切った項目: ${truncatedCount} 件`);
    }
    if (droppedCount > 0) lines.push(`古い項目を省略: ${droppedCount} 件`);
    if (messages.length === 4096) {
      lines.push("古い会話は範囲外の可能性がある");
    }

    return { items, lines };
  } catch {
    return { items: [], lines: ["読めなかった"], logClass: "read-failed" };
  }
}

export type PageRange = { start: number; end: number };

/**
 * Splits items into pages of at most pageRows rows, a separator between two
 * groups taking one. A group moves whole to the next page unless it alone is
 * larger than a page.
 */
export function buildPages(groups: number[], pageRows: number): PageRange[] {
  const pages: PageRange[] = [];
  let pageStart = 0;
  let rows = 0;
  let index = 0;
  while (index < groups.length) {
    let groupEnd = index;
    while (groups[groupEnd] === groups[index]) groupEnd += 1;
    const groupSize = groupEnd - index;
    if (rows > 0 && rows + 1 + groupSize > pageRows) {
      pages.push({ start: pageStart, end: index });
      pageStart = index;
      rows = 0;
    }
    if (rows > 0) rows += 1;
    for (; index < groupEnd; index += 1) {
      if (rows === pageRows) {
        pages.push({ start: pageStart, end: index });
        pageStart = index;
        rows = 0;
      }
      rows += 1;
    }
  }
  pages.push({ start: pageStart, end: groups.length });
  return pages;
}

// Counts anything outside ASCII as two cells: too short on a narrow glyph, but never a wrapped row.
export function clipToCells(text: string, maxCells: number): string {
  let cells = 0;
  let clipped: string | null = null;
  let kept = "";
  for (const character of text) {
    cells += character.charCodeAt(0) < 0x80 ? 1 : 2;
    if (cells > maxCells) return clipped ?? "…";
    if (cells <= maxCells - 1) {
      kept += character;
      clipped = `${kept}…`;
    }
  }
  return text;
}

export function previewText(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = Math.max(maxLines - 1, 1);
  return `${lines.slice(0, kept).join("\n")}\n… 残り ${lines.length - kept} 行`;
}

const COPY_FAILURE_TEXT: Record<
  Extract<UiCopyResult, { isCopied: false }>["reason"],
  string
> = {
  "no-surface": "コピーできなかった（コピー先の画面がない）",
  "no-clipboard": "コピーできなかった（クリップボードを使えない）",
  refused: "コピーできなかった（拒否された）",
};

export async function copySelection(
  item: PickItem,
  surface: RenderSurface,
  copy: (args: UiCopyArgs) => Promise<UiCopyResult>,
): Promise<SelectionText> {
  try {
    const result = await copy({ text: item.text, surface });
    if (!result.isCopied) {
      return {
        message: COPY_FAILURE_TEXT[result.reason],
        copiedText: null,
      };
    }
    return {
      // No text on success: the check mark on the row says it, and a line above the list would shift the rows.
      message: null,
      copiedText: item.text,
    };
  } catch {
    return {
      message: "コピーできなかった",
      copiedText: null,
      logClass: "copy-failed",
    };
  }
}
