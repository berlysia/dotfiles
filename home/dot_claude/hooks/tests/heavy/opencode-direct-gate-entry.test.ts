#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Starts the hook as a process, so the entrypoint wiring (import.meta.main,
// runHook) is exercised, not only the exported functions.
const ENTRY = join(
  import.meta.dirname,
  "..",
  "..",
  "implementations",
  "opencode-direct-gate.ts",
);
const home = realpathSync(mkdtempSync(join(tmpdir(), "opencode-gate-entry-")));
after(() => rmSync(home, { recursive: true, force: true }));

function decisionFor(command: string): string | undefined {
  const result = spawnSync("bun", [ENTRY], {
    input: JSON.stringify({
      session_id: "opencode-gate-entry",
      transcript_path: "/t.jsonl",
      cwd: home,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "tu1",
    }),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 20_000,
  });
  const out = result.stdout.trim();
  if (out === "") return undefined;
  return JSON.parse(out).hookSpecificOutput?.permissionDecision;
}

describe("opencode-direct-gate entry", () => {
  it("denies opencode run x", () => {
    strictEqual(decisionFor("opencode run x"), "deny");
  });

  it("does not deny ls", () => {
    strictEqual(decisionFor("ls") === "deny", false);
  });
});
