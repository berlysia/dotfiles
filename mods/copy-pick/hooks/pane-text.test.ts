import { expect, test } from "claude-code/testing";
import type {
  RenderSurface,
  SessionMessage,
  UiCopyArgs,
  UiCopyResult,
} from "claude-code";
import { extractItems } from "./extract-items";
import {
  COMMAND_CONTEXT,
  COMMAND_TEXT,
  commandReply,
  copySelection,
  readPaneText,
} from "./pane-text";

const message = (
  role: SessionMessage["role"],
  text: string,
): SessionMessage => ({ role, text, toolUses: [] });

const assistant = (text: string): SessionMessage => message("assistant", text);
const user = (text: string): SessionMessage => message("user", text);
const surface: RenderSurface = "terminal";

test("an empty result says only that there are no matches", async () => {
  const result = await readPaneText(
    async () => Array.from({ length: 10 }, () => user("hello")),
    "",
  );
  expect(result.lines).toEqual(["該当なし"]);
  expect(result.lines.join(" ").includes("compact")).toBe(false);
});

test("an empty result at 4096 messages adds a separate range note", async () => {
  const result = await readPaneText(
    async () => Array.from({ length: 4096 }, () => user("hello")),
    "",
  );
  expect(result.lines).toEqual(["該当なし", "古い会話は範囲外の可能性がある"]);
});

test("copies sanitized text to the supplied surface and returns the same text", async () => {
  const messages = [assistant("```sh\nfirst\u001b\u202e\nsecond\n```")];
  const item = extractItems(messages, "").items.find(
    (entry) => entry.kind === "code",
  );
  if (item === undefined) throw new Error("missing code item");
  let received: UiCopyArgs | undefined;
  const result = await copySelection(item, surface, async (args) => {
    received = args;
    return { isCopied: true };
  });
  expect(received?.surface).toBe(surface);
  expect(received?.text).toBe(result.copiedText);
  expect(result.copiedText).toBe("first\nsecond");
  expect(result.copiedText?.includes("\u001b")).toBe(false);
  expect(result.copiedText?.includes("\u202e")).toBe(false);
});

test("a copy exception exposes only the fixed failure class", async () => {
  const error = Object.assign(new Error("token=abc"), {
    name: "token=abc",
    stack: "token=abc",
  });
  const result = await copySelection(
    { kind: "full", text: "safe", label: "safe", truncated: false },
    surface,
    async () => {
      throw error;
    },
  );
  expect(result.message).toBe("コピーできなかった");
  expect(result.logClass).toBe("copy-failed");
  expect(result.message.includes("token")).toBe(false);
  expect(result.logClass?.includes("token")).toBe(false);
});

test("the command reply stays fixed when the conversation contains a canary", () => {
  const messages = [assistant("COPY_PICK_CANARY")];
  const reply = commandReply();
  expect(messages[0]?.text).toBe("COPY_PICK_CANARY");
  expect(reply.text).toBe(COMMAND_TEXT);
  expect(reply.context).toEqual([COMMAND_CONTEXT]);
  expect(reply.text.includes("COPY_PICK_CANARY")).toBe(false);
  expect(reply.context.join(" ").includes("COPY_PICK_CANARY")).toBe(false);
});

test("shows each copy failure reason without claiming the text was sent", async () => {
  const reasons: Extract<UiCopyResult, { isCopied: false }>["reason"][] = [
    "no-surface",
    "no-clipboard",
    "refused",
  ];
  const expected = ["画面がない", "クリップボードを使えない", "拒否された"];
  for (let index = 0; index < reasons.length; index += 1) {
    const reason = reasons[index];
    if (reason === undefined) throw new Error("missing copy reason");
    const result = await copySelection(
      { kind: "code", text: "safe", label: "safe", truncated: false },
      surface,
      async () => ({ isCopied: false, reason }),
    );
    expect(result.message.includes(expected[index] ?? "")).toBe(true);
    expect(result.message.includes("コピーを送った")).toBe(false);
    expect(result.copiedText).toBeNull();
  }
});

test("reports a successful copy with character and line counts and the full text", async () => {
  const text = "123456\n7890";
  const result = await copySelection(
    { kind: "code", text, label: "sample", truncated: false },
    surface,
    async () => ({ isCopied: true }),
  );
  expect(result.message).toBe("コピーを送った（10 文字、2 行）");
  expect(result.copiedText).toBe(text);
});

test("a read exception exposes only the fixed failure class", async () => {
  const error = Object.assign(new Error("token=abc"), {
    name: "token=abc",
    stack: "token=abc",
  });
  const result = await readPaneText(async () => {
    throw error;
  }, "");
  expect(result.lines).toEqual(["読めなかった"]);
  expect(result.logClass).toBe("read-failed");
  expect(result.lines.join(" ").includes("token")).toBe(false);
  expect(result.logClass?.includes("token")).toBe(false);
});

test("reports both dropped items and truncated items", async () => {
  const messages = [
    ...Array.from({ length: 201 }, (_, index) =>
      assistant(`entry-${index + 1}`),
    ),
    assistant(`\`\`\`sh\n${"x".repeat(65 * 1024)}\n\`\`\``),
  ];
  const result = await readPaneText(async () => messages, "");
  expect(result.lines.some((line) => line.includes("64 KiB"))).toBe(true);
  expect(result.lines.some((line) => line.includes("省略: 3 件"))).toBe(true);
});

test("marks the latest-message range at 4096 but not 4095", async () => {
  const atLimit = await readPaneText(
    async () => Array.from({ length: 4096 }, () => user("hello")),
    "",
  );
  const belowLimit = await readPaneText(
    async () => Array.from({ length: 4095 }, () => user("hello")),
    "",
  );
  expect(atLimit.lines.includes("古い会話は範囲外の可能性がある")).toBe(true);
  expect(belowLimit.lines.includes("古い会話は範囲外の可能性がある")).toBe(
    false,
  );
});
