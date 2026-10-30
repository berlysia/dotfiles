import { expect, test } from "claude-code/testing";
import type { SessionMessage } from "claude-code";
import { extractItems } from "./extract-items";

const message = (
  role: SessionMessage["role"],
  text: string,
): SessionMessage => ({ role, text, toolUses: [] });

const assistant = (text: string): SessionMessage => message("assistant", text);

test("extracts newest inline and full items before older code and full items", () => {
  const result = extractItems(
    [
      assistant("```bash\nls -la\n```"),
      assistant("Run `! gh pr merge 1` when ready."),
    ],
    "",
  );
  expect(result.items.map((item) => [item.kind, item.text])).toEqual([
    ["inline", "! gh pr merge 1"],
    ["full", "Run `! gh pr merge 1` when ready."],
    ["code", "ls -la"],
    ["full", "```bash\nls -la\n```"],
  ]);
});

test("filters before the 200 item limit so an older match remains", () => {
  const messages = [
    assistant("gh pr view"),
    ...Array.from({ length: 200 }, (_, index) =>
      assistant(`git status ${index + 1}`),
    ),
  ];
  const result = extractItems(messages, "GH");
  expect(result.items.map((item) => item.text)).toEqual(["gh pr view"]);
  expect(result.droppedCount).toBe(0);
});

test("limits code text to 64 KiB and marks it truncated", () => {
  const result = extractItems(
    [assistant(`\`\`\`sh\n${"a".repeat(65 * 1024)}\n\`\`\``)],
    "",
  );
  const code = result.items.find((item) => item.kind === "code");
  expect(code?.text.length).toBe(64 * 1024);
  expect(code?.truncated).toBe(true);
});

test("does not split a code point at the 64 KiB boundary", () => {
  const result = extractItems(
    [assistant(`\`\`\`sh\n${"a".repeat(65_535)}😀\n\`\`\``)],
    "",
  );
  const code = result.items.find((item) => item.kind === "code");
  expect(code?.text).toBe("a".repeat(65_535));
  expect(code?.truncated).toBe(true);
});

test("labels distinguish long text and stay within 80 code points", () => {
  const result = extractItems(
    [
      assistant(`\`\`\`\n${"x".repeat(80)}a\n\`\`\``),
      assistant(`\`\`\`\n${"x".repeat(80)}bb\n\`\`\``),
    ],
    "",
  );
  const labels = result.items
    .filter((item) => item.kind === "code")
    .map((item) => item.label);
  expect(labels.length).toBe(2);
  expect(labels[0]).not.toBe(labels[1]);
  expect(Array.from(labels[0] ?? "").length).toBeLessThanOrEqual(80);
  expect(Array.from(labels[1] ?? "").length).toBeLessThanOrEqual(80);
});

test("labels replace newline and Unicode line separators", () => {
  const result = extractItems(
    [assistant("```text\nfirst\nsecond\u2028third\u2029fourth\n```")],
    "",
  );
  const label = result.items.find((item) => item.kind === "code")?.label ?? "";
  expect(label.includes("\n")).toBe(false);
  expect(label.includes("\u2028")).toBe(false);
  expect(label.includes("\u2029")).toBe(false);
});

test("does not extract inline code from inside a fenced block", () => {
  const result = extractItems([assistant("```sh\n`git status`\n```")], "");
  expect(result.items.some((item) => item.kind === "inline")).toBe(false);
});

test("does not make items from a whitespace-only response", () => {
  expect(extractItems([assistant(" \n\t ")], "").items).toEqual([]);
});

test("deduplicates repeated inline commands in the same response", () => {
  const result = extractItems(
    [assistant("Run `git status` and then `git status` again.")],
    "",
  );
  expect(
    result.items.filter(
      (item) => item.kind === "inline" && item.text === "git status",
    ).length,
  ).toBe(1);
});

test("keeps command-like inline code and drops a filename", () => {
  const result = extractItems(
    [assistant("Use `register.tsx` and then run `git status`.")],
    "",
  );
  expect(
    result.items
      .filter((item) => item.kind === "inline")
      .map((item) => item.text),
  ).toEqual(["git status"]);
});

test("takes an unclosed fenced block through the end of the response", () => {
  const result = extractItems([assistant("```sh\nfirst\nsecond")], "");
  expect(result.items.find((item) => item.kind === "code")?.text).toBe(
    "first\nsecond",
  );
});

test("a shorter fence does not close a longer fenced block", () => {
  const result = extractItems([assistant("````sh\n```\nactual\n````")], "");
  expect(result.items.filter((item) => item.kind === "code").length).toBe(1);
  expect(result.items.find((item) => item.kind === "code")?.text).toBe(
    "```\nactual",
  );
});

test("a mixed-character fence does not close a fenced block", () => {
  const result = extractItems(
    [assistant("```sh\nfirst\n``~\nsecond\n```")],
    "",
  );
  expect(result.items.find((item) => item.kind === "code")?.text).toBe(
    "first\n``~\nsecond",
  );
});

test("keeps the newest occurrence of a repeated command", () => {
  const result = extractItems(
    [
      assistant("Earlier `git status`"),
      assistant("A different response"),
      assistant("Latest `git status`"),
    ],
    "",
  );
  const commandItems = result.items.filter(
    (item) => item.kind === "inline" && item.text === "git status",
  );
  expect(commandItems.length).toBe(1);
  const newestCommand = commandItems[0];
  if (newestCommand === undefined) throw new Error("missing command item");
  expect(result.items.indexOf(newestCommand)).toBeLessThan(
    result.items.findIndex((item) => item.text === "Earlier `git status`"),
  );
});

test("filters text case-insensitively", () => {
  const result = extractItems(
    [assistant("gh pr view"), assistant("git status")],
    "GH",
  );
  expect(result.items.map((item) => item.text)).toEqual(["gh pr view"]);
});

test("removes the specified controls while retaining tab and newline", () => {
  const controls =
    "\u001b\r\u007f\u0085\u061c\u200b\u200f\u202e\u2060\u2069\ufeff";
  const result = extractItems(
    [assistant(`\`\`\`text\n${controls}\tkeep\nline\n\`\`\``)],
    "",
  );
  expect(result.items.find((item) => item.kind === "code")?.text).toBe(
    "\tkeep\nline",
  );
});

test("removes controls from inline and full item text", () => {
  const result = extractItems(
    [assistant("Run `! gh\u001b status`\u202e now")],
    "",
  );
  for (const item of result.items) {
    expect(item.text.includes("\u001b")).toBe(false);
    expect(item.text.includes("\u202e")).toBe(false);
  }
  expect(result.items.find((item) => item.kind === "inline")?.text).toBe(
    "! gh status",
  );
});

test("ignores user messages", () => {
  expect(extractItems([message("user", "`git status`")], "").items).toEqual([]);
});

test("keeps the newest 200 items and reports the older dropped item", () => {
  const messages = Array.from({ length: 201 }, (_, index) =>
    assistant(`entry-${index + 1}`),
  );
  const result = extractItems(messages, "");
  expect(result.items.length).toBe(200);
  expect(result.items[0]?.text).toBe("entry-201");
  expect(result.items[199]?.text).toBe("entry-2");
  expect(result.droppedCount).toBe(1);
});

test("orders kinds as code, inline, and full within one response", () => {
  const result = extractItems(
    [assistant("Use `! gh pr merge 1`\n```sh\nls -la\n```")],
    "",
  );
  expect(result.items.map((item) => item.kind)).toEqual([
    "code",
    "inline",
    "full",
  ]);
});
