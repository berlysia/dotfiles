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
