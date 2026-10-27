#!/usr/bin/env node --test

import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CURSOR_EVENT_TO_CLAUDE,
  normalizeHookInput,
} from "../../lib/normalize-hook-input.ts";

const here = dirname(fileURLToPath(import.meta.url));
const adapter = join(here, "..", "..", "lib", "normalize-hook-input.ts");

describe("normalizeHookInput", () => {
  it("leaves Claude PreToolUse payloads untouched (same reference)", () => {
    const input = {
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      session_id: "s1",
      transcript_path: "/t",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "u1",
    };
    strictEqual(normalizeHookInput(input), input);
  });

  it("maps Cursor preToolUse + Shell into Claude shape", () => {
    const input = {
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command: "ls", working_directory: "/proj" },
      tool_use_id: "abc",
      model: "composer",
    };
    const out = normalizeHookInput(input, "/fallback") as Record<
      string,
      unknown
    >;
    notStrictEqual(out, input);
    deepStrictEqual(out, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls", working_directory: "/proj" },
      tool_use_id: "abc",
      model: "composer",
      cwd: "/proj",
      session_id: "cursor-unknown",
      transcript_path: "/dev/null",
    });
  });

  it("fills cwd from fallback when Cursor omits it", () => {
    const out = normalizeHookInput(
      {
        hook_event_name: "preToolUse",
        tool_name: "Read",
        tool_input: { path: "/x" },
        tool_use_id: "r1",
      },
      "/fallback-cwd",
    ) as Record<string, unknown>;
    strictEqual(out.cwd, "/fallback-cwd");
    strictEqual(out.hook_event_name, "PreToolUse");
  });

  it("maps every known Cursor event name", () => {
    for (const [cursor, claude] of Object.entries(CURSOR_EVENT_TO_CLAUDE)) {
      const out = normalizeHookInput(
        { hook_event_name: cursor },
        "/x",
      ) as Record<string, unknown>;
      strictEqual(out.hook_event_name, claude);
    }
  });

  it("CLI filter rewrites Cursor JSON and passes Claude JSON through", () => {
    const cursor = JSON.stringify({
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command: "true" },
      tool_use_id: "t",
    });
    const rewritten = spawnSync("bun", [adapter], {
      input: cursor,
      encoding: "utf8",
    });
    strictEqual(rewritten.status, 0, rewritten.stderr);
    const parsed = JSON.parse(rewritten.stdout);
    strictEqual(parsed.hook_event_name, "PreToolUse");
    strictEqual(parsed.tool_name, "Bash");
    strictEqual(typeof parsed.cwd, "string");

    const claude =
      '{"hook_event_name":"PreToolUse","cwd":"/r","session_id":"s","transcript_path":"/t","tool_name":"Bash","tool_input":{},"tool_use_id":"u"}';
    const passthrough = spawnSync("bun", [adapter], {
      input: claude,
      encoding: "utf8",
    });
    strictEqual(passthrough.status, 0, passthrough.stderr);
    strictEqual(passthrough.stdout, claude);
  });
});
