import { ok, strictEqual } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunGit } from "../../lib/agent-learnings/core/git.ts";
import {
  COMMON_KEY,
  type LearningEntry,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import { parseInjectionLines } from "../../lib/agent-learnings/core/metrics.ts";
import {
  injectScene,
  type InjectSceneInput,
} from "../../lib/agent-learnings/core/scene-inject.ts";
import { cmdSituations } from "../../lib/agent-learnings/core/scene.ts";
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "scene-inject-")));
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
  return { home, store };
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

function input(
  home: string,
  store: string,
  over: Partial<InjectSceneInput> = {},
): InjectSceneInput {
  return {
    stateDir: sceneStateDir(home, "codex"),
    store,
    cwd: join(home, "projects/r"),
    sessionId: "sess1",
    agent: "main",
    reader: "codex",
    kind: "pre",
    situations: () => cmdSituations("git commit -m x"),
    hint: "hint line",
    runGit: fakeGit,
    now: new Date("2026-10-22T00:00:00Z"),
    protectedPaths: [],
    ...over,
  };
}

describe("injectScene", () => {
  it("injects for codex, writes state only under the given stateDir, and records reader codex", () => {
    const { home, store } = setup([entry(1, "cmd:git commit")]);
    mkdirSync(join(home, "projects/r"), { recursive: true });
    const text = injectScene(input(home, store));
    ok(text?.includes("title 1"));
    ok(text?.endsWith("hint line"));
    const stateDir = sceneStateDir(home, "codex");
    ok(existsSync(join(stateDir, "sess1.injected")));
    ok(!existsSync(join(home, ".claude")));
    const lines = parseInjectionLines(
      readFileSync(storePaths(store).injectionsLog, "utf8"),
    ).lines;
    strictEqual(lines.length, 1);
    strictEqual(lines[0]?.reader, "codex");
    strictEqual(lines[0]?.kind, "pre");
    // 同じ入力の 2 回目は重複抑止で何も出ない
    strictEqual(injectScene(input(home, store)), null);
  });

  it("accepts a UUIDv7-shaped session id", () => {
    const { home, store } = setup([entry(1, "cmd:git commit")]);
    mkdirSync(join(home, "projects/r"), { recursive: true });
    ok(
      injectScene(
        input(home, store, {
          sessionId: "01a16273-26c8-76f1-9229-5417cafa289a",
        }),
      ),
    );
  });

  describe("protectedPaths", () => {
    const protectedOf = (home: string, store: string) => [
      sceneStateDir(home, "codex"),
      store,
    ];
    const run = (home: string, store: string, cwd: string) =>
      injectScene(
        input(home, store, { cwd, protectedPaths: protectedOf(home, store) }),
      );

    it("injects normally for an unrelated cwd (positive control)", () => {
      const { home, store } = setup([entry(1, "cmd:git commit")]);
      const cwd = join(home, "projects/r");
      mkdirSync(cwd, { recursive: true });
      ok(run(home, store, cwd));
    });

    it("does nothing when cwd is, contains, or is inside a protected path", () => {
      const cases: Array<(home: string, store: string) => string> = [
        (home) => home,
        (home) => join(home, ".local/share"),
        (_home, store) => store,
        (_home, store) => join(store, "sub"),
        (_home, store) => join(store, ".state"),
        (home) => join(home, ".codex/state/agent-learnings/x"),
      ];
      for (const pick of cases) {
        const { home, store } = setup([entry(1, "cmd:git commit")]);
        const cwd = pick(home, store);
        mkdirSync(cwd, { recursive: true });
        strictEqual(run(home, store, cwd), null, cwd);
      }
    });

    it("does nothing when cwd is a symlink to a protected path", () => {
      const { home, store } = setup([entry(1, "cmd:git commit")]);
      const link = join(home, "link");
      symlinkSync(home, link);
      strictEqual(run(home, store, link), null);
    });

    it("does nothing when a not-yet-existing stateDir would be under cwd", () => {
      const { home, store } = setup([entry(1, "cmd:git commit")]);
      const cwd = join(home, ".codex");
      mkdirSync(cwd, { recursive: true });
      strictEqual(run(home, store, cwd), null);
    });

    it("injects when the stateDir does not exist yet and cwd is a sibling under its parent", () => {
      const { home, store } = setup([entry(1, "cmd:git commit")]);
      const cwd = join(home, ".codex/other");
      mkdirSync(cwd, { recursive: true });
      ok(run(home, store, cwd));
    });

    it("does not check overlap when protectedPaths is empty (cwd = home)", () => {
      const { home, store } = setup([entry(1, "cmd:git commit")]);
      ok(injectScene(input(home, store, { cwd: home })));
    });
  });
});

describe("core does not depend on claude/ or codex/", () => {
  it("has no import of ../claude/ or ../codex/ in core files", () => {
    const coreDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../lib/agent-learnings/core",
    );
    const offenders: string[] = [];
    for (const name of readdirSync(coreDir)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(join(coreDir, name), "utf8");
      const specifiers = [
        ...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
      ].map((m) => m[1] ?? "");
      for (const s of specifiers)
        if (/(^|\/)(claude|codex)\//.test(s)) offenders.push(`${name}: ${s}`);
    }
    strictEqual(offenders.join("\n"), "");
  });
});
