import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../../lib/agent-learnings/codex/scene-hook.ts";
import type { RunGit } from "../../lib/run-git.ts";
import {
  COMMON_KEY,
  type LearningEntry,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import { parseInjectionLines } from "../../lib/agent-learnings/core/metrics.ts";
import {
  defaultStoreDir,
  ensureStateDirs,
  storePaths,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

const KEY = "github.com/berlysia/foo";
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../__fixtures__/codex-0.163.0-pretooluse.jsonl",
);
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-scene-")));
  roots.push(home);
  const store = defaultStoreDir(home);
  mkdirSync(join(store, ".git"), { recursive: true });
  mkdirSync(join(store, "repos"), { mode: 0o700 });
  ensureStateDirs(store);
  ok(
    writeLearnings(store, { format: 1, key: KEY, readOnly: false, entries }).ok,
  );
  ok(
    writeLearnings(store, {
      format: 1,
      key: COMMON_KEY,
      readOnly: false,
      entries: [],
    }).ok,
  );
  const repo = join(home, "projects/r");
  mkdirSync(repo, { recursive: true });
  return { home, store, repo };
}

// toplevel は cwd 自身。実 git は使わない
const fakeGit: RunGit = (args, cwd) => {
  if (args[0] === "rev-parse" && args.includes("--show-toplevel"))
    return { ok: true, stdout: cwd };
  if (args[0] === "rev-parse") return { ok: true, stdout: `${cwd}/.git` };
  if (args[0] === "config")
    return { ok: true, stdout: "https://github.com/berlysia/foo.git" };
  return { ok: false, status: 1 };
};
const deps = (home: string) => ({
  home,
  runGit: fakeGit,
  now: new Date("2026-10-22T00:00:00Z"),
});

const fixtureLines = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const bashFixture = fixtureLines.find((l) => l.tool_name === "Bash") ?? {};

const bash = (cwd: string, command: unknown, over: object = {}) => ({
  ...bashFixture,
  cwd,
  tool_input: { command },
  ...over,
});
const patch = (cwd: string, command: string) => ({
  ...bashFixture,
  tool_name: "apply_patch",
  cwd,
  tool_input: { command },
});
const context = (out: ReturnType<typeof run>) =>
  out?.hookSpecificOutput.additionalContext;

describe("codex scene-hook run", () => {
  it("injects for the observed codex input shape, records kind pre / reader codex, and dedups", () => {
    const { home, store, repo } = setup([entry(1, "cmd:git commit")]);
    const input = bash(repo, "git commit -m x");
    const out = run(input, deps(home));
    strictEqual(out?.hookSpecificOutput.hookEventName, "PreToolUse");
    ok(context(out)?.includes("title 1"));
    ok(context(out)?.includes("--at=pre"));
    ok(!JSON.stringify(out).includes("permissionDecision"));
    const { lines } = parseInjectionLines(
      readFileSync(storePaths(store).injectionsLog, "utf8"),
    );
    strictEqual(lines.length, 1);
    strictEqual(lines[0]?.kind, "pre");
    strictEqual(lines[0]?.reader, "codex");
    strictEqual(run(input, deps(home)), null);
  });
  it("injects for apply_patch by the patch's target path", () => {
    const { home, store, repo } = setup([entry(1, "path:mods/x/")]);
    const out = run(
      patch(repo, `*** Update File: ${repo}/mods/x/a.ts\n@@\n-a\n+b`),
      deps(home),
    );
    ok(context(out)?.includes("title 1"));
    ok(context(out)?.includes("--at=path"));
    const { lines } = parseInjectionLines(
      readFileSync(storePaths(store).injectionsLog, "utf8"),
    );
    strictEqual(lines[0]?.kind, "path");
  });
  it("reads a patch header with trailing whitespace as the path without it (accepted limit)", () => {
    // 末尾が空白のファイル名はそのとおりには追跡されない。見出しの規則は patch-paths.ts の 1 か所
    const { home, repo } = setup([entry(1, "path:mods/x/a.ts")]);
    const out = run(
      patch(repo, `*** Update File: ${repo}/mods/x/a.ts \n@@\n-a\n+b`),
      deps(home),
    );
    ok(context(out)?.includes("title 1"));
  });
  it("does not let paths outside the toplevel eat the 16-path cap", () => {
    const { home, repo } = setup([entry(1, "path:mods/x/")]);
    const outside = Array.from(
      { length: 20 },
      (_, i) => `*** Update File: /elsewhere/f${i}.ts`,
    );
    const text = [
      "*** Update File: ../../etc/x",
      ...outside,
      `*** Update File: ${repo}/mods/x/a.ts`,
    ].join("\n");
    ok(context(run(patch(repo, text), deps(home)))?.includes("title 1"));
  });
  it("caps one injection at 3 learnings", () => {
    const { home, repo } = setup(
      [1, 2, 3, 4, 5].map((n) => entry(n, "path:mods/")),
    );
    const text = Array.from(
      { length: 16 },
      (_, i) => `*** Update File: ${repo}/mods/f${i}.ts`,
    ).join("\n");
    const out = context(run(patch(repo, text), deps(home))) ?? "";
    strictEqual(out.match(/title \d/g)?.length, 3);
  });
  it("returns nothing for other events, tools, and malformed commands", () => {
    const { home, repo } = setup([entry(1, "cmd:git commit")]);
    const d = deps(home);
    const cmd = "git commit -m x";
    strictEqual(
      run(bash(repo, cmd, { hook_event_name: "PostToolUse" }), d),
      null,
    );
    strictEqual(run(bash(repo, cmd, { tool_name: "Read" }), d), null);
    strictEqual(run(bash(repo, 123), d), null);
    strictEqual(run({ ...bash(repo, cmd), tool_input: {} }, d), null);
    strictEqual(
      run(bash(repo, `git commit ${"x".repeat(64 * 1024)}`), d),
      null,
    );
    strictEqual(run("nope", d), null);
  });
  it("rejects bad session ids and accepts a UUIDv7 shape", () => {
    const { home, repo } = setup([entry(1, "cmd:git commit")]);
    const d = deps(home);
    const cmd = "git commit -m x";
    strictEqual(run(bash(repo, cmd, { session_id: "../x" }), d), null);
    strictEqual(run(bash(repo, cmd, { session_id: "a".repeat(129) }), d), null);
    ok(
      run(
        bash(repo, cmd, {
          session_id: "01a16273-26c8-76f1-9229-5417cafa289a",
        }),
        d,
      ),
    );
  });
  it("refuses when cwd is home and writes no state", () => {
    const { home } = setup([entry(1, "cmd:git commit")]);
    strictEqual(run(bash(home, "git commit -m x"), deps(home)), null);
    strictEqual(existsSync(join(home, ".codex/state")), false);
  });
  it("writes state only under ~/.codex", () => {
    const { home, repo } = setup([entry(1, "cmd:git commit")]);
    ok(run(bash(repo, "git commit -m x"), deps(home)));
    ok(
      existsSync(
        join(
          home,
          ".codex/state/agent-learnings",
          `${String(bashFixture.session_id)}.injected`,
        ),
      ),
    );
    strictEqual(existsSync(join(home, ".claude/state")), false);
  });
  it("is quiet when nothing matches", () => {
    const { home, repo } = setup([entry(1, "cmd:git commit")]);
    deepStrictEqual(run(bash(repo, "ls"), deps(home)), null);
  });
});
