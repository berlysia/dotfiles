import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { LearningEntry } from "../../lib/agent-learnings/core/learnings-file.ts";
import {
  allowedInCommon,
  effectiveTriggers,
  filterByTrigger,
  formatTriggers,
  matchTriggers,
  parseTriggers,
  readOn,
  stripForCommon,
  type Trigger,
} from "../../lib/agent-learnings/core/triggers.ts";

const KEY = "github.com/berlysia/foo";
const entry = (n: number, on?: string): LearningEntry => ({
  id: `L-${n.toString(16).padStart(12, "0")}`,
  title: `title ${n}`,
  body: `body ${n}`,
  seen: 1,
  repos: [KEY],
  updated: "2026-10-01",
  extra: on === undefined ? [] : [["on", on]],
});
const human = (values: unknown[]) => parseTriggers(values, "human");
const worker = (values: unknown[]) => parseTriggers(values, "worker");
const errorOf = (r: ReturnType<typeof parseTriggers>) =>
  r.ok ? "ok" : r.error;
const trig = (s: string): Trigger => {
  const r = human([s]);
  ok(r.ok);
  return r.value[0] as Trigger;
};

describe("parseTriggers grammar", () => {
  it("accepts all four kinds", () => {
    const r = human([
      "session",
      "cmd:git commit",
      "path:mods/x/",
      "path:*.test.ts",
    ]);
    ok(r.ok);
    strictEqual(r.value.length, 4);
  });
  it("cmd: one word is human-only", () => {
    ok(human(["cmd:git"]).ok);
    strictEqual(errorOf(worker(["cmd:git"])), "worker-restricted");
  });
  it("rejects bad cmd words", () => {
    for (const v of [
      "cmd:Git",
      "cmd:git commit push",
      "cmd:",
      "cmd:" + "a".repeat(41),
    ])
      strictEqual(errorOf(human([v])), "bad-grammar", v);
    ok(human(["cmd:" + "a".repeat(40)]).ok);
  });
  it("rejects bad path prefixes", () => {
    for (const v of [
      "path:/etc",
      "path:./x",
      "path:a//b",
      "path:.",
      "path:a/../b",
      "path:a/b//",
      "path:" + "a".repeat(81),
      "path:*a*b",
      "path:",
    ])
      strictEqual(errorOf(human([v])), "bad-grammar", v);
    ok(human(["path:src/lib/"]).ok);
    ok(human(["path:src/lib"]).ok);
  });
  it("checks suffix length", () => {
    strictEqual(errorOf(human(["path:*.t"])), "bad-grammar");
    strictEqual(errorOf(human(["path:*." + "a".repeat(40)])), "bad-grammar");
    ok(human(["path:*.ts"]).ok);
  });
  it("rejects non-strings", () => {
    strictEqual(errorOf(human([1])), "bad-grammar");
    strictEqual(errorOf(human([null])), "bad-grammar");
  });
});

describe("parseTriggers worker restrictions", () => {
  it("restricts path prefixes", () => {
    strictEqual(errorOf(worker(["path:src/"])), "worker-restricted");
    ok(worker(["path:src/lib/"]).ok);
    for (const v of [
      "path:.github/workflows/",
      "path:.claude/x/",
      "path:.codex/x/",
      "path:.git/hooks/",
    ])
      strictEqual(errorOf(worker([v])), "worker-restricted", v);
  });
  it("restricts suffixes to two dots or more", () => {
    strictEqual(errorOf(worker(["path:*.ts"])), "worker-restricted");
    ok(worker(["path:*.test.ts"]).ok);
  });
  it("session and two-word cmd are allowed", () => {
    ok(worker(["session", "cmd:git commit"]).ok);
  });
});

describe("parseTriggers count and errors", () => {
  it("rejects 5, dedupes before counting", () => {
    strictEqual(
      errorOf(human(["session", "cmd:a", "cmd:b", "cmd:c", "cmd:d"])),
      "too-many",
    );
    const r = human(["session", "session"]);
    ok(r.ok);
    strictEqual(r.value.length, 1);
    const same = human(["path:src/lib", "path:src/lib/"]);
    ok(same.ok);
    strictEqual(same.value.length, 1);
  });
  it("never echoes the input", () => {
    for (const mode of ["human", "worker"] as const) {
      for (const v of ["\u001b[31mx", "x".repeat(1000), "cmd:\u0000"]) {
        const r = parseTriggers([v], mode);
        ok(!r.ok);
        ok(["bad-grammar", "too-many", "worker-restricted"].includes(r.error));
      }
    }
  });
  it("accepts an empty list", () => {
    const r = human([]);
    ok(r.ok);
    strictEqual(r.value.length, 0);
  });
});

describe("formatTriggers", () => {
  it("joins with commas and adds a trailing slash to prefixes", () => {
    const r = human([
      "session",
      "cmd:git commit",
      "path:mods/x",
      "path:*.test.ts",
    ]);
    ok(r.ok);
    strictEqual(
      formatTriggers(r.value),
      "session,cmd:git commit,path:mods/x/,path:*.test.ts",
    );
  });
});

describe("readOn", () => {
  it("distinguishes absent, invalid and valid", () => {
    strictEqual(readOn(entry(1)).state, "absent");
    strictEqual(readOn(entry(1, "<script>")).state, "invalid");
    strictEqual(readOn(entry(1, "")).state, "invalid");
    const dup: LearningEntry = {
      ...entry(1),
      extra: [
        ["on", "session"],
        ["on", "session"],
      ],
    };
    strictEqual(readOn(dup).state, "invalid");
    const v = readOn(entry(1, "cmd:git,session"));
    ok(v.state === "valid");
    strictEqual(v.triggers.length, 2);
  });
});

describe("matchTriggers", () => {
  it("returns the first matching trigger in written order", () => {
    const e = entry(1, "cmd:git,cmd:git commit");
    const hit = matchTriggers(e, KEY, {
      kind: "cmd",
      words: ["git", "commit"],
    });
    deepStrictEqual(hit, trig("cmd:git"));
  });
  it("compares words exactly", () => {
    const e = entry(1, "cmd:git commit");
    strictEqual(
      matchTriggers(e, KEY, { kind: "cmd", words: ["git", "push"] }),
      null,
    );
    strictEqual(matchTriggers(e, KEY, { kind: "cmd", words: ["git"] }), null);
  });
  it("matches paths on boundaries and suffixes", () => {
    const e = entry(1, "path:mods/x");
    ok(matchTriggers(e, KEY, { kind: "path", relPath: "mods/x/a.ts" }));
    ok(matchTriggers(e, KEY, { kind: "path", relPath: "mods/x" }));
    strictEqual(
      matchTriggers(e, KEY, { kind: "path", relPath: "mods/xy/a.ts" }),
      null,
    );
    const s = entry(2, "path:*.test.ts");
    ok(matchTriggers(s, KEY, { kind: "path", relPath: "a/b.test.ts" }));
  });
  it("does not cross cmd and path, and session never matches", () => {
    const e = entry(1, "session,cmd:git");
    strictEqual(matchTriggers(e, KEY, { kind: "path", relPath: "git" }), null);
    strictEqual(
      matchTriggers(entry(2, "session"), KEY, {
        kind: "cmd",
        words: ["session"],
      }),
      null,
    );
  });
  it("ignores invalid on", () => {
    strictEqual(
      matchTriggers(entry(1, "<script>"), KEY, { kind: "cmd", words: ["x"] }),
      null,
    );
  });
});

describe("effectiveTriggers", () => {
  it("is empty for invalid or absent on", () => {
    deepStrictEqual(effectiveTriggers(entry(1, "<script>"), KEY), []);
    deepStrictEqual(effectiveTriggers(entry(1), KEY), []);
  });
  it("strips path prefixes in common", () => {
    deepStrictEqual(effectiveTriggers(entry(1, "path:mods/x/"), "common"), []);
    deepStrictEqual(
      effectiveTriggers(entry(1, "path:mods/x/,cmd:git commit"), "common"),
      [trig("cmd:git commit")],
    );
    strictEqual(effectiveTriggers(entry(1, "path:mods/x/"), KEY).length, 1);
  });
});

describe("filterByTrigger", () => {
  const entries = [
    entry(1),
    entry(2, "session"),
    entry(3, "<script>"),
    entry(4, "cmd:git commit"),
    entry(5, "path:mods/x/"),
    entry(6, "cmd:git"),
  ];
  const ids = (list: readonly LearningEntry[]) => list.map((e) => e.id);
  it("session includes untagged, session and invalid; common prefix-only too", () => {
    deepStrictEqual(
      ids(filterByTrigger(entries, KEY, trig("session"))),
      [1, 2, 3].map((n) => entry(n).id),
    );
    deepStrictEqual(
      ids(
        filterByTrigger([entry(5, "path:mods/x/")], "common", trig("session")),
      ),
      [entry(5).id],
    );
  });
  it("other triggers use per-trigger equality", () => {
    deepStrictEqual(ids(filterByTrigger(entries, KEY, trig("cmd:git"))), [
      entry(6).id,
    ]);
    deepStrictEqual(
      ids(filterByTrigger(entries, KEY, trig("cmd:git commit"))),
      [entry(4).id],
    );
    deepStrictEqual(ids(filterByTrigger(entries, KEY, trig("path:mods/x"))), [
      entry(5).id,
    ]);
  });
});

describe("common helpers", () => {
  it("allowedInCommon / stripForCommon", () => {
    const r = human(["path:a/b/", "cmd:git", "path:*.test.ts"]);
    ok(r.ok);
    strictEqual(allowedInCommon(r.value), false);
    const stripped = stripForCommon(r.value);
    strictEqual(allowedInCommon(stripped), true);
    strictEqual(formatTriggers(stripped), "cmd:git,path:*.test.ts");
  });
});
