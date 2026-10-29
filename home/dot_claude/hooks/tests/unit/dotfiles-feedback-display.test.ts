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
