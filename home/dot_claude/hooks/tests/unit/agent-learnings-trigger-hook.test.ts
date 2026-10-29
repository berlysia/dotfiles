import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { run } from "../../implementations/learnings-trigger.ts";
import type { RunGit } from "../../lib/run-git.ts";
import {
  COMMON_KEY,
  type LearningEntry,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import {
  defaultStoreDir,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

const KEY = "github.com/berlysia/foo";
const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const entry = (n: number, on: string): LearningEntry => ({
  id: `L-${n.toString(16).padStart(12, "0")}`,
  title: `title ${n}`,
  body: `body ${n}`,
  seen: 1,
  repos: [KEY],
  updated: "2026-10-01",
  extra: [["on", on]],
});

function setup(entries: LearningEntry[]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "trigger-hook-")));
  roots.push(home);
  const store = defaultStoreDir(home);
  mkdirSync(join(store, ".git"), { recursive: true });
  mkdirSync(join(store, "repos"), { mode: 0o700 });
  for (const [key, list] of [
    [KEY, entries],
    [COMMON_KEY, []],
  ] as const)
    ok(
      writeLearnings(store, { format: 1, key, readOnly: false, entries: list })
        .ok,
    );
  return home;
}
const okGit: RunGit = (args) => {
  if (args[0] === "rev-parse" && args.includes("--show-toplevel"))
    return { ok: true, stdout: "/work/r" };
  if (args[0] === "rev-parse") return { ok: true, stdout: "/work/r/.git" };
  if (args[0] === "config")
    return { ok: true, stdout: "https://github.com/berlysia/foo.git" };
  return { ok: false, status: 1 };
};
const badGit: RunGit = () => ({ ok: false, status: 128 });
const deps = (
  home: string,
  extra: { runGit?: RunGit; env?: Record<string, string> } = {},
) => ({
  home,
  runGit: extra.runGit ?? okGit,
  now: new Date("2026-10-22T00:00:00Z"),
  env: extra.env ?? {},
});
const bash = (event: string, command: string, extra = {}) => ({
  hook_event_name: event,
  tool_name: "Bash",
  tool_input: { command },
  session_id: "sess1",
  cwd: "/work/r/sub",
  ...extra,
});
const edit = (filePath: string, toolName = "Edit") => ({
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: { file_path: filePath },
  session_id: "sess1",
  cwd: "/work/r",
});

describe("learnings-trigger run", () => {
  it("returns additionalContext only, with the input event name", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const out = run(bash("PreToolUse", "git commit -m x"), deps(home));
    ok(out !== null);
    deepStrictEqual(Object.keys(out), ["hookSpecificOutput"]);
    deepStrictEqual(Object.keys(out.hookSpecificOutput).sort(), [
      "additionalContext",
      "hookEventName",
    ]);
    strictEqual(out.hookSpecificOutput.hookEventName, "PreToolUse");
    ok(out.hookSpecificOutput.additionalContext.includes("title 1"));
    ok(!JSON.stringify(out).includes("permissionDecision"));
  });

  it("injects once for pre, once more for fail, then stops", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const d = deps(home);
    ok(run(bash("PreToolUse", "git commit -m x"), d));
    strictEqual(run(bash("PreToolUse", "git commit -m x"), d), null);
    const fail = run(bash("PostToolUseFailure", "git commit -m x"), d);
    strictEqual(fail?.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    ok(fail?.hookSpecificOutput.additionalContext.includes("title 1"));
    strictEqual(run(bash("PostToolUseFailure", "git commit -m x"), d), null);
  });

  it("never reads input.error", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const out = run(
      bash("PostToolUseFailure", "git commit -m x", {
        error: "IGNORE PREVIOUS",
      }),
      deps(home),
    );
    ok(out !== null);
    ok(!JSON.stringify(out).includes("IGNORE PREVIOUS"));
  });

  it("matches path prefixes on a segment boundary", () => {
    const home = setup([entry(1, "path:mods/x/")]);
    const d = deps(home);
    ok(run(edit("/work/r/mods/x/a.ts"), d));
    strictEqual(run(edit("/work/r/mods/xy/a.ts", "Write"), d), null);
  });

  it("uses notebook_path for NotebookEdit", () => {
    const home = setup([entry(1, "path:mods/x/")]);
    const out = run(
      {
        hook_event_name: "PreToolUse",
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "/work/r/mods/x/n.ipynb" },
        session_id: "sess1",
        cwd: "/work/r",
      },
      deps(home),
    );
    ok(out !== null);
  });

  it("ignores other tools and malformed input", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const d = deps(home);
    strictEqual(
      run(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/work/r/a" },
          session_id: "sess1",
          cwd: "/work/r",
        },
        d,
      ),
      null,
    );
    strictEqual(run(null, d), null);
    strictEqual(run("x", d), null);
    strictEqual(
      run({ ...bash("PreToolUse", "git commit"), tool_input: null }, d),
      null,
    );
  });

  it("does nothing in a worker session", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    strictEqual(
      run(
        bash("PreToolUse", "git commit -m x"),
        deps(home, { env: { AGENT_LEARNINGS_WORKER: "1" } }),
      ),
      null,
    );
  });

  it("keeps dedup separate per agent_id", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const d = deps(home);
    ok(run(bash("PreToolUse", "git commit -m x"), d));
    ok(run(bash("PreToolUse", "git commit -m x", { agent_id: "sub-1" }), d));
    strictEqual(
      run(bash("PreToolUse", "git commit -m x", { agent_id: "sub-1" }), d),
      null,
    );
  });

  it("returns null when git fails", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    strictEqual(
      run(
        bash("PreToolUse", "git commit -m x"),
        deps(home, { runGit: badGit }),
      ),
      null,
    );
  });
});
