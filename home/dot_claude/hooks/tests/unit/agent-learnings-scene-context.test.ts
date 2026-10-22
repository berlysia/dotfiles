import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSceneContext } from "../../lib/agent-learnings/claude/scene-context.ts";
import type { RunGit } from "../../lib/agent-learnings/core/git.ts";
import {
  COMMON_KEY,
  type LearningEntry,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import { parseInjectionLines } from "../../lib/agent-learnings/core/metrics.ts";
import { sceneStateDir } from "../../lib/agent-learnings/core/scene-state.ts";
import {
  defaultStoreDir,
  ensureStateDirs,
  storePaths,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

const KEY = "github.com/berlysia/foo";
const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const entry = (n: number, on: string, body = `body ${n}`): LearningEntry => ({
  id: `L-${n.toString(16).padStart(12, "0")}`,
  title: `title ${n}`,
  body,
  seen: 1,
  repos: [KEY],
  updated: "2026-10-01",
  extra: [["on", on]],
});

function setup(entries: LearningEntry[], common: LearningEntry[] = []) {
  const home = mkdtempSync(join(tmpdir(), "scene-context-"));
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
      entries: common,
    }).ok,
  );
  return home;
}
const gitCalls: string[][] = [];
const okGit: RunGit = (args) => {
  gitCalls.push([...args]);
  if (args[0] === "rev-parse" && args.includes("--show-toplevel"))
    return { ok: true, stdout: "/work/r" };
  if (args[0] === "rev-parse") return { ok: true, stdout: "/work/r/.git" };
  if (args[0] === "config")
    return { ok: true, stdout: "https://github.com/berlysia/foo.git" };
  return { ok: false, status: 1 };
};
const base = (home: string) => ({
  home,
  cwd: "/work/r/sub",
  sessionId: "sess1",
  runGit: okGit,
  now: new Date("2026-10-22T00:00:00Z"),
  env: {},
});

describe("buildSceneContext", () => {
  it("injects a matching learning once for pre, again for fail, not a third time", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const pre = {
      ...base(home),
      kind: "pre" as const,
      command: "git commit -m x",
    };
    ok(buildSceneContext(pre)?.includes("title 1"));
    strictEqual(buildSceneContext(pre), null);
    const fail = { ...pre, kind: "fail" as const };
    ok(buildSceneContext(fail)?.includes("title 1"));
    strictEqual(buildSceneContext(fail), null);
  });
  it("keeps the dedup separate per agent", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const input = {
      ...base(home),
      kind: "pre" as const,
      command: "git commit",
    };
    ok(buildSceneContext(input));
    strictEqual(buildSceneContext(input), null);
    ok(buildSceneContext({ ...input, agentId: "sub-1" }));
  });
  it("matches path triggers by prefix on the toplevel-relative path", () => {
    const home = setup([entry(1, "path:mods/x/")]);
    const input = { ...base(home), kind: "path" as const };
    ok(buildSceneContext({ ...input, filePath: "/work/r/mods/x/a.ts" }));
    const home2 = setup([entry(1, "path:mods/x/")]);
    strictEqual(
      buildSceneContext({
        ...base(home2),
        kind: "path",
        filePath: "/work/r/mods/xy/a.ts",
      }),
      null,
    );
  });
  it("resolves git once per cwd per session", () => {
    const home = setup([entry(1, "cmd:git commit"), entry(2, "cmd:git push")]);
    gitCalls.length = 0;
    buildSceneContext({ ...base(home), kind: "pre", command: "git commit" });
    const first = gitCalls.length;
    ok(first > 0);
    buildSceneContext({ ...base(home), kind: "pre", command: "git push" });
    strictEqual(gitCalls.length, first);
    ok(
      gitCalls.every((args) => args[0] === "rev-parse" || args[0] === "config"),
    );
  });
  it("returns null for worker sessions, bad ids, no store and git failure", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const input = {
      ...base(home),
      kind: "pre" as const,
      command: "git commit",
    };
    strictEqual(
      buildSceneContext({ ...input, env: { AGENT_LEARNINGS_WORKER: "1" } }),
      null,
    );
    strictEqual(buildSceneContext({ ...input, sessionId: "../x" }), null);
    strictEqual(buildSceneContext({ ...input, agentId: "a/b" }), null);
    strictEqual(
      buildSceneContext({
        ...input,
        home: mkdtempSync(join(tmpdir(), "empty-")),
      }),
      null,
    );
    strictEqual(
      buildSceneContext({
        ...input,
        sessionId: "other",
        runGit: () => ({ ok: false, status: 1 }),
      }),
      null,
    );
  });
  it("does not inject entries with a URL", () => {
    const home = setup([entry(1, "cmd:git commit", "see https://example.com")]);
    strictEqual(
      buildSceneContext({ ...base(home), kind: "pre", command: "git commit" }),
      null,
    );
  });
  it("records bytes that add up to the injected text", () => {
    const home = setup([
      entry(1, "cmd:git commit"),
      entry(2, "cmd:git commit"),
    ]);
    const text = buildSceneContext({
      ...base(home),
      kind: "pre",
      command: "git commit",
    });
    ok(text);
    const lines = readFileSync(
      join(sceneStateDir(home, "claude"), "sess1.injected"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { bytes: number });
    deepStrictEqual(
      lines.reduce((s, l) => s + l.bytes, 0),
      Buffer.byteLength(text),
    );
  });
});

describe("buildSceneContext injection records", () => {
  const injectionsOf = (home: string) =>
    parseInjectionLines(
      readFileSync(storePaths(defaultStoreDir(home)).injectionsLog, "utf8"),
    ).lines;
  it("ends the text with the feedback hint for the kind", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const text = buildSceneContext({
      ...base(home),
      kind: "pre",
      command: "git commit",
    });
    ok(text?.split("\n").at(-1)?.includes("--at=pre"));
  });
  it("writes reader claude on the record line", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    ok(
      buildSceneContext({
        ...base(home),
        kind: "pre",
        command: "git commit",
      }),
    );
    strictEqual(injectionsOf(home)[0]?.reader, "claude");
  });
  it("records one line per injected learning with the matched trigger, and none for a suppressed repeat", () => {
    const home = setup([entry(1, "cmd:git commit"), entry(2, "cmd:git")]);
    const input = {
      ...base(home),
      kind: "pre" as const,
      command: "git commit -m x",
    };
    ok(buildSceneContext(input));
    const lines = injectionsOf(home);
    strictEqual(lines.length, 2);
    deepStrictEqual(
      lines.map((l) => [l.id, l.kind, l.trigger, l.repoKey]).sort(),
      [
        ["L-000000000001", "pre", "cmd:git commit", KEY],
        ["L-000000000002", "pre", "cmd:git", KEY],
      ],
    );
    strictEqual(buildSceneContext(input), null);
    strictEqual(injectionsOf(home).length, 2);
  });
  it("still returns the text when injections.log is a symlink", () => {
    const home = setup([entry(1, "cmd:git commit")]);
    const paths = storePaths(defaultStoreDir(home));
    mkdirSync(paths.state, { recursive: true });
    const target = join(home, "target.log");
    symlinkSync(target, paths.injectionsLog);
    ok(
      buildSceneContext({ ...base(home), kind: "pre", command: "git commit" }),
    );
    strictEqual(existsSync(target), false);
  });
  it(
    "returns the text and keeps .injected when .state is read-only",
    { skip: process.getuid?.() === 0 },
    () => {
      const home = setup([entry(1, "cmd:git commit")]);
      const paths = storePaths(defaultStoreDir(home));
      mkdirSync(paths.state, { recursive: true });
      chmodSync(paths.state, 0o500);
      try {
        const input = {
          ...base(home),
          kind: "pre" as const,
          command: "git commit",
        };
        ok(buildSceneContext(input)?.includes("title 1"));
        ok(
          readFileSync(
            join(sceneStateDir(home, "claude"), "sess1.injected"),
            "utf8",
          ).includes("L-000000000001"),
        );
        strictEqual(buildSceneContext(input), null);
      } finally {
        chmodSync(paths.state, 0o700);
      }
    },
  );
});
