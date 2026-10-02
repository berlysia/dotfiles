#!/usr/bin/env node --test
import { ok } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const IMPL = join(import.meta.dirname, "../../implementations");
const DENY_HOOKS = [
  "deny-node-modules.ts",
  "auto-approve.ts",
  "document-workflow-guard.ts",
];
// Hooks that may read Bash fragments without prepareDenyInput, each with the
// reason. Empty today: only the three deny-side hooks split Bash commands.
const RAW_FRAGMENT_READERS: Record<string, string> = {};

describe("deny-side hooks read Bash through prepareDenyInput (spec K1)", () => {
  for (const file of DENY_HOOKS) {
    const source = readFileSync(join(IMPL, file), "utf8");
    it(`${file} imports prepareDenyInput`, () => {
      ok(
        /import \{[^}]*\bprepareDenyInput\b[^}]*\} from "\.\.\/lib\/deny-input\.ts"/.test(
          source,
        ),
      );
    });
  }
  // The identifier shows up in a static import, through the command-parsing.ts
  // re-export, and in a dynamic import() alike, so a fourth hook that starts
  // splitting Bash on its own fails here.
  for (const file of readdirSync(IMPL).filter((name) => name.endsWith(".ts"))) {
    if (file in RAW_FRAGMENT_READERS) continue;
    const source = readFileSync(join(IMPL, file), "utf8");
    it(`${file} does not reach extractCommandsStructured or heredoc-data`, () => {
      ok(
        !/\bextractCommandsStructured\b/.test(source),
        "extractCommandsStructured",
      );
      ok(!source.includes("heredoc-data"), "heredoc-data");
    });
  }
});
