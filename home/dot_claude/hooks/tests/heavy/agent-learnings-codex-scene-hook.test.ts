import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  learning,
  makeWorld,
  removeWorld,
  type World,
} from "../support/agent-learnings-trigger-fixture.ts";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../implementations/codex-learnings-trigger.ts",
);
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../__fixtures__/codex-0.163.0-pretooluse.jsonl",
);
const worlds: World[] = [];
const world = (...args: Parameters<typeof makeWorld>) => {
  const w = makeWorld(...args);
  worlds.push(w);
  return w;
};
after(() => {
  for (const w of worlds) removeWorld(w);
});

// 実機の Bash の入力（1 行目）の command と cwd だけを置き換える
const codexBashInput = (w: World, command: string): Record<string, unknown> => {
  const first = readFileSync(FIXTURE, "utf8").split("\n")[0] ?? "";
  return {
    ...(JSON.parse(first) as Record<string, unknown>),
    tool_input: { command },
    cwd: w.repo,
  };
};

// 子プロセスの env は明示する。Claude / Codex を示す変数を引き継がない
function runCodexHook(w: World, stdin: string) {
  const env: Record<string, string> = { HOME: w.home };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  const result = spawnSync("bun", [HOOK], {
    input: stdin,
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("codex-learnings-trigger as a process", () => {
  it("prints additionalContext JSON and exits 0 for the observed codex input", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const r = runCodexHook(
      w,
      JSON.stringify(codexBashInput(w, "git commit -m x")),
    );
    strictEqual(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    ok(parsed.hookSpecificOutput.additionalContext.includes("title 1"));
  });

  it("prints nothing and exits 0 for broken JSON", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const r = runCodexHook(w, "{not json");
    strictEqual(r.status, 0);
    strictEqual(r.stdout, "");
  });

  it("prints nothing and exits 0 for stdin over 1MB", () => {
    const w = world([learning(1, "cmd:git commit")]);
    const big = {
      ...codexBashInput(w, "git commit -m x"),
      padding: "x".repeat(1100 * 1024),
    };
    const r = runCodexHook(w, JSON.stringify(big));
    strictEqual(r.status, 0);
    strictEqual(r.stdout, "");
  });
});
