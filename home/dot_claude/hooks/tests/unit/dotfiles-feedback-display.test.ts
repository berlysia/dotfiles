import { strictEqual } from "node:assert";
import { it } from "node:test";
import { sanitizeForDisplay } from "../../lib/dotfiles-feedback/display.ts";

const plain = { multiline: false };
const multi = { multiline: true };

for (const [name, input, expected] of [
  ["CSI and OSC with BEL", "a\u001b[31mb\u001b]0;x\u0007c", "abc"],
  ["DCS terminated by ST", "a\u001bP1;2q\u001b\\b", "ab"],
  ["APC terminated by ST", "a\u001b_x\u001b\\b", "ab"],
  ["unterminated OSC runs to the end", "a\u001b]0;title", "a"],
  ["two-character escape", "a\u001bcb", "ab"],
  ["C1 controls and 8-bit CSI", "x\u0085y\u009b31mz", "xyz"],
  [
    "invisible char between ESC and [ does not leave the sequence",
    "\u001b​[31mX",
    "X",
  ],
  [
    "bidi, ALM, line separators and tag characters",
    "a⁦b⁩c؜d e f\u{e0041}g‮h",
    "abcdefgh",
  ],
] as const) {
  it(`sanitizeForDisplay: ${name}`, () =>
    strictEqual(sanitizeForDisplay(input, plain), expected));
}

it("sanitizeForDisplay: newline and tab depend on multiline", () => {
  strictEqual(sanitizeForDisplay("a\r\nb\tc", multi), "a\nb\tc");
  strictEqual(sanitizeForDisplay("a\r\nb\tc", plain), "a b c");
});

it("sanitizeForDisplay: is idempotent", () => {
  for (const input of [
    "a\u001b[31mb\u001b]0;x\u0007c",
    "\u001b​[31mX",
    "x\u0085y\u009b31mz",
    "a\r\nb\tc\u001b",
    "\u001b\u001b[31m",
    "plain",
  ])
    for (const options of [plain, multi]) {
      const once = sanitizeForDisplay(input, options);
      strictEqual(sanitizeForDisplay(once, options), once);
    }
});

import { renderIssue } from "../../lib/dotfiles-feedback/issue-body.ts";
import {
  formatCancelled,
  formatShow,
  type ShowView,
} from "../../lib/dotfiles-feedback/display.ts";

const MARKER = renderIssue({
  schemaVersion: 1,
  id: "20261029T010203Z-000000000001",
  createdAt: "2026-10-29T01:02:03Z",
  title: "t",
  target: "x",
  kind: "bug",
  body: "",
  source: { agent: "human", repoKey: null, host: "h", vm: false },
}).body.split("\n", 1)[0]!;
const view = (over: Partial<ShowView>): ShowView => ({
  source: "github",
  number: 4,
  id: "20261029T010203Z-000000000001",
  title: "題",
  target: "x",
  kind: "bug",
  body: "",
  ...over,
});
// 区切りの中の文字列だけを取り出す。
const inside = (text: string) => text.split("\n").slice(3, -2).join("\n");
const shown = (over: Partial<ShowView>) =>
  inside(formatShow(view(over), "abcd1234"));

for (const [name, body, target, expected] of [
  [
    "marker, blank, target, blank, body",
    `${MARKER}\n\n対象: x\n\n本文`,
    "x",
    "本文",
  ],
  [
    "a different target stays",
    `${MARKER}\n\n対象: y\n\n本文`,
    "x",
    "対象: y\n\n本文",
  ],
  ["marker only", MARKER, "x", ""],
  ["marker then body with no blank line", `${MARKER}\n本文`, "x", "本文"],
  [
    "marker and target lines with no blank lines",
    `${MARKER}\n対象: x\n本文`,
    "x",
    "本文",
  ],
  ["a first line that is not a marker", "前置き\n本文", "x", "前置き\n本文"],
] as const)
  it(`formatShow: ${name}`, () =>
    strictEqual(shown({ body, target }), expected));

it("formatShow: a local item is shown as it is", () =>
  strictEqual(
    shown({
      source: "local",
      place: "pending",
      body: `${MARKER}\n\n対象: x\n\n本文`,
    }),
    `${MARKER}\n\n対象: x\n\n本文`,
  ));

it("formatCancelled: prefixes 中止した and strips escapes", () => {
  strictEqual(
    formatCancelled("下書きが変わっていない"),
    "中止した: 下書きが変わっていない\n",
  );
  strictEqual(formatCancelled("a\u001b[31mb").includes("\u001b"), false);
});
