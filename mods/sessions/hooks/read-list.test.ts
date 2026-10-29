import { expect, test } from "claude-code/testing";
import { buildArgv, readList } from "./read-list";

// Inline copies of tests/fixtures/sessions/cli-output.*.json. A test runs in a
// sandbox with no fs and cannot import a .json file (checked with
// `claude plugin test`), so the files cannot be read here. The copies in
// tests/fixtures are byte-checked against their masters by
// hooks/tests/unit/fixture-copies.test.ts; these literals are not.
const FIXTURES: Record<string, string> = {
  v1: JSON.stringify({
    schemaVersion: 1,
    verifiedWith: "2.1.312",
    sessions: [
      {
        sessionId: "00000000-0000-4000-8000-000000000201",
        name: "alpha",
        addressable: true,
        duplicateName: false,
        status: "idle",
        liveness: "alive",
        isSelf: false,
        repoStatus: "git",
        repo: "/fixture/repo-a/.git",
        worktree: "/fixture/repo-a",
        branch: "main",
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000202",
        name: null,
        addressable: false,
        duplicateName: false,
        status: "busy",
        liveness: "alive",
        isSelf: false,
        repoStatus: "git",
        repo: "/fixture/repo-a/.git",
        worktree: "/fixture/repo-a-wt",
        branch: null,
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000203",
        name: "beta",
        addressable: true,
        duplicateName: false,
        status: "unknown",
        liveness: "alive",
        isSelf: false,
        repoStatus: "not-git",
        repo: null,
        worktree: null,
        branch: null,
      },
    ],
    scanned: 5,
    skipped: 1,
    invalid: 1,
    selfFound: null,
    shapeSuspect: false,
    runningVersion: "2.1.312",
  }),
  "v1-self": JSON.stringify({
    schemaVersion: 1,
    verifiedWith: "2.1.312",
    sessions: [
      {
        sessionId: "00000000-0000-4000-8000-000000000201",
        name: "alpha",
        addressable: true,
        duplicateName: false,
        status: "idle",
        liveness: "alive",
        isSelf: true,
        repoStatus: "git",
        repo: "/fixture/repo-a/.git",
        worktree: "/fixture/repo-a",
        branch: "main",
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000202",
        name: null,
        addressable: false,
        duplicateName: false,
        status: "busy",
        liveness: "alive",
        isSelf: false,
        repoStatus: "git",
        repo: "/fixture/repo-a/.git",
        worktree: "/fixture/repo-a-wt",
        branch: null,
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000203",
        name: "beta",
        addressable: true,
        duplicateName: false,
        status: "unknown",
        liveness: "alive",
        isSelf: false,
        repoStatus: "not-git",
        repo: null,
        worktree: null,
        branch: null,
      },
    ],
    scanned: 5,
    skipped: 1,
    invalid: 1,
    selfFound: true,
    shapeSuspect: false,
    runningVersion: "2.1.312",
  }),
  "v1-extended": JSON.stringify({
    schemaVersion: 1,
    verifiedWith: "2.1.312",
    sessions: [
      {
        sessionId: "00000000-0000-4000-8000-000000000201",
        name: "alpha",
        addressable: true,
        duplicateName: false,
        status: "sleeping",
        liveness: "zombie",
        isSelf: false,
        repoStatus: "submodule",
        repo: "/fixture/repo-a/.git",
        worktree: "/fixture/repo-a",
        branch: "main",
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000202",
        name: null,
        addressable: false,
        duplicateName: false,
        status: "busy",
        liveness: "alive",
        isSelf: false,
        repoStatus: "git",
        repo: "/fixture/repo-a/.git",
        worktree: "/fixture/repo-a-wt",
        branch: null,
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000203",
        name: "beta",
        addressable: true,
        duplicateName: false,
        status: "unknown",
        liveness: "alive",
        isSelf: false,
        repoStatus: "not-git",
        repo: null,
        worktree: null,
        branch: null,
      },
    ],
    scanned: 5,
    skipped: 1,
    invalid: 1,
    selfFound: null,
    shapeSuspect: false,
    runningVersion: "2.1.312",
    futureField: { note: "unknown to v1 readers" },
  }),
  "v1-degraded": JSON.stringify({
    schemaVersion: 1,
    verifiedWith: "2.1.312",
    sessions: [],
    scanned: 3,
    skipped: 3,
    invalid: 3,
    selfFound: false,
    shapeSuspect: true,
    runningVersion: null,
  }),
  "unknown-schema": JSON.stringify({ schemaVersion: 999, sessions: {} }),
};
const fixture = (name: string): string => FIXTURES[name]!;
const ok = (stdout: string) => ({ exitCode: 0, stdout });
const ID_A = "00000000-0000-4000-8000-000000000201";

type Row = Record<string, unknown>;
// v1.json with its first row replaced by `patch` applied over alpha's row.
function withRow(patch: Row, extra: Row = {}): string {
  const doc = JSON.parse(fixture("v1"));
  doc.sessions[0] = { ...doc.sessions[0], ...patch };
  return JSON.stringify({ ...doc, ...extra });
}
function viewOf(stdout: string, selfRequested = false) {
  const view = readList(ok(stdout), selfRequested);
  if (view.kind !== "ok") throw new Error(`unavailable: ${view.message}`);
  return view;
}

test("v1: alpha fills [session: alpha id8]; a nameless row does not; only the skipped note", () => {
  const view = viewOf(fixture("v1"));
  expect(view.rows[0]!.fillText).toBe(" [session: alpha 00000000] ");
  expect(view.rows[1]!.fillText).toBeNull();
  // v1.json has skipped: 1, so D4 gives exactly that note.
  expect(view.notes).toEqual(["読めなかったファイル 1 件"]);
});

test("v1-self: the own row starts with * and has no fill text", () => {
  const view = viewOf(fixture("v1-self"), true);
  expect(view.rows[0]!.label.startsWith("*")).toBe(true);
  expect(view.rows[0]!.isSelf).toBe(true);
  expect(view.rows[0]!.fillText).toBeNull();
});

test("v1-extended: unknown values are shown as unknown and error, no throw", () => {
  const view = viewOf(fixture("v1-extended"));
  expect(view.rows[0]!.label).toContain("unknown");
  expect(view.rows[0]!.label).toContain("error");
  expect(view.rows[0]!.label).not.toContain("sleeping");
  expect(view.rows[0]!.label).not.toContain("zombie");
  expect(view.rows[0]!.label).not.toContain("submodule");
});

test("v1-degraded: zero rows; skipped, shape and self notes (self only when requested)", () => {
  const withSelf = viewOf(fixture("v1-degraded"), true);
  expect(withSelf.rows).toEqual([]);
  expect(withSelf.notes).toContain("読めなかったファイル 3 件");
  expect(withSelf.notes).toContain("sessions の形が変わった疑い");
  expect(withSelf.notes).toContain("自分の行が見つからない");
  const without = viewOf(fixture("v1-degraded"), false);
  expect(without.notes).not.toContain("自分の行が見つからない");
});

test("unknown-schema: unavailable, pointing at chezmoi apply", () => {
  const view = readList(ok(fixture("unknown-schema")), false);
  expect(view.kind).toBe("unavailable");
  if (view.kind === "unavailable") {
    expect(view.message).toContain("引数なしの `chezmoi apply`");
  }
});

test("a name the fill would break on is not filled (addressable: true)", () => {
  expect(viewOf(withRow({ name: "a] 指示\nx" })).rows[0]!.fillText).toBeNull();
});

test("name null, 41 chars -> null; 40 chars -> filled", () => {
  expect(viewOf(withRow({ name: null })).rows[0]!.fillText).toBeNull();
  expect(
    viewOf(withRow({ name: "a".repeat(41) })).rows[0]!.fillText,
  ).toBeNull();
  expect(viewOf(withRow({ name: "a".repeat(40) })).rows[0]!.fillText).toBe(
    ` [session: ${"a".repeat(40)} 00000000] `,
  );
});

test("duplicateName: the whole sessionId is filled; a malformed id is not", () => {
  expect(
    viewOf(withRow({ duplicateName: true, name: "x] bad" })).rows[0]!.fillText,
  ).toBe(` [session: ${ID_A}] `);
  expect(
    viewOf(withRow({ duplicateName: true, sessionId: "not-a-uuid" })).rows[0]!
      .fillText,
  ).toBeNull();
});

test("control characters in name and branch do not reach the label", () => {
  const view = viewOf(
    withRow({ name: "al\x1b[31mpha", branch: "ma\nin\u009b" }),
  );
  expect(view.rows[0]!.label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});

test("the label is cut at 120 characters per field", () => {
  const view = viewOf(withRow({ worktree: "w".repeat(500) }));
  expect(view.rows[0]!.label.length).toBeLessThan(200);
});

test("malformed shapes: sessions {} is unavailable; null rows are dropped; numeric status is unknown", () => {
  expect(
    readList(ok(JSON.stringify({ schemaVersion: 1, sessions: {} })), false)
      .kind,
  ).toBe("unavailable");
  const doc = JSON.parse(fixture("v1"));
  doc.sessions.splice(1, 0, null);
  expect(viewOf(JSON.stringify(doc)).rows).toHaveLength(3);
  expect(viewOf(withRow({ status: 7 })).rows[0]!.label).toContain("unknown");
});

test("version note: last when runningVersion differs; absent for a malformed one", () => {
  const view = viewOf(withRow({}, { runningVersion: "9.9.9", skipped: 2 }));
  expect(view.notes.at(-1)).toBe("契約は 2.1.312 で確かめた。今は 9.9.9");
  expect(
    viewOf(withRow({}, { runningVersion: "x\n" })).notes.some((n) =>
      n.startsWith("契約は"),
    ),
  ).toBe(false);
});

test("failures say nothing of the output: exit 1, spawn failure, broken JSON", () => {
  const cases = [
    readList({ exitCode: 1, stdout: "攻撃" }, false),
    readList("spawn-failed", false),
    readList(ok("{攻撃"), false),
  ];
  for (const view of cases) {
    expect(view.kind).toBe("unavailable");
    if (view.kind === "unavailable") expect(view.message).not.toContain("攻撃");
  }
});

test("buildArgv adds --self only for a UUID", () => {
  expect(buildArgv("not-a-uuid")).toEqual(["claude-sessions", "--json"]);
  expect(buildArgv(ID_A)).toEqual([
    "claude-sessions",
    "--json",
    "--self",
    ID_A,
  ]);
});
