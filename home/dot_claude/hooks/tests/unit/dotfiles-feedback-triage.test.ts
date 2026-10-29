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

// plan-3 T8: --to issue
import { dirname } from "node:path";
import {
  parseOriginId,
  renderOriginMarker,
  renderPublicUrlMarker,
} from "../../lib/dotfiles-feedback/issue-body.ts";

const toIssue = { to: "issue" } as const;
const PUBLIC_LIST = (argv: readonly string[]) =>
  argv.includes("repos/berlysia/dotfiles/issues");
const privateIssue = (
  number: number,
  key: string,
  over: {
    body?: string;
    target?: string;
    repoKey?: string;
    host?: string;
  } = {},
): FakeIssue => ({
  ...issue(number, key),
  body: renderIssue({
    ...item(key),
    body: over.body ?? "body",
    target: over.target ?? "target",
    source: {
      agent: "human",
      repoKey: over.repoKey ?? null,
      host: over.host ?? "host",
      vm: false,
    },
  }).body,
});
type Edit = (path: string, argv: readonly string[]) => Promise<void> | void;
function human(
  ctx: Ctx,
  edit: Edit | null,
  answers: { confirm?: boolean; editor?: string | undefined } = {},
) {
  const seen = { editors: 0, confirms: [] as string[], argv: [] as string[][] };
  const deps: TriageDeps = {
    ...ctx.deps,
    envNames: [],
    stdinIsTty: true,
    stdoutIsTty: true,
    editor: "editor" in answers ? answers.editor : "ed",
    runEditor: async (argv) => {
      seen.editors++;
      seen.argv.push([...argv]);
      if (edit === null) return 1;
      await edit(argv[argv.length - 1] as string, argv);
      return 0;
    },
    confirm: async (text) => (
      seen.confirms.push(text),
      answers.confirm ?? true
    ),
  };
  return { deps, seen };
}
const write =
  (text: string): Edit =>
  (path) =>
    fs.writeFile(path, text);
const publicWrites = (ctx: Ctx) => ctx.fake.publicIssues.length;

for (const [name, over] of [
  [
    "agent environment",
    { envNames: ["CLAUDECODE"], stdinIsTty: true, stdoutIsTty: true },
  ],
  ["stdin only a tty", { envNames: [], stdinIsTty: true, stdoutIsTty: false }],
  ["stdout only a tty", { envNames: [], stdinIsTty: false, stdoutIsTty: true }],
] as const)
  it(`issue: ${name} is refused before any fs or gh access`, () =>
    fixture(async (ctx) => {
      ctx.fake.issues.push(issue(1, id(1)));
      const calls: string[] = [];
      const recording = new Proxy(fs, {
        get:
          (target, key) =>
          (...args: unknown[]) => {
            calls.push(String(key));
            return (
              target as never as Record<string, (...a: unknown[]) => unknown>
            )[String(key)]!(...args);
          },
      }) as typeof fs;
      const out = await triage("#1", toIssue, {
        ...ctx.deps,
        ...over,
        fs: recording,
      });
      strictEqual(out.kind, "rejected");
      strictEqual(calls.length, 0);
      strictEqual(ctx.fake.calls.length, 0);
    }));

it("issue: an unchanged draft cancels, writes nothing, and a later reject still works", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(issue(1, id(1)));
    const { deps, seen } = human(ctx, () => undefined);
    strictEqual((await triage("#1", toIssue, deps)).kind, "cancelled");
    strictEqual(writes(ctx.fake), 0);
    strictEqual(publicWrites(ctx), 0);
    strictEqual(seen.confirms.length, 0);
    strictEqual((await triage("#1", reject, ctx.deps)).kind, "done");
  }));
for (const [name, edit, answers] of [
  ["only comment lines", (p: string) => fs.writeFile(p, ";; a\n;; b\n"), {}],
  ["editor exits 1", null, {}],
  ["no editor configured", () => undefined, { editor: undefined }],
  ["confirm declined", write("題\n\n本文\n"), { confirm: false }],
  ["no title", write(";; x\n\n\n本文だけ\n"), {}],
] as const)
  it(`issue: ${name} cancels with no writes`, () =>
    fixture(async (ctx) => {
      ctx.fake.issues.push(issue(1, id(1)));
      const { deps } = human(ctx, edit as Edit | null, answers);
      const out = await triage("#1", toIssue, deps);
      ok(out.kind === "cancelled" || out.kind === "rejected", out.kind);
      strictEqual(writes(ctx.fake), 0);
      strictEqual(publicWrites(ctx), 0);
    }));
it("issue: a draft with an escape sequence is refused with code point and line", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(issue(1, id(1)));
    const { deps } = human(ctx, write("題\n\n本文\n\u001b[2J危険\n"));
    const out = await triage("#1", toIssue, deps);
    ok(
      out.kind === "rejected" &&
        out.reason.includes("U+001B") &&
        out.reason.includes("4"),
      JSON.stringify(out),
    );
    strictEqual(writes(ctx.fake), 0);
  }));
it("issue: CRLF drafts are normalized and the confirmed text equals what is created", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    const { deps, seen } = human(
      ctx,
      write("公開題\r\n\r\n公開本文 @octocat\r\n二行目\r\n"),
    );
    const out = await triage("#1", toIssue, deps);
    strictEqual(out.kind, "done");
    const created = ctx.fake.publicIssues[0]!;
    ok(!created.body.includes("\r"));
    strictEqual(created.title, "公開題");
    ok(created.body.includes("＠octocat"));
    const confirmed = seen.confirms[0]!;
    ok(confirmed.includes(created.title));
    ok(confirmed.includes(created.body));
    strictEqual(parseOriginId(created.body), id(1));
  }));
it("issue: gh writes happen in order comment, create, url comment, label, close", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    const { deps } = human(ctx, write("題\n\n本文\n"));
    const out = await triage("#1", toIssue, deps);
    ok(
      out.kind === "done" &&
        out.view.publicUrl === "https://github.com/berlysia/dotfiles/issues/1",
    );
    deepStrictEqual(
      ctx.fake.calls
        .filter((c) => c.argv[0] === "issue")
        .map(
          (c) =>
            `${c.argv[1]}:${c.argv[3] === "berlysia/dotfiles" ? "public" : "private"}`,
        ),
      [
        "comment:private",
        "create:public",
        "comment:private",
        "edit:private",
        "close:private",
      ],
    );
    const comments = ctx.fake.comments.get(1)!;
    ok(
      comments[0]!.body.startsWith(
        "<!-- dotfiles-feedback-triage to=issue actor=human -->",
      ),
    );
    ok(
      comments[1]!.body.startsWith(
        "<!-- dotfiles-feedback-public url=https://github.com/berlysia/dotfiles/issues/1 -->",
      ),
    );
    strictEqual(ctx.refreshes, 1);
  }));
it("issue: editor argv, draft permissions, initial content and cleanup", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(
      privateIssue(1, id(1), {
        body: "秘密の本文です。これは公開しない。",
        target: "tgt-secret",
      }),
    );
    let dir = "";
    let mode = 0;
    let dirMode = 0;
    let initial = "";
    const { deps, seen } = human(
      ctx,
      async (path) => {
        dir = dirname(path);
        mode = (await fs.lstat(path)).mode & 0o777;
        dirMode = (await fs.lstat(dir)).mode & 0o777;
        initial = await fs.readFile(path, "utf8");
      },
      { editor: "code --wait" },
    );
    strictEqual((await triage("#1", toIssue, deps)).kind, "cancelled");
    deepStrictEqual(seen.argv[0]!.slice(0, 2), ["code", "--wait"]);
    ok(seen.argv[0]![2]!.endsWith("/draft.md"));
    strictEqual(mode, 0o600);
    strictEqual(dirMode, 0o700);
    ok(
      !initial.includes("秘密") &&
        !initial.includes("tgt-secret") &&
        !initial.includes("t\n"),
    );
    ok(
      initial
        .split("\n")
        .filter((l) => l !== "")
        .every((l) => l.startsWith(";; ")),
    );
    ok(
      await fs.lstat(dir).then(
        () => false,
        () => true,
      ),
    );
  }));
it("issue: a draft swapped for a symlink during editing cancels", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(issue(1, id(1)));
    const { deps } = human(ctx, async (path) => {
      await fs.rm(path);
      await fs.writeFile(`${path}.real`, "題\n\n本文\n");
      await fs.symlink(`${path}.real`, path);
    });
    strictEqual((await triage("#1", toIssue, deps)).kind, "cancelled");
    strictEqual(writes(ctx.fake), 0);
  }));
it("issue: an oversized draft is refused", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(issue(1, id(1)));
    const { deps } = human(ctx, write(`題\n\n${"あ".repeat(30_000)}\n`));
    strictEqual((await triage("#1", toIssue, deps)).kind, "rejected");
    strictEqual(writes(ctx.fake), 0);
  }));
it("issue: secrets are redacted in the confirmed text, key-like strings and origin lines are refused", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(issue(1, id(1)));
    const redacted = human(ctx, write(`題\n\n本文 ghp_${"A".repeat(36)}\n`));
    strictEqual((await triage("#1", toIssue, redacted.deps)).kind, "done");
    ok(redacted.seen.confirms[0]!.includes("[REDACTED]"));
    ok(ctx.fake.publicIssues[0]!.body.includes("[REDACTED]"));
    ctx.fake.issues.push(issue(2, id(2)));
    const keyLike = human(ctx, write(`題\n\n${"aB3".repeat(14)}\n`));
    strictEqual((await triage("#2", toIssue, keyLike.deps)).kind, "rejected");
    const marker = human(
      ctx,
      write(`題\n\n本文\n${renderOriginMarker(id(5))}\n`),
    );
    strictEqual((await triage("#2", toIssue, marker.deps)).kind, "rejected");
    strictEqual(ctx.fake.publicIssues.length, 1);
  }));
const PRIVATE_BODY = "これはprivateの本文でありそれなりの長さがある文章です。";
for (const [name, copy, warns] of [
  ["20 characters copied", PRIVATE_BODY.slice(3, 23), true],
  ["19 characters copied", PRIVATE_BODY.slice(3, 22), false],
] as const)
  it(`issue: ${name} ${warns ? "warns" : "does not warn"} before confirmation`, () =>
    fixture(async (ctx) => {
      ctx.fake.issues.push(privateIssue(1, id(1), { body: PRIVATE_BODY }));
      const { deps, seen } = human(ctx, write(`題\n\n別の話 ${copy} 終わり\n`));
      await triage("#1", toIssue, deps);
      strictEqual(seen.confirms[0]!.includes("警告"), warns);
    }));
it("issue: a short private body warns when copied whole", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1), { body: "短い本文です" }));
    const { deps, seen } = human(ctx, write("題\n\n前 短い本文です 後\n"));
    await triage("#1", toIssue, deps);
    ok(seen.confirms[0]!.includes("警告"));
  }));
it("issue: target, repoKey, host, #number and the feedback repo URL warn", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(
      privateIssue(1, id(1), {
        target: "tgt-unique",
        repoKey: "github.com/a/b",
        host: "myhost-unique",
      }),
    );
    for (const text of [
      "tgt-unique",
      "github.com/a/b",
      "myhost-unique",
      "#12",
      "github.com/berlysia/dotfiles-feedback/issues/1",
    ]) {
      const { deps, seen } = human(ctx, write(`題\n\n本文 ${text} 終\n`), {
        confirm: false,
      });
      await triage("#1", toIssue, deps);
      ok(seen.confirms[0]!.includes("警告"), text);
    }
  }));

const existingIssueComment = (ctx: Ctx, createdAt = "2026-10-29T05:00:00Z") =>
  ctx.fake.addComment(1, {
    body: `${renderTriageMarker("issue", "human")}\n公開 issue に起票する`,
    createdAt,
  });
it("issue: a rerun with a failing public listing creates nothing", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    existingIssueComment(ctx);
    ctx.fake.failWhen(PUBLIC_LIST, "timeout");
    const { deps, seen } = human(ctx, write("題\n\n本文\n"));
    strictEqual((await triage("#1", toIssue, deps)).kind, "gh-failed");
    strictEqual(publicWrites(ctx), 0);
    strictEqual(seen.editors, 0);
  }));
it("issue: a failing comment listing creates nothing", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    ctx.fake.failWhen(
      (argv) => argv.some((a) => a.endsWith("/comments")),
      "network",
    );
    const { deps } = human(ctx, write("題\n\n本文\n"));
    strictEqual((await triage("#1", toIssue, deps)).kind, "gh-failed");
    strictEqual(publicWrites(ctx), 0);
  }));
it("issue: recovery guidance has three forms depending on what is known", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    existingIssueComment(ctx);
    // 1. URL も origin も無い（一覧は成功）: コメントを消せば選び直せる
    const none = await triage("#1", reject, ctx.deps);
    ok(
      none.kind === "rejected" && none.reason.includes("コメントを消せば"),
      JSON.stringify(none),
    );
    ok(none.kind === "rejected" && none.reason.includes("#1"));
    // 2. origin の public issue がある: もう一度実行する
    ctx.fake.publicIssues.push({
      number: 5,
      state: "open",
      user: "berlysia",
      pull_request: false,
      body: `本文\n\n${renderOriginMarker(id(1))}\n`,
    });
    const found = await triage("#1", reject, ctx.deps);
    ok(
      found.kind === "rejected" &&
        found.reason.includes("もう一度実行") &&
        !found.reason.includes("コメントを消せば"),
      JSON.stringify(found),
    );
    // 3. 一覧が失敗: 時間をおいて再実行
    ctx.fake.publicIssues.length = 0;
    ctx.fake.failWhen(PUBLIC_LIST, "timeout");
    const unknown = await triage("#1", reject, ctx.deps);
    ok(
      unknown.kind === "rejected" &&
        unknown.reason.includes("時間をおいて") &&
        !unknown.reason.includes("コメントを消せば"),
      JSON.stringify(unknown),
    );
  }));
it("issue: a URL marker comment alone gives the continue guidance without listing", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    existingIssueComment(ctx);
    ctx.fake.addComment(1, {
      body: renderPublicUrlMarker(
        "https://github.com/berlysia/dotfiles/issues/9",
      ),
    });
    const out = await triage(
      "#1",
      { to: "plan", path: "docs/plans/a.md" },
      ctx.deps,
    );
    ok(out.kind === "rejected" && out.reason.includes("もう一度実行"));
    ok(!ctx.fake.calls.some((c) => PUBLIC_LIST(c.argv)));
  }));
it("issue: cancelling a rerun leaves the pinned comment and a later reject is refused", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    existingIssueComment(ctx);
    const { deps } = human(ctx, () => undefined);
    strictEqual((await triage("#1", toIssue, deps)).kind, "cancelled");
    const out = await triage("#1", reject, ctx.deps);
    ok(out.kind === "rejected" && out.reason.includes("コメントを消せば"));
  }));
it("issue: a crash right after creating the public issue reuses it on rerun", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    let comments = 0;
    ctx.fake.intercept = async (call) =>
      call.argv[1] === "comment" && ++comments === 2
        ? { code: 1, stdout: "", stderr: "could not resolve host" }
        : null;
    const first = human(ctx, write("題\n\n本文\n"));
    strictEqual((await triage("#1", toIssue, first.deps)).kind, "gh-failed");
    strictEqual(publicWrites(ctx), 1);
    const second = human(ctx, write("別\n\n別\n"));
    const out = await triage("#1", toIssue, second.deps);
    strictEqual(out.kind, "done");
    strictEqual(second.seen.editors, 0);
    strictEqual(publicWrites(ctx), 1);
    strictEqual(
      ctx.fake.comments
        .get(1)!
        .filter((c) => c.body.includes("dotfiles-feedback-public")).length,
      1,
    );
    strictEqual(ctx.fake.issues[0]!.state, "closed");
  }));
it("issue: after the URL comment a rerun uses it without listing the public repo", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    let armed = true;
    ctx.fake.intercept = async (call) =>
      armed && call.argv[1] === "edit"
        ? { code: 1, stdout: "", stderr: "could not resolve host" }
        : null;
    const first = human(ctx, write("題\n\n本文\n"));
    strictEqual((await triage("#1", toIssue, first.deps)).kind, "gh-failed");
    armed = false;
    ctx.fake.calls.length = 0;
    const second = human(ctx, null);
    strictEqual((await triage("#1", toIssue, second.deps)).kind, "done");
    ok(!ctx.fake.calls.some((c) => PUBLIC_LIST(c.argv)));
    strictEqual(publicWrites(ctx), 1);
  }));
it("issue: foreign or mid-body origin markers are not treated as ours", () =>
  fixture(async (ctx) => {
    ctx.fake.issues.push(privateIssue(1, id(1)));
    existingIssueComment(ctx);
    ctx.fake.publicIssues.push(
      {
        number: 5,
        state: "open",
        user: "other",
        pull_request: false,
        body: `x\n${renderOriginMarker(id(1))}`,
      },
      {
        number: 6,
        state: "open",
        user: "berlysia",
        pull_request: false,
        body: `${renderOriginMarker(id(1))}\nあとに続く`,
      },
    );
    const { deps, seen } = human(ctx, () => undefined);
    strictEqual((await triage("#1", toIssue, deps)).kind, "cancelled");
    strictEqual(seen.editors, 1);
    strictEqual(publicWrites(ctx), 2);
  }));
