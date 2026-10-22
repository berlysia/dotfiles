import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  bashInput,
  learning,
  makeWorld,
  removeWorld,
  runHookProcess,
  type World,
} from "../support/agent-learnings-trigger-fixture.ts";

const worlds: World[] = [];
const world = (...args: Parameters<typeof makeWorld>) => {
  const w = makeWorld(...args);
  worlds.push(w);
  return w;
};
after(() => {
  for (const w of worlds) removeWorld(w);
});

describe("learnings-trigger as a process", () => {
  it("prints additionalContext JSON and exits 0 for a matching Bash command", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const r = runHookProcess(
      w,
      JSON.stringify(bashInput(w, "git commit -m x")),
    );
    strictEqual(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    deepStrictEqual(Object.keys(parsed), ["hookSpecificOutput"]);
    strictEqual(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    ok(parsed.hookSpecificOutput.additionalContext.includes("title 1"));
  });

  it("prints nothing and exits 0 for a command no learning matches", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const r = runHookProcess(w, JSON.stringify(bashInput(w, "ls")));
    strictEqual(r.status, 0);
    strictEqual(r.stdout, "");
  });

  it("prints nothing and exits 0 for broken JSON on stdin", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const r = runHookProcess(w, "{not json");
    strictEqual(r.status, 0);
    strictEqual(r.stdout, "");
  });

  it("prints nothing and exits 0 when the state directory is not usable", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const dir = join(w.home, ".claude/state/agent-learnings");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const r = runHookProcess(
      w,
      JSON.stringify(bashInput(w, "git commit -m x")),
    );
    strictEqual(r.status, 0);
    strictEqual(r.stdout, "");
  });

  it("prints nothing and exits 0 for stdin over 1MB", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const big = {
      ...bashInput(w, "git commit -m x"),
      padding: "x".repeat(1100 * 1024),
    };
    const r = runHookProcess(w, JSON.stringify(big));
    strictEqual(r.status, 0);
    strictEqual(r.stdout, "");
  });
});
