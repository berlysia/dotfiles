import { deepStrictEqual, ok, strictEqual } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { renderIssue } from "../../lib/dotfiles-feedback/issue-body.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";
import { FEEDBACK_REPO } from "../../lib/dotfiles-feedback/constants.ts";
import { resolveTarget } from "../../lib/dotfiles-feedback/target.ts";
import {
  fakeGh,
  type FakeIssue,
} from "../support/dotfiles-feedback-fake-gh.ts";

const now = new Date("2026-10-29T10:00:00Z");
const id = (index = 0) =>
  `20261029T010203Z-${index.toString(16).padStart(12, "0")}`;
const vmId = "vm-0123456789abcdef01234567";
function item(key: string): FeedbackItemV1 {
  return {
    schemaVersion: 1,
    id: key,
    createdAt: "2026-10-29T01:02:03Z",
    title: "title",
    target: "target",
    kind: "bug",
    body: "body",
    source: {
      agent: "human",
      repoKey: null,
      host: "host",
      vm: key.startsWith("vm-"),
    },
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
async function fixture(
  run: (ctx: {
    root: string;
    fake: ReturnType<typeof fakeGh>;
    deps: Parameters<typeof resolveTarget>[1];
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(join(import.meta.dirname, ".feedback-target-"));
  const fake = fakeGh();
  const deps = {
    root,
    home: "/h",
    repo: FEEDBACK_REPO,
    runGh: fake.run,
    fs,
    uid: (await fs.lstat(root)).uid,
    now: () => now,
    pid: 1,
    randomBytes: (size: number) => new Uint8Array(size).fill(1),
    isPidAlive: () => true,
    getPidStartTime: async () => "s",
  };
  try {
    await run({ root, fake, deps });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const argvs = (fake: ReturnType<typeof fakeGh>) =>
  fake.calls.map((c) => c.argv.join(" "));

it("target: #N views that issue", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(7, id(1)));
    const r = await resolveTarget("#7", deps);
    strictEqual(r.kind, "issue");
    if (r.kind === "issue") strictEqual(r.issue.number, 7);
    ok(argvs(fake)[0]!.includes("issues/7"));
  }));
for (const arg of ["#0", "#1x", "abc", "#", "#-1", "7"])
  it(`target: ${arg} is a format error without gh`, () =>
    fixture(async ({ fake, deps }) => {
      strictEqual((await resolveTarget(arg, deps)).kind, "invalid");
      strictEqual(fake.calls.length, 0);
    }));
for (const place of ["pending", "held", "failed"] as const)
  it(`target: id only in ${place}/ is a local item`, () =>
    fixture(async ({ root, fake, deps }) => {
      const { openSpool } =
        await import("../../lib/dotfiles-feedback/spool.ts");
      await openSpool(root, deps);
      await fs.writeFile(join(root, place, `${id(1)}.json`), "{}");
      deepStrictEqual(await resolveTarget(id(1), deps), {
        kind: "local",
        id: id(1),
        place,
      });
      strictEqual(fake.calls.length, 0);
    }));
it("target: sent.jsonl number is opened directly without listing", () =>
  fixture(async ({ root, fake, deps }) => {
    const { openSpool } = await import("../../lib/dotfiles-feedback/spool.ts");
    await openSpool(root, deps);
    fake.issues.push(issue(1, id(9)), issue(5, id(1)));
    await fs.writeFile(
      join(root, "sent.jsonl"),
      `${JSON.stringify({ v: 1, id: id(1), issue: 5, at: now.toISOString() })}\n`,
    );
    const r = await resolveTarget(id(1), deps);
    strictEqual(r.kind, "issue");
    if (r.kind === "issue") strictEqual(r.issue.number, 5);
    strictEqual(fake.calls.length, 1);
  }));
for (const [name, bad] of [
  ["404", null],
  ["pull request", { pull_request: true }],
  ["other user", { user: "other" }],
  ["no label", { labels: [] }],
  ["different id", "other-id"],
] as const)
  it(`target: sent number that is ${name} falls back to the listing`, () =>
    fixture(async ({ root, fake, deps }) => {
      const { openSpool } =
        await import("../../lib/dotfiles-feedback/spool.ts");
      await openSpool(root, deps);
      if (bad === "other-id") fake.issues.push(issue(5, id(8)));
      else if (bad) fake.issues.push(issue(5, id(1), bad));
      fake.issues.push(issue(9, id(1)));
      await fs.writeFile(
        join(root, "sent.jsonl"),
        `${JSON.stringify({ v: 1, id: id(1), issue: 5, at: now.toISOString() })}\n`,
      );
      const r = await resolveTarget(id(1), deps);
      strictEqual(r.kind, "issue");
      if (r.kind === "issue") strictEqual(r.issue.number, 9);
      ok(argvs(fake).some((a) => a.includes("state=all")));
    }));
it("target: list narrows by id time minus one day; vm ids have no since", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(3, id(1)), issue(4, vmId));
    await resolveTarget(id(1), deps);
    ok(argvs(fake)[0]!.includes("since=2026-10-28T01:02:03Z"));
    fake.calls.length = 0;
    const r = await resolveTarget(vmId, deps);
    strictEqual(r.kind, "issue");
    ok(!argvs(fake)[0]!.includes("since="));
  }));
it("target: an id with an impossible date is a format error without gh", () =>
  fixture(async ({ fake, deps }) => {
    strictEqual(
      (await resolveTarget("20261329T010203Z-000000000001", deps)).kind,
      "invalid",
    );
    strictEqual(
      (await resolveTarget("20261029T250203Z-000000000001", deps)).kind,
      "invalid",
    );
    strictEqual(fake.calls.length, 0);
  }));
it("target: two target issues with the same id are refused with both numbers", () =>
  fixture(async ({ fake, deps }) => {
    fake.issues.push(issue(3, id(1)), issue(9, id(1)), issue(4, id(2)));
    deepStrictEqual(await resolveTarget(id(1), deps), {
      kind: "ambiguous",
      numbers: [3, 9],
    });
  }));
it("target: unknown id is not-found; listing timeout is a network failure with a hint", () =>
  fixture(async ({ fake, deps }) => {
    strictEqual((await resolveTarget(id(1), deps)).kind, "not-found");
    fake.failWhen((argv) => argv.some((a) => a === "state=all"), "timeout");
    const r = await resolveTarget(id(1), deps);
    strictEqual(r.kind, "gh-failed");
    if (r.kind === "gh-failed") {
      strictEqual(r.error, "network");
      ok(r.hint.includes("#番号"));
    }
  }));
