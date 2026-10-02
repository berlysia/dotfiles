#!/usr/bin/env node --test
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { extractCommandsStructured } from "../../lib/bash-parser.ts";
import { prepareDenyInput } from "../../lib/deny-input.ts";

const R = "r" + "m -rf";
const P = "node" + "_modules";

describe("prepareDenyInput (spec K1)", () => {
  it("returns the masked text and its fragments", async () => {
    const raw = `cat <<'EOF' > out.txt\n${R} ${P}/x\nEOF`;
    const input = await prepareDenyInput(raw);
    strictEqual(input.maskedText, "cat <<'EOF' > out.txt\nEOF");
    ok(input.individualCommands.every((fragment) => !fragment.includes(P)));
    strictEqual(input.parsingMethod, "tree-sitter");
  });
  it("matches extractCommandsStructured on an input without a data heredoc", async () => {
    // The last one fails to parse: maskedText stays raw.
    for (const raw of [
      "ls -la && pwd",
      `bash <<'EOF'\n${R} ${P}/x\nEOF`,
      `cat <<'EOF' > f; x\n${R} ${P}/x\nEOF`,
    ]) {
      const input = await prepareDenyInput(raw);
      const base = await extractCommandsStructured(raw);
      strictEqual(input.maskedText, raw);
      deepStrictEqual(input.individualCommands, base.individualCommands);
      strictEqual(input.parsingMethod, base.parsingMethod);
    }
  });
});
