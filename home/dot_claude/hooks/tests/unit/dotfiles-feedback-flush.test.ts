import { deepStrictEqual, strictEqual, ok, rejects } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { flush, type FlushDeps } from "../../lib/dotfiles-feedback/flush.ts";
import { openSpool } from "../../lib/dotfiles-feedback/spool.ts";
import { openRetry } from "../../lib/dotfiles-feedback/retry.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";
import {
  FEEDBACK_LABELS,
  FEEDBACK_REPO,
  ITEM_DEADLINE_MS,
} from "../../lib/dotfiles-feedback/constants.ts";
import { fakeGh } from "../support/dotfiles-feedback-fake-gh.ts";
const start = Date.parse("2026-10-29T10:00:00Z");
function item(index = 0): FeedbackItemV1 {
  return {
    schemaVersion: 1,
    id: `20261029T100000Z-${index.toString(16).padStart(12, "0")}`,
    createdAt: "2026-10-29T10:00:00Z",
    title: "title",
    target: "target",
    kind: "bug",
    body: "body",
    source: { agent: "human", repoKey: null, host: "host", vm: false },
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(join(import.meta.dirname, ".feedback-flush-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = fakeGh();
  let clock = start,
    counter = 0,
    spawned = 0;
  const deps: FlushDeps = {
    root,
    home: "/passwd/home",
    fs,
    uid: (await fs.lstat(root)).uid,
    repo: FEEDBACK_REPO,
    runGh: fake.run,
    spawnFlush: async () => {
      spawned++;
      return true;
    },
    now: () => new Date(clock),
    pid: 10,
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    isPidAlive: () => true,
    getPidStartTime: async () => "start",
  };
  const spool = await openSpool(root, deps);
  const retry = openRetry(root, deps);
  return {
    root,
    deps,
    fake,
    spool,
    retry,
    advance: (ms: number) => {
      clock += ms;
    },
    spawned: () => spawned,
    names: (dir: string) => fs.readdir(join(root, dir)),
    read: async (path: string) =>
      JSON.parse(await fs.readFile(join(root, path), "utf8")),
    seed: async (count = 1) => {
      for (let i = 0; i < count; i++)
        await spool.writePending(item(i), { origin: "local" });
    },
  };
}
it("flush: empty pending does not call gh", async (t) => {
  const f = await fixture(t);
  await flush(f.deps);
  strictEqual(f.fake.calls.length, 0);
  deepStrictEqual(await f.names("state"), []);
});
it("flush: sends three items and clears prior error cache", async (t) => {
  const f = await fixture(t);
  await f.seed(3);
  await fs.writeFile(join(f.root, "state/last-flush.json"), "{}");
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 3);
  deepStrictEqual(await f.names("pending"), []);
  deepStrictEqual(await f.names("sending"), []);
  strictEqual(
    (await fs.readFile(join(f.root, "sent.jsonl"), "utf8")).trim().split("\n")
      .length,
    3,
  );
  ok(!(await f.names("state")).includes("last-flush.json"));
});
it("flush: dead leftover lock and eleven-minute-old claim recover without duplicate", async (t) => {
  const f = await fixture(t);
  await f.seed();
  const realUnlink = fs.unlink;
  f.deps.fs = {
    ...fs,
    unlink: async (path) => {
      if (path.endsWith("/state/flush.lock")) return;
      return realUnlink(path);
    },
    open: async (path, flags, mode) => {
      if (path.endsWith("/sent.jsonl"))
        throw new Error("simulated crash before markSent");
      return fs.open(path, flags, mode);
    },
  };
  await rejects(flush(f.deps), /simulated crash/);
  strictEqual(f.fake.issues.length, 1);
  ok((await f.names("state")).includes("flush.lock"));
  f.advance(11 * 60000);
  f.deps.pid = 11;
  f.deps.isPidAlive = (pid) => pid !== 10;
  f.deps.fs = fs;
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 1);
  strictEqual(
    f.fake.calls.filter((call) => call.argv[0] === "issue").length,
    1,
  );
  deepStrictEqual(await f.names("sending"), []);
  ok(
    (await fs.readFile(join(f.root, "sent.jsonl"), "utf8")).includes(
      '"issue":1',
    ),
  );
});
it("flush: future versions are held with no gh or handoff", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    join(f.root, "pending", `${item().id}.json`),
    JSON.stringify({ ...item(), schemaVersion: 2 }),
  );
  await flush(f.deps);
  strictEqual((await f.names("held")).length, 1);
  strictEqual(f.fake.calls.length, 0);
  strictEqual(f.spawned(), 0);
});
it("flush: two lock owners still claim an item only once", async (t) => {
  const f = await fixture(t);
  await f.seed();
  // Redirect each owner's flush lock while retaining real shared spool/retry operations.
  const owner = (pid: number): FlushDeps => ({
    ...f.deps,
    pid,
    fs: {
      ...fs,
      open: (path, flags, mode) =>
        fs.open(
          path.endsWith("/flush.lock") ? `${path}.${pid}` : path,
          flags,
          mode,
        ),
      readFile: (path, encoding) =>
        fs.readFile(
          path.endsWith("/flush.lock") ? `${path}.${pid}` : path,
          encoding,
        ),
      unlink: (path) =>
        fs.unlink(path.endsWith("/flush.lock") ? `${path}.${pid}` : path),
    },
  });
  await Promise.all([flush(owner(11)), flush(owner(12))]);
  strictEqual(f.fake.issues.length, 1);
});
it("flush: version changed after claim goes to held and resets retry", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.retry.recordFailure(item().id, f.deps.now());
  f.advance(3 * 60000);
  f.deps.fs = {
    ...fs,
    rename: async (from, to) => {
      await fs.rename(from, to);
      if (to.includes("/sending/"))
        await fs.writeFile(to, JSON.stringify({ ...item(), schemaVersion: 2 }));
    },
  };
  await flush(f.deps);
  strictEqual((await f.names("held")).length, 1);
  strictEqual(f.fake.issues.length, 0);
  strictEqual((await f.read("state/retry.json")).items[item().id], undefined);
});
it("flush: reclaiming an item preserves three previous attempts", async (t) => {
  const f = await fixture(t);
  await f.seed();
  for (let i = 0; i < 3; i++)
    await f.retry.recordFailure(item().id, f.deps.now());
  ok(await f.spool.claim(item().id));
  f.advance(11 * 60000);
  await f.spool.reclaimStale(f.deps.now());
  strictEqual((await f.read("state/retry.json")).items[item().id].attempts, 3);
});
for (const stage of ["destination", "label", "lookup", "create"] as const)
  it(`flush: twentieth transient failure at ${stage} is exhausted`, async (t) => {
    const f = await fixture(t);
    await f.seed();
    for (let i = 0; i < 19; i++)
      await f.retry.recordFailure(item().id, f.deps.now());
    f.advance(7 * 3600000);
    f.fake.intercept = async ({ argv }) =>
      (stage === "destination" && argv[0] === "repo") ||
      (stage === "label" && argv[0] === "label") ||
      (stage === "lookup" && argv.includes("--paginate")) ||
      (stage === "create" && argv[0] === "issue")
        ? { code: 1, stdout: "", stderr: "connection failed" }
        : null;
    await flush(f.deps);
    strictEqual(
      (await f.read(`failed/${item().id}.json`)).reason,
      "retries-exhausted",
    );
    deepStrictEqual(await f.names("pending"), []);
    deepStrictEqual(await f.names("sending"), []);
  });
it("flush: reclaimed claim with a new nonce cannot create", async (t) => {
  const f = await fixture(t);
  await f.seed();
  f.fake.intercept = async ({ argv }) => {
    if (argv.includes("--paginate")) {
      f.advance(11 * 60000);
      await f.spool.reclaimStale(f.deps.now());
      ok(await f.spool.claim(item().id));
    }
    return null;
  };
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 0);
  strictEqual((await f.names("sending")).length, 1);
});
it("flush: a create exceeding deadline returns item to pending", async (t) => {
  const f = await fixture(t);
  await f.seed();
  f.fake.intercept = async ({ argv }) => {
    if (argv[0] === "issue") f.advance(ITEM_DEADLINE_MS + 1);
    return null;
  };
  await flush(f.deps);
  strictEqual((await f.names("pending")).length, 1);
  strictEqual((await f.read("state/retry.json")).items[item().id].attempts, 1);
});
it("flush: each runner call gets min of remaining deadline and thirty seconds", async (t) => {
  const f = await fixture(t);
  await f.seed();
  f.fake.intercept = async ({ argv }) => {
    if (argv.includes("--paginate")) f.advance(ITEM_DEADLINE_MS - 17);
    return null;
  };
  await flush(f.deps);
  const create = f.fake.calls.find((call) => call.argv[0] === "issue");
  ok(create);
  strictEqual(create.options.timeoutMs, 17);
  ok(f.fake.calls.every((call) => call.options.timeoutMs <= 30000));
});
for (const reason of ["auth", "public", "label"] as const)
  it(`flush: ${reason} destination failure records all due items and stops`, async (t) => {
    const f = await fixture(t);
    await f.seed(3);
    if (reason === "public") f.fake.isPrivate = false;
    else
      f.fake.intercept = async ({ argv }) =>
        argv[0] === (reason === "auth" ? "api" : "label")
          ? { code: reason === "auth" ? 4 : 1, stdout: "", stderr: "failure" }
          : null;
    await flush(f.deps);
    strictEqual(f.fake.issues.length, 0);
    strictEqual((await f.names("pending")).length, 3);
    strictEqual(f.spawned(), 0);
    const ledger = await f.read("state/retry.json");
    for (let i = 0; i < 3; i++)
      strictEqual(ledger.items[item(i).id].attempts, 1);
    strictEqual(
      (await f.read("state/last-flush.json")).error,
      reason === "public"
        ? "not-private"
        : reason === "auth"
          ? "auth"
          : "other",
    );
  });
it("flush: 422 is permanent and retry state is cleared", async (t) => {
  const f = await fixture(t);
  await f.seed();
  f.fake.intercept = async ({ argv }) =>
    argv[0] === "issue" ? { code: 1, stdout: "", stderr: "HTTP 422" } : null;
  await flush(f.deps);
  strictEqual((await f.names("failed")).length, 1);
  strictEqual(await f.retry.isDue(item().id, f.deps.now()), true);
});
it("flush: manually inserted secrets fail revalidation without creating", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    join(f.root, "pending", `${item().id}.json`),
    JSON.stringify({ ...item(), body: `ghp_${"a".repeat(36)}` }),
  );
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 0);
  strictEqual(
    (await f.read(`failed/${item().id}.json`)).reason,
    "not-normalized",
  );
});
it("flush: work arriving immediately after release is sent on reacquisition", async (t) => {
  const f = await fixture(t);
  await f.seed();
  let injected = false;
  f.deps.fs = {
    ...fs,
    unlink: async (path) => {
      await fs.unlink(path);
      if (path.endsWith("/flush.lock") && !injected) {
        injected = true;
        await f.spool.writePending(item(1), { origin: "local" });
      }
    },
  };
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 2);
});
it("flush: fifteen items with zero reacquires hands off after ten", async (t) => {
  const f = await fixture(t);
  await f.seed(15);
  await flush(f.deps, { maxReacquires: 0 });
  strictEqual(f.fake.issues.length, 10);
  strictEqual((await f.names("pending")).length, 5);
  strictEqual(f.spawned(), 1);
});
for (const stage of ["due", "failure", "sort"] as const)
  it(`flush: busy retry lock during ${stage} leaves pending and releases flush lock`, async (t) => {
    const f = await fixture(t);
    await f.seed();
    const makeBusy = () =>
      fs.writeFile(
        join(f.root, "state/retry.lock"),
        JSON.stringify({
          v: 1,
          pid: 99,
          startTime: "start",
          acquiredAt: f.deps.now().toISOString(),
        }),
      );
    if (stage === "sort") {
      await fs.writeFile(
        join(f.root, "pending", `${item().id}.json`),
        JSON.stringify({ ...item(), schemaVersion: 2 }),
      );
      await makeBusy();
    } else if (stage === "due") await makeBusy();
    else
      f.fake.intercept = async ({ argv }) => {
        if (argv[0] !== "issue") return null;
        await makeBusy();
        return { code: 1, stdout: "", stderr: "connection" };
      };
    await flush(f.deps);
    ok(!(await f.names("state")).includes("flush.lock"));
    strictEqual(
      (await f.names(stage === "sort" ? "held" : "pending")).length,
      1,
    );
    deepStrictEqual(await f.names("sending"), []);
    strictEqual(f.spawned(), 0);
  });
it("flush: future retry time and live flush lock never invoke gh", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.retry.recordFailure(item().id, f.deps.now());
  await flush(f.deps);
  strictEqual(f.fake.calls.length, 0);
  f.advance(5 * 60000);
  await fs.writeFile(
    join(f.root, "state/flush.lock"),
    JSON.stringify({
      v: 1,
      pid: 10,
      startTime: "start",
      acquiredAt: f.deps.now().toISOString(),
    }),
  );
  await flush(f.deps);
  strictEqual(f.fake.calls.length, 0);
});
it("flush: one successful delivery clears cache even with a later transient error", async (t) => {
  const f = await fixture(t);
  await f.seed(2);
  f.fake.intercept = async ({ argv }) =>
    argv[0] === "issue" && f.fake.issues.length === 1
      ? { code: 1, stdout: "", stderr: "connection" }
      : null;
  await fs.writeFile(join(f.root, "state/last-flush.json"), "{}");
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 1);
  ok(!(await f.names("state")).includes("last-flush.json"));
});
for (const permanent of [false, true])
  it(`flush: no delivery or transient failure preserves cache (permanent=${permanent})`, async (t) => {
    const f = await fixture(t);
    const previous = JSON.stringify({
      v: 1,
      at: "2026-10-29T09:00:00Z",
      error: "auth",
    });
    await fs.writeFile(join(f.root, "state/last-flush.json"), previous);
    if (permanent) {
      await f.seed();
      f.fake.intercept = async ({ argv }) =>
        argv[0] === "issue"
          ? { code: 1, stdout: "", stderr: "HTTP 422" }
          : null;
    }
    await flush(f.deps);
    strictEqual(
      await fs.readFile(join(f.root, "state/last-flush.json"), "utf8"),
      previous,
    );
  });

const labelCreates = (f: { fake: ReturnType<typeof fakeGh> }) =>
  f.fake.calls.filter((c) => c.argv[0] === "label").length;
const destinationChecks = (f: { fake: ReturnType<typeof fakeGh> }) =>
  f.fake.calls.filter((c) => c.argv[0] === "api" && c.argv.includes("user"))
    .length;
const labelsPath = (f: { root: string }) => join(f.root, "state/labels.json");

it("flush: without a labels record it creates the 7 labels once and records them", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await flush(f.deps);
  strictEqual(labelCreates(f), FEEDBACK_LABELS.length);
  strictEqual(FEEDBACK_LABELS.length, 7);
  deepStrictEqual(await f.read("state/labels.json"), {
    v: 1,
    repo: FEEDBACK_REPO,
    labels: [...FEEDBACK_LABELS],
  });
});

it("flush: a matching record skips label creation but still checks the destination", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await flush(f.deps);
  const before = labelCreates(f);
  await f.seed(2);
  await flush(f.deps);
  strictEqual(labelCreates(f), before);
  strictEqual(destinationChecks(f), 2);
});

it("flush: a matching record does not let a non-private destination through", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await flush(f.deps);
  const written = await fs.readFile(labelsPath(f), "utf8");
  f.fake.isPrivate = false;
  await f.seed(2);
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 1);
  strictEqual(await fs.readFile(labelsPath(f), "utf8"), written);
});

for (const [name, content] of [
  [
    "other labels",
    JSON.stringify({ v: 1, repo: FEEDBACK_REPO, labels: ["a"] }),
  ],
  [
    "other repo",
    JSON.stringify({ v: 1, repo: "x/y", labels: [...FEEDBACK_LABELS] }),
  ],
  [
    "v 2",
    JSON.stringify({ v: 2, repo: FEEDBACK_REPO, labels: [...FEEDBACK_LABELS] }),
  ],
  ["broken JSON", "{broken"],
] as const)
  it(`flush: a record with ${name} is rewritten after creating 7 labels`, async (t) => {
    const f = await fixture(t);
    await f.seed();
    await fs.writeFile(labelsPath(f), content);
    await flush(f.deps);
    strictEqual(labelCreates(f), 7);
    deepStrictEqual((await f.read("state/labels.json")).labels, [
      ...FEEDBACK_LABELS,
    ]);
  });

it("flush: a failed createIssue clears the record, so the next run prepares again", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await flush(f.deps);
  await f.seed(2);
  f.fake.failWhen(
    (argv) => argv[0] === "issue" && argv[1] === "create",
    "network",
  );
  await flush(f.deps);
  ok(!(await f.names("state")).includes("labels.json"));
  const before = labelCreates(f);
  f.advance(24 * 60 * 60 * 1000);
  await flush(f.deps);
  strictEqual(labelCreates(f), before + 7);
  // 失敗が続くあいだは回ごとに用意し直す。
  f.fake.failWhen(
    (argv) => argv[0] === "issue" && argv[1] === "create",
    "network",
  );
  await f.seed(3);
  f.advance(24 * 60 * 60 * 1000);
  await flush(f.deps);
  f.advance(24 * 60 * 60 * 1000);
  const mid = labelCreates(f);
  await flush(f.deps);
  strictEqual(labelCreates(f), mid + 7);
});

it("flush: a label failure writes no record and creates no issue", async (t) => {
  const f = await fixture(t);
  await f.seed();
  f.fake.failWhen((argv) => argv[0] === "label", "network");
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 0);
  ok(!(await f.names("state")).includes("labels.json"));
});

it("flush: a failing record write does not change the delivery result", async (t) => {
  const f = await fixture(t);
  await f.seed();
  const real = f.deps.fs;
  f.deps.fs = {
    ...real,
    rename: async (from, to) => {
      if (to.endsWith("/state/labels.json")) throw new Error("disk full");
      return real.rename(from, to);
    },
  };
  await flush(f.deps);
  strictEqual(f.fake.issues.length, 1);
  deepStrictEqual(await f.names("pending"), []);
});
