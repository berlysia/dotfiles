import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type {
  LearningEntry,
  LearningsFile,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import {
  applyRetag,
  countRetagLines,
  parseRetagFile,
  planRetag,
  retagEntry,
  type RetagExpect,
  type RetagOp,
} from "../../lib/agent-learnings/core/retag.ts";
import {
  parseTriggers,
  type ValidatedTriggers,
} from "../../lib/agent-learnings/core/triggers.ts";

const KEY = "github.com/berlysia/foo";
const id = (n: number): string => `L-${n.toString(16).padStart(12, "0")}`;
const entry = (n: number, on?: string): LearningEntry => ({
  id: id(n),
  title: `title ${n}`,
  body: `body ${n}`,
  seen: 3,
  repos: [KEY],
  updated: "2026-10-01",
  extra: on === undefined ? [] : [["on", on]],
});
const file = (key: string, entries: LearningEntry[]): LearningsFile => ({
  format: 1,
  key,
  readOnly: false,
  entries,
});
const trigs = (...values: string[]): ValidatedTriggers => {
  const r = parseTriggers(values);
  ok(r.ok);
  return r.value;
};
const op = (n: number, ...values: string[]): RetagOp => ({
  id: id(n),
  on: trigs(...values),
});
const expectsOf = (r: ReturnType<typeof planRetag>): RetagExpect[] => {
  ok(r.ok);
  return r.planned.map((p) => p.expect);
};

describe("retagEntry", () => {
  it("keeps seen and updated and writes retag / untag lines", () => {
    const a = retagEntry(
      entry(1, "cmd:git commit"),
      trigs("cmd:git push"),
      "ev",
    );
    strictEqual(a.entry.seen, 3);
    strictEqual(a.entry.updated, "2026-10-01");
    strictEqual(a.line, `retag ${id(1)}: cmd:git commit -> cmd:git push (ev)`);
    const b = retagEntry(entry(1, "cmd:git commit"), trigs());
    strictEqual(b.line, `untag ${id(1)}: cmd:git commit`);
    deepStrictEqual(b.entry.extra, []);
  });
  it("reports an invalid current value as invalid and none for absent", () => {
    strictEqual(
      retagEntry(entry(1, "<x>"), trigs("session")).line,
      `retag ${id(1)}: invalid -> session`,
    );
    strictEqual(
      retagEntry(entry(1), trigs("session")).line,
      `retag ${id(1)}: none -> session`,
    );
    strictEqual(retagEntry(entry(1), trigs()).line, null);
  });
  it("keeps other extra keys and replaces on in place", () => {
    const e: LearningEntry = {
      ...entry(1),
      extra: [
        ["a", "1"],
        ["on", "session"],
        ["b", "2"],
      ],
    };
    deepStrictEqual(retagEntry(e, trigs("cmd:git commit")).entry.extra, [
      ["a", "1"],
      ["on", "cmd:git commit"],
      ["b", "2"],
    ]);
  });
});

describe("parseRetagFile", () => {
  it("parses entries and drops the empty on", () => {
    const r = parseRetagFile(`${id(1)}\tcmd:git commit\n\n${id(2)}\t\n`);
    ok(r.ok);
    strictEqual(r.ops.length, 2);
    strictEqual(r.ops[1]?.on.length, 0);
  });
  it("reports the line number without the content", () => {
    const r = parseRetagFile(`${id(1)}\tsession\n\n${id(2)}\tcmd:\n`);
    deepStrictEqual(r, { ok: false, line: 3, error: "bad-grammar" });
    ok(!JSON.stringify(r).includes("cmd:"));
  });
  it("rejects a duplicate id at its second line", () => {
    const r = parseRetagFile(`${id(1)}\tsession\n${id(1)}\tsession\n`);
    ok(!r.ok && "line" in r);
    strictEqual(r.line, 2);
  });
  it("accepts the broad forms for every caller", () => {
    const r = parseRetagFile(
      `${id(1)}\tcmd:git\n${id(2)}\tpath:.claude/settings.json,path:*.ts\n`,
    );
    ok(r.ok);
  });
  it("rejects malformed lines", () => {
    for (const text of [
      `${id(1)} session\n`,
      `x\tsession\n`,
      `${id(1)}\ta\tb\n`,
    ])
      ok(!parseRetagFile(text).ok, text);
  });
  it("rejects more than 200 lines", () => {
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `${id(i)}\tsession`).join("\n");
    ok(parseRetagFile(lines(200)).ok);
    deepStrictEqual(parseRetagFile(lines(201)), {
      ok: false,
      error: "too-many-lines",
    });
  });
});

describe("planRetag", () => {
  const repo = file(KEY, [entry(1, "<bad>"), entry(2, "cmd:git commit")]);
  const common = file("common", [entry(9)]);
  it("plans current values and flags an invalid one", () => {
    const r = planRetag({ repo, common }, [op(1, "session"), op(2)]);
    ok(r.ok);
    strictEqual(r.planned[0]?.currentOn, "invalid");
    strictEqual(r.planned[1]?.currentOn, "cmd:git commit");
    strictEqual(r.planned[0]?.fileKey, KEY);
  });
  it("finds common ids for every caller", () => {
    const r = planRetag({ repo, common }, [op(9, "session")]);
    ok(r.ok);
    strictEqual(r.planned[0]?.fileKey, "common");
  });
  it("plans a broad trigger on a common id", () => {
    const r = planRetag({ repo, common }, [op(9, "cmd:gh pr")]);
    ok(r.ok);
    strictEqual(r.planned[0]?.fileKey, "common");
    strictEqual(r.planned[0]?.nextOn.length, 1);
  });
  it("reports missing ids", () => {
    deepStrictEqual(planRetag({ repo, common }, [op(7, "session")]), {
      ok: false,
      error: "missing",
      count: 1,
    });
  });
  it("flags a title that fails validation", () => {
    const bad = file(KEY, [{ ...entry(1), title: "#bad" }]);
    const r = planRetag({ repo: bad, common: null }, [op(1)]);
    ok(r.ok);
    strictEqual(r.planned[0]?.title, "invalid");
  });
});

describe("applyRetag", () => {
  const repo = file(KEY, [entry(1, "cmd:git commit"), entry(2)]);
  it("writes on and leaves seen and updated", () => {
    const r = applyRetag(repo, [op(1, "cmd:git push")]);
    ok(r.ok);
    const e = r.file.entries[0];
    strictEqual(e?.seen, 3);
    strictEqual(e?.updated, "2026-10-01");
    deepStrictEqual(e?.extra, [["on", "cmd:git push"]]);
    strictEqual(r.lines.length, 1);
  });
  it("applies a broad trigger to a common file without expects", () => {
    const r = applyRetag(file("common", [entry(1)]), [op(1, "cmd:gh pr")]);
    ok(r.ok);
    deepStrictEqual(r.file.entries[0]?.extra, [["on", "cmd:gh pr"]]);
  });
  it("applies without comparing when expects are not given", () => {
    const changed = file(KEY, [
      { ...entry(1, "cmd:git commit"), body: "rewritten" },
    ]);
    ok(applyRetag(changed, [op(1, "session")]).ok);
  });
  it("refuses a path prefix in common and a read-only file", () => {
    const c = file("common", [entry(1)]);
    const ops = [op(1, "path:mods/x/")];
    const r = applyRetag(c, ops);
    ok(!r.ok);
    strictEqual(r.reason, "path-prefix-in-common");
    const ro = applyRetag({ ...repo, readOnly: true }, [op(1)]);
    ok(!ro.ok);
  });
  it("refuses when the entry changed after planning", () => {
    const planned = planRetag({ repo, common: null }, [op(1, "session")]);
    const changed = file(KEY, [
      { ...entry(1, "cmd:git commit"), body: "rewritten" },
      entry(2),
    ]);
    const r = applyRetag(changed, [op(1, "session")], expectsOf(planned));
    ok(!r.ok);
    strictEqual(r.reason, "changed");
    const onChanged = file(KEY, [entry(1, "cmd:git push"), entry(2)]);
    ok(!applyRetag(onChanged, [op(1, "session")], expectsOf(planned)).ok);
    ok(applyRetag(repo, [op(1, "session")], expectsOf(planned)).ok);
  });
  it("refuses when the entry moved to another file", () => {
    const planned = planRetag({ repo, common: null }, [op(1, "session")]);
    const moved = file(KEY, [entry(2)]);
    const r = applyRetag(moved, [op(1, "session")], expectsOf(planned));
    ok(!r.ok);
    strictEqual(r.reason, "missing");
  });
});

describe("countRetagLines", () => {
  it("counts the lines retagEntry produces", () => {
    const retagged = retagEntry(entry(1, "cmd:git"), trigs("cmd:npm"));
    const untagged = retagEntry(entry(2, "cmd:git"), trigs());
    ok(retagged.line !== null && untagged.line !== null);
    deepStrictEqual(
      countRetagLines(
        `subject\n\n${retagged.line}\n${untagged.line}\nnoise retag L-x\n`,
      ),
      { retag: 1, untag: 1 },
    );
  });
});
