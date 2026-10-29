import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { it } from "node:test";
import { openGh, ghEnvironment } from "../../lib/dotfiles-feedback/gh.ts";
import {
  FEEDBACK_REPO,
  FEEDBACK_LABELS,
} from "../../lib/dotfiles-feedback/constants.ts";
import { fakeGh } from "../support/dotfiles-feedback-fake-gh.ts";
const id = "20261029T100000Z-0123456789ab";
const now = new Date("2026-10-29T10:00:00Z");
function fixture() {
  const fake = fakeGh();
  return {
    fake,
    gh: openGh({ home: "/passwd/home", repo: FEEDBACK_REPO, runGh: fake.run }),
  };
}
it("gh: environment is allow-listed and HOME comes from deps", async () => {
  deepStrictEqual(
    ghEnvironment("/passwd/home", {
      HOME: "/wrong",
      PATH: "/bin",
      GH_REPO: "bad",
      GH_TOKEN: "bad",
      GITHUB_TOKEN: "bad",
      FOO: "bad",
    }),
    { HOME: "/passwd/home", PATH: "/bin" },
  );
  const { fake, gh } = fixture();
  await gh.checkDestination();
  strictEqual(fake.calls[0]!.options.env.HOME, "/passwd/home");
  deepStrictEqual(fake.calls[0]!.argv, ["api", "--method", "GET", "user"]);
});
for (const field of ["login", "owner", "isPrivate"] as const)
  it(`gh: destination rejects ${field}`, async () => {
    const { fake, gh } = fixture();
    if (field === "isPrivate") fake.isPrivate = false;
    else fake[field] = "other";
    const result = await gh.checkDestination();
    ok(!result.ok);
    strictEqual(result.error, "not-private");
    strictEqual(result.permanent, false);
  });
it("gh: prepares the seven constant labels", async () => {
  const { fake, gh } = fixture();
  ok((await gh.ensureLabels()).ok);
  deepStrictEqual(
    fake.calls.map((call) => call.argv),
    FEEDBACK_LABELS.map((label) => [
      "label",
      "create",
      label,
      "--repo",
      FEEDBACK_REPO,
      "--force",
    ]),
  );
});
for (const createdAt of ["2026-10-29T10:00:00Z", "2027-10-29T10:00:00Z"])
  it(`gh: paginated all-state lookup ${createdAt}`, async () => {
    const { fake, gh } = fixture();
    fake.issues.push(
      {
        number: 1,
        body: "bad",
        user: "berlysia",
        state: "open",
        pull_request: false,
      },
      {
        number: 2,
        body: `<!-- dotfiles-feedback id=${id} v=2 {} -->`,
        user: "berlysia",
        state: "closed",
        pull_request: true,
      },
      {
        number: 3,
        body: `<!-- dotfiles-feedback id=${id} v=2 {} -->`,
        user: "berlysia",
        state: "closed",
        pull_request: false,
      },
    );
    const result = await gh.findIssueById(id, createdAt, now);
    ok(result.ok);
    strictEqual(result.value?.number, 3);
    const argv = fake.calls[0]!.argv;
    deepStrictEqual(argv.slice(0, 5), [
      "api",
      "--method",
      "GET",
      "--paginate",
      `repos/${FEEDBACK_REPO}/issues`,
    ]);
    for (const value of [
      "state=all",
      "labels=dotfiles-feedback",
      "creator=berlysia",
      "per_page=100",
      "since=2026-10-28T10:00:00.000Z",
    ])
      strictEqual(argv[argv.indexOf(value) - 1], "-f");
    ok(argv.includes("--jq"));
  });
it("gh: untrusted title is one argument and body is stdin", async () => {
  const { fake, gh } = fixture();
  const result = await gh.createIssue({
    title: "--repo=x",
    body: "-F x",
    labels: ["dotfiles-feedback", "kind:bug"],
  });
  ok(result.ok);
  strictEqual(result.value, 1);
  ok(fake.calls[0]!.argv.includes("--title=--repo=x"));
  ok(!fake.calls[0]!.argv.includes("-F x"));
  deepStrictEqual(fake.calls[0]!.argv.slice(-2), ["--body-file", "-"]);
  strictEqual(fake.calls[0]!.options.stdin, "-F x");
});
for (const [code, stderr, spawnError, timedOut, expected, permanent] of [
  [null, "", "ENOENT", false, "gh-missing", false],
  [4, "", undefined, false, "auth", false],
  [1, "authentication required", undefined, false, "auth", false],
  [1, "HTTP 422", undefined, false, "other", true],
  [null, "", undefined, true, "network", false],
  [1, "TLS connection", undefined, false, "network", false],
  [1, "HTTP 500", undefined, false, "other", false],
] as const)
  it(`gh: maps failure ${expected}/${stderr}/${spawnError}`, async () => {
    const { fake, gh } = fixture();
    fake.intercept = async () => ({
      code,
      stdout: "partial",
      stderr,
      ...(spawnError ? { spawnError } : {}),
      timedOut,
    });
    const result = await gh.createIssue({
      title: "title",
      body: "body",
      labels: ["dotfiles-feedback"],
    });
    ok(!result.ok);
    strictEqual(result.error, expected);
    strictEqual(result.permanent, permanent);
    const listed = await gh.findIssueById(id, now.toISOString(), now);
    ok(!listed.ok);
    strictEqual(listed.permanent, false);
  });
it("gh: partial pagination and malformed data never become an empty success", async () => {
  const { fake, gh } = fixture();
  fake.intercept = async () => ({
    code: 1,
    stdout: '{"number":1}\n',
    stderr: "connection lost",
  });
  ok(!(await gh.findIssueById(id, now.toISOString(), now)).ok);
  for (const stdout of ["{", "null", '{"number":1}']) {
    fake.intercept = async () => ({ code: 0, stdout, stderr: "" });
    ok(!(await gh.findIssueById(id, now.toISOString(), now)).ok);
  }
});
it("gh: timeout is bounded per call and messages are truncated before stripping", async () => {
  const fake = fakeGh();
  const gh = openGh(
    { home: "/h", repo: FEEDBACK_REPO, runGh: fake.run },
    () => 123,
  );
  fake.intercept = async () => ({
    code: 1,
    stdout: "",
    stderr: "\u0000\u200b" + "x".repeat(210),
  });
  const result = await gh.checkDestination();
  ok(!result.ok);
  strictEqual(result.message, "x".repeat(198));
  strictEqual(fake.calls[0]!.options.timeoutMs, 123);
});

// plan-3 T2: 受け取りと振り分けの gh 呼び出し
const marked = `<!-- dotfiles-feedback id=${id} v=1 {"kind":"bug","target":"hook","source":{"agent":"claude","repoKey":null,"host":"h","vm":false}} -->`;
const rawIssue = {
  number: 7,
  state: "open",
  body: marked,
  user: "berlysia",
  pull_request: false,
  title: "題",
  updatedAt: "2026-10-29T01:00:00Z",
  labels: ["dotfiles-feedback"],
};
it("gh: read calls pass --method GET and lists paginate", async () => {
  const { fake, gh } = fixture();
  fake.issues.push({ ...rawIssue });
  ok((await gh.viewFeedbackIssue(7)).ok);
  ok((await gh.listComments(7)).ok);
  ok((await gh.listPublicIssues("2026-10-29T00:00:00Z")).ok);
  ok(
    (
      await gh.listFeedbackIssues({
        repo: FEEDBACK_REPO,
        state: "open",
        creator: "berlysia",
      })
    ).ok,
  );
  const [view, comments, publics, list] = fake.calls.map((call) => call.argv);
  for (const argv of [view!, comments!, publics!, list!])
    deepStrictEqual(argv.slice(0, 3), ["api", "--method", "GET"]);
  ok(!view!.includes("--paginate"));
  for (const argv of [comments!, publics!, list!])
    ok(argv.includes("--paginate"));
  ok(view!.includes(`repos/${FEEDBACK_REPO}/issues/7`));
  ok(comments!.includes(`repos/${FEEDBACK_REPO}/issues/7/comments`));
  ok(publics!.includes("repos/berlysia/dotfiles/issues"));
  for (const value of [
    "state=all",
    "creator=berlysia",
    "since=2026-10-29T00:00:00Z",
  ])
    strictEqual(publics![publics!.indexOf(value) - 1], "-f");
});
it("gh: argument validation fails without calling gh", async () => {
  const { fake, gh } = fixture();
  for (const number of [0, -1, 1.5, 2 ** 53]) {
    ok(!(await gh.viewFeedbackIssue(number)).ok);
    ok(!(await gh.listComments(number)).ok);
    ok(!(await gh.addComment(number, "x")).ok);
    ok(!(await gh.closeIssue(number)).ok);
    ok(!(await gh.addLabel(number, "triaged:plan")).ok);
  }
  ok(!(await gh.listPublicIssues("2026-10-29")).ok);
  ok(!(await gh.listPublicIssues("2026-10-29T00:00:00+09:00")).ok);
  ok(!(await gh.addLabel(1, "kind:bug")).ok);
  ok(!(await gh.addLabel(1, "--repo=x")).ok);
  strictEqual(fake.calls.length, 0);
});
it("gh: write calls use fixed argv; bodies go through stdin", async () => {
  const { fake, gh } = fixture();
  fake.issues.push({ ...rawIssue });
  ok((await gh.addLabel(7, "triaged:plan")).ok);
  ok((await gh.addComment(7, "コメント本文 -F x")).ok);
  ok((await gh.closeIssue(7)).ok);
  const [label, comment, close] = fake.calls;
  deepStrictEqual(label!.argv, [
    "issue",
    "edit",
    "7",
    "--repo",
    FEEDBACK_REPO,
    "--add-label=triaged:plan",
  ]);
  deepStrictEqual(comment!.argv, [
    "issue",
    "comment",
    "7",
    "--repo",
    FEEDBACK_REPO,
    "--body-file",
    "-",
  ]);
  strictEqual(comment!.options.stdin, "コメント本文 -F x");
  deepStrictEqual(close!.argv, [
    "issue",
    "close",
    "7",
    "--repo",
    FEEDBACK_REPO,
  ]);
  strictEqual(fake.issues[0]!.state, "closed");
});
it("gh: public issue creation checks the returned URL and keeps the title one argument", async () => {
  const { fake, gh } = fixture();
  const created = await gh.createPublicIssue("--repo=x", "本文 -F y");
  ok(created.ok);
  strictEqual(created.value, 1);
  const call = fake.calls[0]!;
  deepStrictEqual(call.argv, [
    "issue",
    "create",
    "--repo",
    "berlysia/dotfiles",
    "--title=--repo=x",
    "--body-file",
    "-",
  ]);
  strictEqual(call.options.stdin, "本文 -F y");
  ok(!call.argv.includes("本文 -F y"));
  fake.intercept = async () => ({
    code: 0,
    stdout: "https://github.com/other/x/issues/3\n",
    stderr: "",
  });
  ok(!(await gh.createPublicIssue("t", "b")).ok);
  fake.intercept = async () => ({
    code: 0,
    stdout: "https://github.com/berlysia/dotfiles/issues/12\n",
    stderr: "",
  });
  const twelve = await gh.createPublicIssue("t", "b");
  ok(twelve.ok);
  strictEqual(twelve.value, 12);
});
it("gh: public listing drops other users and pull requests", async () => {
  const { fake, gh } = fixture();
  fake.publicIssues.push(
    { ...rawIssue, number: 1 },
    { ...rawIssue, number: 2, user: "other" },
    { ...rawIssue, number: 3, pull_request: true },
  );
  const listed = await gh.listPublicIssues("2026-10-29T00:00:00Z");
  ok(listed.ok);
  deepStrictEqual(
    listed.value.map((issue) => issue.number),
    [1],
  );
});
it("gh: viewFeedbackIssue reads every field and reports pull requests", async () => {
  const { fake, gh } = fixture();
  fake.issues.push(
    { ...rawIssue },
    { ...rawIssue, number: 8, pull_request: true },
  );
  const viewed = await gh.viewFeedbackIssue(7);
  ok(viewed.ok);
  strictEqual(viewed.value.number, 7);
  strictEqual(viewed.value.state, "open");
  strictEqual(viewed.value.title, "題");
  strictEqual(viewed.value.user, "berlysia");
  strictEqual(viewed.value.updatedAt, "2026-10-29T01:00:00Z");
  deepStrictEqual(viewed.value.labels, ["dotfiles-feedback"]);
  strictEqual(viewed.value.pullRequest, false);
  strictEqual(viewed.value.marker.status, "ok");
  const pull = await gh.viewFeedbackIssue(8);
  ok(pull.ok);
  strictEqual(pull.value.pullRequest, true);
  ok(!(await gh.viewFeedbackIssue(99)).ok);
});
it("gh: listFeedbackIssues returns title, updatedAt and labels", async () => {
  const { fake, gh } = fixture();
  fake.issues.push({ ...rawIssue });
  const listed = await gh.listFeedbackIssues({
    repo: FEEDBACK_REPO,
    state: "all",
    creator: "berlysia",
  });
  ok(listed.ok);
  strictEqual(listed.value[0]!.title, "題");
  strictEqual(listed.value[0]!.updatedAt, "2026-10-29T01:00:00Z");
  deepStrictEqual(listed.value[0]!.labels, ["dotfiles-feedback"]);
});
it("gh: listComments maps failures and broken lines", async () => {
  const { fake, gh } = fixture();
  fake.addComment(7, { body: "一つ目" });
  const listed = await gh.listComments(7);
  ok(listed.ok);
  deepStrictEqual(listed.value, [
    {
      id: 1,
      user: "berlysia",
      body: "一つ目",
      createdAt: "2026-10-29T00:00:00Z",
    },
  ]);
  fake.failWhen(
    (argv) => argv.some((value) => value.endsWith("/comments")),
    "malformed",
  );
  const broken = await gh.listComments(7);
  ok(!broken.ok);
  strictEqual(broken.error, "other");
  const missing = fixture();
  missing.fake.intercept = async () => ({
    code: 0,
    stdout: '{"id":1}\n',
    stderr: "",
  });
  ok(!(await missing.gh.listComments(7)).ok);
});
it("gh: listComments timeout is a network failure", async () => {
  const { fake, gh } = fixture();
  fake.failWhen(() => true, "timeout");
  const result = await gh.listComments(7);
  ok(!result.ok);
  strictEqual(result.error, "network");
});
