// Upper bounds only. Behaviour is covered in unit/japanese-check-blocks.test.ts.
import { ok } from "node:assert";
import { describe, it } from "node:test";
import { blockFindings } from "../../../japanese-check/blocks.ts";
import { blockLines } from "../../../japanese-check/markdown.ts";

const SIZE = 20_000;
const LIMIT_MS = 1_000;
const BOTH = { stockBoundary: true, tableCells: true };

// Each input is built so that a quadratic step would show: a delimiter that
// repeats, a closer that exists only once at the end, or a run that never ends.
const cases: Array<[string, string]> = [
  ["pipes in a table row", `|${"|".repeat(SIZE)}`],
  ["http:// without a space", "http://".repeat(SIZE)],
  ["<!-- repeated", "<!--".repeat(SIZE)],
  ["<!--x--> repeated", "<!--x-->".repeat(SIZE)],
  ["[ repeated", "[".repeat(SIZE)],
  ["![ repeated", "![".repeat(SIZE)],
  ["]( repeated", "](".repeat(SIZE)],
  ["backticks", "`".repeat(SIZE)],
  ["< repeated", "<".repeat(SIZE)],
  ["& repeated", "&".repeat(SIZE)],
  ["backslash repeated", "\\".repeat(SIZE)],
  ["[ then one ]", `${"[".repeat(SIZE)}]`],
  ["< then one >", `${"<".repeat(SIZE)}>`],
  ["& then one ;", `${"&".repeat(SIZE)};`],
  ["![ then one ](", `${"![".repeat(SIZE)}](`],
  ["[a]( then one )", `${"[a](".repeat(SIZE)})`],
  ["<http: then one >", `${"<http:".repeat(SIZE)}>`],
  [
    "backtick runs of growing length",
    Array.from({ length: 200 }, (_, i) => "`".repeat(i + 1)).join(" "),
  ],
  ["PR then spaces", `PR${" ".repeat(SIZE)}`],
  ["進捗 then spaces", `進捗${" ".repeat(SIZE)}`],
];

describe("blocks stay linear", () => {
  for (const [name, line] of cases) {
    for (const [shape, text] of [
      ["table row", `| ${line} |\n| --- |\n| ${line} |`],
      ["paragraph", line],
    ] as const) {
      it(`${name} (${shape})`, () => {
        const started = performance.now();
        blockFindings(blockLines(text), BOTH);
        ok(performance.now() - started < LIMIT_MS, name);
      });
    }
  }

  it("[ nested 20,000 deep in a table row and a paragraph", () => {
    const nested = `${"[".repeat(SIZE)}x${"](u)".repeat(SIZE)}`;
    const started = performance.now();
    blockFindings(blockLines(`| ${nested} |`), BOTH);
    blockFindings(blockLines(nested), BOTH);
    ok(performance.now() - started < LIMIT_MS);
  });
});
