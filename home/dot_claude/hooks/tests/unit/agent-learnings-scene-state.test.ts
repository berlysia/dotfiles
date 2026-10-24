import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  appendCache,
  appendInjected,
  ensureSceneDir,
  gcSceneState,
  isValidAgentId,
  readCache,
  readInjected,
} from "../../lib/agent-learnings/core/scene-state.ts";
import { selectInjectable } from "../../lib/agent-learnings/core/select.ts";

const roots: string[] = [];
const tmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scene-state-")));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const mode = (path: string): number => lstatSync(path).mode & 0o777;
const stateIn = (root: string): string => {
  const dir = join(root, ".claude/state/agent-learnings");
  ok(ensureSceneDir(dir));
  return dir;
};
const id = (n: number): string => `L-${n.toString(16).padStart(12, "0")}`;
const line = (n: number, extra: object = {}): string =>
  `${JSON.stringify({ agent: "main", id: id(n), kind: "pre", bytes: 100, ...extra })}\n`;

describe("ensureSceneDir", () => {
  it("creates missing parents and the directory as 0700", () => {
    const root = tmp();
    const dir = stateIn(root);
    strictEqual(mode(dir), 0o700);
    strictEqual(mode(join(root, ".claude/state")), 0o700);
    strictEqual(mode(join(root, ".claude")), 0o700);
  });
  it("rejects an existing directory with a loose mode", () => {
    const root = tmp();
    const dir = join(root, "d");
    mkdirSync(dir, { mode: 0o755 });
    strictEqual(ensureSceneDir(dir), false);
    strictEqual(mode(dir), 0o755);
  });
  it("rejects a symlinked directory", () => {
    const root = tmp();
    mkdirSync(join(root, "real"), { mode: 0o700 });
    symlinkSync(join(root, "real"), join(root, "link"));
    strictEqual(ensureSceneDir(join(root, "link")), false);
  });
});

describe("readInjected / appendInjected", () => {
  it("reads valid lines and drops broken JSON and an unterminated last line", () => {
    const dir = stateIn(tmp());
    writeFileSync(
      join(dir, "s1.injected"),
      `${line(1)}not json\n${line(2)}${line(3).trimEnd()}`,
    );
    const got = readInjected(dir, "s1");
    ok(got);
    deepStrictEqual(
      got.records.map((r) => r.id),
      [id(1), id(2)],
    );
    strictEqual(got.totalCount, 2);
    strictEqual(got.totalBytes, 200);
  });
  it("counts unknown-shaped objects toward totals but not records", () => {
    const dir = stateIn(tmp());
    writeFileSync(
      join(dir, "s1.injected"),
      line(1, { kind: "zzz", bytes: 400 }),
    );
    const got = readInjected(dir, "s1");
    ok(got);
    strictEqual(got.records.length, 0);
    strictEqual(got.totalCount, 1);
    strictEqual(got.totalBytes, 400);
  });
  it("one unknown line plus 11 valid lines reaches the session cap", () => {
    const dir = stateIn(tmp());
    let text = line(100, { kind: "zzz" });
    for (let n = 1; n <= 11; n++) text += line(n);
    writeFileSync(join(dir, "s1.injected"), text);
    const got = readInjected(dir, "s1");
    ok(got);
    strictEqual(got.totalCount, 12);
    deepStrictEqual(
      selectInjectable({
        candidates: [
          {
            entry: {
              id: id(50),
              title: "t",
              body: "b",
              seen: 1,
              repos: [],
              updated: "2026-10-01",
              extra: [],
            },
            fileKey: "k",
            trigger: { kind: "session" },
          },
        ],
        injected: got,
        kind: "fail",
        agent: "main",
      }).selected,
      [],
    );
  });
  it("returns an empty state when the file does not exist", () => {
    const dir = stateIn(tmp());
    deepStrictEqual(readInjected(dir, "none"), {
      records: [],
      totalCount: 0,
      totalBytes: 0,
    });
  });
  it("appends one line with mode 0600", () => {
    const dir = stateIn(tmp());
    ok(
      appendInjected(dir, "s1", {
        agent: "main",
        id: id(1),
        kind: "pre",
        bytes: 5,
      }),
    );
    const path = join(dir, "s1.injected");
    strictEqual(mode(path), 0o600);
    strictEqual(
      readFileSync(path, "utf8"),
      `${JSON.stringify({ agent: "main", id: id(1), kind: "pre", bytes: 5 })}\n`,
    );
  });
  it("refuses a symlinked .injected for both read and write", () => {
    const root = tmp();
    const dir = stateIn(root);
    writeFileSync(join(root, "target"), line(1));
    symlinkSync(join(root, "target"), join(dir, "s1.injected"));
    strictEqual(readInjected(dir, "s1"), null);
    strictEqual(
      appendInjected(dir, "s1", {
        agent: "main",
        id: id(2),
        kind: "pre",
        bytes: 1,
      }),
      false,
    );
    strictEqual(readFileSync(join(root, "target"), "utf8"), line(1));
  });
  it("refuses an unsafe session id", () => {
    const dir = stateIn(tmp());
    strictEqual(readInjected(dir, "../x"), null);
    strictEqual(
      appendInjected(dir, "../x", {
        agent: "main",
        id: id(1),
        kind: "pre",
        bytes: 1,
      }),
      false,
    );
  });
  it("refuses a file over 64KB", () => {
    const dir = stateIn(tmp());
    writeFileSync(join(dir, "s1.injected"), "x".repeat(64 * 1024 + 1));
    strictEqual(readInjected(dir, "s1"), null);
  });
  it("returns null when the directory is loose", () => {
    const root = tmp();
    const dir = join(root, "d");
    mkdirSync(dir, { mode: 0o755 });
    strictEqual(readInjected(dir, "s1"), null);
  });
});

describe("readCache / appendCache", () => {
  const entry = {
    cwd: "/r/a",
    repoKey: "github.com/berlysia/foo",
    toplevel: "/r",
  };
  it("round-trips an entry", () => {
    const dir = stateIn(tmp());
    ok(appendCache(dir, "s1", entry));
    strictEqual(mode(join(dir, "s1.cache")), 0o600);
    deepStrictEqual(readCache(dir, "s1"), { entries: [entry], lineCount: 1 });
  });
  it("drops lines with an invalid repoKey, non-absolute paths or broken JSON", () => {
    const dir = stateIn(tmp());
    const bad = (o: object) => `${JSON.stringify({ ...entry, ...o })}\n`;
    writeFileSync(
      join(dir, "s1.cache"),
      [
        bad({ repoKey: "../../etc" }),
        bad({ toplevel: "r" }),
        bad({ cwd: "a" }),
        "nope\n",
        bad({}),
      ].join(""),
    );
    const got = readCache(dir, "s1");
    ok(got);
    deepStrictEqual(got.entries, [entry]);
  });
  it("refuses to append once there are 64 lines", () => {
    const dir = stateIn(tmp());
    writeFileSync(
      join(dir, "s1.cache"),
      `${JSON.stringify(entry)}\n`.repeat(64),
    );
    strictEqual(readCache(dir, "s1")?.lineCount, 64);
    strictEqual(appendCache(dir, "s1", { ...entry, cwd: "/r/b" }), false);
  });
  it("refuses a cwd with control characters", () => {
    const dir = stateIn(tmp());
    strictEqual(appendCache(dir, "s1", { ...entry, cwd: "/r/a\nb" }), false);
  });
  it("refuses a file over 64KB", () => {
    const dir = stateIn(tmp());
    writeFileSync(join(dir, "s1.cache"), "x".repeat(64 * 1024 + 1));
    strictEqual(readCache(dir, "s1"), null);
  });
});

describe("isValidAgentId", () => {
  it("accepts [A-Za-z0-9_-]{1,64} only", () => {
    strictEqual(isValidAgentId("a_b-1"), true);
    strictEqual(isValidAgentId("a".repeat(65)), false);
    strictEqual(isValidAgentId(""), false);
    strictEqual(isValidAgentId("a/b"), false);
  });
});

describe("gcSceneState", () => {
  it("removes state files older than 7 days, keeps newer ones and never follows symlinks", () => {
    const root = tmp();
    const dir = stateIn(root);
    const now = new Date("2026-10-22T00:00:00Z");
    const age = (name: string, days: number) => {
      const t = new Date(now.getTime() - days * 24 * 3600 * 1000);
      utimesSync(join(dir, name), t, t);
    };
    writeFileSync(join(dir, "old.injected"), "x");
    writeFileSync(join(dir, "new.injected"), "x");
    writeFileSync(join(dir, "old.cache"), "x");
    writeFileSync(join(dir, "other.txt"), "x");
    age("old.injected", 8);
    age("old.cache", 8);
    age("new.injected", 6);
    age("other.txt", 30);
    writeFileSync(join(root, "victim"), "x");
    utimesSync(join(root, "victim"), new Date(0), new Date(0));
    symlinkSync(join(root, "victim"), join(dir, "link.injected"));
    gcSceneState(dir, now);
    const exists = (name: string) => {
      try {
        lstatSync(join(dir, name));
        return true;
      } catch {
        return false;
      }
    };
    strictEqual(exists("old.injected"), false);
    strictEqual(exists("old.cache"), false);
    strictEqual(exists("new.injected"), true);
    strictEqual(exists("other.txt"), true);
    strictEqual(exists("link.injected"), true);
    strictEqual(statSync(join(root, "victim")).isFile(), true);
  });
  it("does nothing for a missing directory", () => {
    gcSceneState(join(tmp(), "nope"), new Date());
  });
});
