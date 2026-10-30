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
  message: string;
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

function lineCount(text: string): number {
  let count = 1;
  for (const character of text) {
    if (
      character === "\n" ||
      character === "\u2028" ||
      character === "\u2029"
    ) {
      count += 1;
    }
  }
  return count;
}

function characterCount(text: string): number {
  let count = 0;
  for (const character of text) {
    if (
      character !== "\n" &&
      character !== "\u2028" &&
      character !== "\u2029"
    ) {
      count += 1;
    }
  }
  return count;
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
      message: `コピーを送った（${characterCount(item.text)} 文字、${lineCount(item.text)} 行）`,
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
