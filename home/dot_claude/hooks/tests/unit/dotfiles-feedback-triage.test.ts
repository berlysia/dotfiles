import { deepStrictEqual, ok, strictEqual } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import {
  DOTFILES_REPO_KEY,
  FEEDBACK_REPO,
} from "../../lib/dotfiles-feedback/constants.ts";
import { formatTriageResult } from "../../lib/dotfiles-feedback/display.ts";
import {
  renderIssue,
  renderTriageMarker,
} from "../../lib/dotfiles-feedback/issue-body.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";
import { openSpool } from "../../lib/dotfiles-feedback/spool.ts";
import {
  parseTriageArgs,
  triage,
  type TriageDeps,
} from "../../lib/dotfiles-feedback/triage.ts";
import {
  fakeGh,
  type FakeIssue,
} from "../support/dotfiles-feedback-fake-gh.ts";

const now = new Date("2026-10-29T10:00:00Z");
const id = (index = 0) =>
  `20261029T010203Z-${index.toString(16).padStart(12, "0")}`;
function item(key: string): FeedbackItemV1 {
  return {
    schemaVersion: 1,
    id: key,
    createdAt: "2026-10-29T01:02:03Z",
    title: "title",
    target: "target",
    kind: "bug",
    body: "body",
    source: { agent: "human", repoKey: null, host: "host", vm: false },
  };
}
const issue = (
  number: number,
  key: string,
  over: Partial<FakeIssue> = {},
): FakeIssue => ({
  number,
  state: "open",
  title: "t",
  body: renderIssue(item(key)).body,
  user: "berlysia",
  pull_request: false,
  labels: ["dotfiles-feedback"],
  ...over,
});
type Ctx = {
  root: string;
  repoDir: string;
  fake: ReturnType<typeof fakeGh>;
  deps: TriageDeps;
  logs: string[];
  refreshes: number;
  with(over: Partial<TriageDeps>): TriageDeps;
};
async function fixture(run: (ctx: Ctx) => Promise<void>) {
  const base = await fs.mkdtemp(join(import.meta.dirname, ".feedback-triage-"));
  const root = join(base, "spool");
  const repoDir = join(base, "repo");
  await fs.mkdir(join(repoDir, "docs/plans"), { recursive: true });
  await fs.mkdir(join(repoDir, "home"), { recursive: true });
  await fs.writeFile(join(repoDir, "docs/plans/a.md"), "# a\n");
  await fs.mkdir(root, { mode: 0o700 });
  const fake = fakeGh();
  const logs: string[] = [];
  const state = { refreshes: 0 };
  const deps: TriageDeps = {
    root,
    home: "/h",
    repo: FEEDBACK_REPO,
    runGh: fake.run,
    fs,
    uid: (await fs.lstat(root)).uid,
    now: () => now,
    pid: 1,
    randomBytes: (size) => new Uint8Array(size).fill(1),
    isPidAlive: () => true,
    getPidStartTime: async () => "s",
    envNames: ["CLAUDECODE"],
    resolveRepoKey: async () => DOTFILES_REPO_KEY,
    cwd: repoDir,
    stdinIsTty: false,
    stdoutIsTty: false,
    editor: undefined,
    runEditor: async () => null,
    makeTempDir: async () => fs.mkdtemp(join(base, "tmp-")),
    removeTree: (path) => fs.rm(path, { recursive: true, force: true }),
    confirm: async () => false,
    spawnRefresh: async () => (state.refreshes++, true),
    resolveToplevel: async () => repoDir,
    realpath: (path) => fs.realpath(path),
    log: (text) => void logs.push(text),
  };
  const ctx: Ctx = {
    root,
    repoDir,
    fake,
    deps,
    logs,
    get refreshes() {
      return state.refreshes;
    },
    with: (over) => ({ ...deps, ...over }),
  };
  try {
    await openSpool(root, deps);
    await run(ctx);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}
const writes = (fake: ReturnType<typeof fakeGh>) =>
  fake.calls.filter((c) => c.argv[0] === "issue").length;
const kinds = (fake: ReturnType<typeof fakeGh>) =>
  fake.calls.flatMap((c) =>
    c.argv[0] === "issue"
      ? [
          c.argv[1] === "comment"
            ? "comment"
            : c.argv[1] === "edit"
              ? "label"
              : String(c.argv[1]),
        ]
      : c.argv.some((a) => a.endsWith("/comments"))
        ? ["list"]
        : [],
  );
const reject = { to: "reject", reason: "重複" } as const;

it("reject: comment, reread, label, close, then refresh", () =>
  fixture(async (ctx) => {
    const { fake, deps } = ctx;
    fake.issues.push(issue(1, id(1)));
    const out = await triage("#1", reject, deps);
    strictEqual(out.kind, "done");
    deepStrictEqual(kinds(fake).slice(-4), [
      "comment",
      "list",
      "label",
      "close",
    ]);
    const body = fake.comments.get(1)![0]!.body;
    strictEqual(
      body.split("\n")[0],
      "<!-- dotfiles-feedback-triage to=reject actor=agent -->",
    );
    ok(body.includes("理由: 重複"));
    ok(fake.issues[0]!.labels!.includes("triaged:reject"));
    strictEqual(fake.issues[0]!.state, "closed");
    strictEqual(ctx.refreshes, 1);
  }));
it("reject: rerun after a close failure keeps one comment", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    let armed = true;
    fake.intercept = async (call) =>
      armed && call.argv[1] === "close"
        ? { code: 1, stdout: "", stderr: "could not resolve host" }
        : null;
    strictEqual((await triage("#1", reject, deps)).kind, "gh-failed");
    armed = false;
    strictEqual((await triage("#1", reject, deps)).kind, "done");
    strictEqual(fake.comments.get(1)!.length, 1);
    strictEqual(fake.issues[0]!.state, "closed");
  }));
it("a different destination than the pinned one is refused without writes", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    fake.addComment(1, { body: renderTriageMarker("plan", "agent") });
    const out = await triage("#1", reject, deps);
    strictEqual(out.kind, "rejected");
    strictEqual(writes(fake), 0);
  }));
it("a CRLF-edited pinned marker still pins the destination", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    fake.addComment(1, {
      body: `${renderTriageMarker("plan", "agent")}\r\n振り分け先: x`,
    });
    strictEqual((await triage("#1", reject, deps)).kind, "rejected");
    strictEqual(writes(fake), 0);
  }));
it("another person's marker does not pin", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    fake.addComment(1, {
      user: "other",
      body: renderTriageMarker("plan", "agent"),
    });
    strictEqual((await triage("#1", reject, deps)).kind, "done");
  }));
it("an older conflicting marker appearing at the reread stops before label and close", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    fake.intercept = async (call) => {
      if (call.argv[1] === "comment")
        fake.addComment(1, {
          body: renderTriageMarker("plan", "human"),
          createdAt: "2026-10-28T00:00:00Z",
        });
      return null;
    };
    const out = await triage("#1", reject, deps);
    strictEqual(out.kind, "rejected");
    ok(!kinds(fake).includes("label") && !kinds(fake).includes("close"));
  }));
it("our marker missing at the reread stops before label and close", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    fake.intercept = async (call) =>
      call.argv[1] === "comment" ? { code: 0, stdout: "", stderr: "" } : null;
    strictEqual((await triage("#1", reject, deps)).kind, "rejected");
    ok(!kinds(fake).includes("label") && !kinds(fake).includes("close"));
  }));
it("closed issues report triaged or plain closed and write nothing", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(
      issue(1, id(1), { state: "closed" }),
      issue(2, id(2), { state: "closed" }),
    );
    fake.addComment(1, { body: renderTriageMarker("reject", "agent") });
    const triaged = await triage("#1", reject, deps);
    strictEqual(triaged.kind, "rejected");
    ok(
      triaged.kind === "rejected" &&
        triaged.reason.includes("振り分け済み（to=reject）"),
    );
    const plain = await triage("#2", reject, deps);
    ok(plain.kind === "rejected" && plain.reason.includes("close 済み"));
    strictEqual(writes(fake), 0);
  }));
it("not-target issues are refused", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(
      issue(1, id(1), { user: "other" }),
      issue(2, id(2), { body: "plain" }),
    );
    strictEqual((await triage("#1", reject, deps)).kind, "rejected");
    strictEqual((await triage("#2", reject, deps)).kind, "rejected");
    strictEqual(writes(fake), 0);
  }));

for (const [place, advice] of [
  ["pending", "先に flush する"],
  ["held", "CLI を更新する"],
  ["failed", "flush --retry"],
] as const)
  it(`local ${place} item is refused with advice`, () =>
    fixture(async ({ root, fake, deps }) => {
      fake.issues.push(issue(1, id(1)));
      await fs.writeFile(join(root, place, `${id(1)}.json`), "{}");
      const out = await triage(id(1), reject, deps);
      ok(
        out.kind === "rejected" && out.reason.includes(advice),
        JSON.stringify(out),
      );
      strictEqual(writes(fake), 0);
    }));

it("plan: valid path comments the destination and succeeds from a subdirectory", () =>
  fixture(async ({ fake, deps, repoDir }) => {
    fake.issues.push(issue(1, id(1)));
    const out = await triage(
      "#1",
      { to: "plan", path: "docs/plans/a.md" },
      { ...deps, cwd: join(repoDir, "home") },
    );
    strictEqual(out.kind, "done");
    ok(fake.comments.get(1)![0]!.body.includes("振り分け先: docs/plans/a.md"));
  }));
it("plan: bad paths are refused without gh writes", () =>
  fixture(async ({ fake, deps, repoDir }) => {
    fake.issues.push(issue(1, id(1)));
    await fs.symlink("a.md", join(repoDir, "docs/plans/s.md"));
    const outside = join(repoDir, "..", "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, "z.md"), "x");
    await fs.mkdir(join(repoDir, "other"));
    await fs.symlink(outside, join(repoDir, "other/plans"));
    for (const path of [
      "docs/plans/../x.md",
      "docs/plans/A.md",
      "docs/x.md",
      "docs/plans/s.md",
      "docs/plans/b.md",
    ])
      strictEqual(
        (await triage("#1", { to: "plan", path }, deps)).kind,
        "rejected",
        path,
      );
    // docs/plans が外へのディレクトリ symlink
    await fs.rm(join(repoDir, "docs/plans"), { recursive: true });
    await fs.symlink(outside, join(repoDir, "docs/plans"));
    await fs.writeFile(join(outside, "a.md"), "x");
    strictEqual(
      (await triage("#1", { to: "plan", path: "docs/plans/a.md" }, deps)).kind,
      "rejected",
    );
    strictEqual(writes(fake), 0);
  }));
it("plan: a non-dotfiles repository is refused", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    const out = await triage(
      "#1",
      { to: "plan", path: "docs/plans/a.md" },
      { ...deps, resolveRepoKey: async () => "github.com/x/y" },
    );
    strictEqual(out.kind, "rejected");
    strictEqual(writes(fake), 0);
  }));
it("reason: mentions are neutralized; newline and 501 characters are refused", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    for (const reason of ["a\nb", "x".repeat(501)])
      strictEqual(
        (await triage("#1", { to: "reject", reason }, deps)).kind,
        "rejected",
      );
    strictEqual(writes(fake), 0);
    strictEqual(
      (await triage("#1", { to: "reject", reason: "@octocat" }, deps)).kind,
      "done",
    );
    ok(fake.comments.get(1)![0]!.body.includes("理由: ＠octocat"));
  }));
it("a human caller records actor=human", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(1, id(1)));
    await triage("#1", reject, {
      ...deps,
      envNames: [],
      stdinIsTty: true,
      stdoutIsTty: true,
    });
    ok(
      fake.comments
        .get(1)![0]!
        .body.startsWith(
          "<!-- dotfiles-feedback-triage to=reject actor=human -->",
        ),
    );
  }));
it("a failed refresh spawn is logged and the result stays done", () =>
  fixture(async ({ fake, deps, logs }) => {
    fake.issues.push(issue(1, id(1)));
    const out = await triage("#1", reject, {
      ...deps,
      spawnRefresh: async () => false,
    });
    strictEqual(out.kind, "done");
    strictEqual(logs.length, 1);
  }));
it("formatTriageResult strips escapes", () =>
  ok(
    !formatTriageResult({
      number: 1,
      to: "issue",
      publicUrl: "u\u001b[2J",
    }).includes("\u001b"),
  ));

for (const [args, good] of [
  [["#1", "--to", "reject", "--reason", "r"], true],
  [["#1", "--to", "plan", "--path", "docs/plans/a.md"], true],
  [["#1", "--to", "issue"], true],
  [["#1"], false],
  [["#1", "--to", "x"], false],
  [["#1", "--to", "plan", "--reason", "r", "--path", "p"], false],
  [["#1", "--to", "reject", "--path", "p"], false],
  [["#1", "--to", "reject", "--reason", "--to"], false],
  [["#1", "--to", "reject", "--reason", "-x"], false],
  [["#1", "--to", "reject", "--reason", "r", "--bogus"], false],
  [["#1", "--to", "reject", "--to", "reject", "--reason", "r"], false],
  [["#1", "#2", "--to", "reject", "--reason", "r"], false],
  [["--to", "reject", "--reason", "r"], false],
  [["#1", "--to", "issue", "--reason", "r"], false],
  [["#1", "--to", "issue", "--path", "p"], false],
  [["#1", "--to", "plan"], false],
  [["#1", "--to", "reject"], false],
] as const)
  it(`parseTriageArgs ${JSON.stringify(args)} is ${good}`, () =>
    strictEqual(parseTriageArgs([...args]).ok, good));
