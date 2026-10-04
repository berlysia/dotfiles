#!/usr/bin/env node --test

import { ok } from "node:assert";
import { describe, it } from "node:test";

// The shared lib/ modules are imported by several hooks; a broken one would
// stop all of them at once. Importing each entry point resolves its whole
// module graph without running the hook (they run only under import.meta.main).
const ENTRY_POINTS = [
  "../../implementations/file-access-guard.ts",
  "../../implementations/permission-auto-approve.ts",
  "../../implementations/document-workflow-guard.ts",
  "../../implementations/auto-approve.ts",
];

describe("hook entry points load", () => {
  for (const entry of ENTRY_POINTS) {
    it(`imports ${entry}`, async () => {
      const mod = await import(entry);
      ok(mod.default, `${entry} has a default export`);
    });
  }
});
