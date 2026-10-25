import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import {
  drainInbox,
  writeInboxRequest,
} from "../../lib/agent-learnings/core/inbox.ts";
import {
  initStore,
  readLearnings,
  storePaths,
} from "../../lib/agent-learnings/core/store.ts";

async function withStore(fn: (store: string) => Promise<void>): Promise<void> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-learnings-inbox-")),
  );
  try {
    const store = join(root, "agent-learnings");
    initStore(store, runGit);
    await fn(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const KEY = "github.com/foo/bar";

describe("inbox", () => {
  it("writes a request that drain applies and commits", () =>
    withStore(async (store) => {
      const id = writeInboxRequest(
        store,
        {
          op: "add",
          repoKey: KEY,
          title: "t",
          body: "codex で知った",
          reader: "codex",
        },
        new Date("2026-10-15T00:00:00Z"),
      );
      ok(/^R-[0-9a-f]{12}$/.test(id));
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.applied, 1);
      const file = readLearnings(store, KEY);
      ok(file.ok && file.value.entries[0]?.body === "codex で知った");
      strictEqual(readdirSync(storePaths(store).inbox).length, 0);
    }));
  it("moves invalid requests to rejected and never allows URLs", () =>
    withStore(async (store) => {
      writeInboxRequest(
        store,
        {
          op: "add",
          repoKey: KEY,
          title: "t",
          body: "https://e.com",
          reader: "codex",
        },
        new Date(),
      );
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.rejected, 1);
      strictEqual(
        readdirSync(storePaths(store).rejected).filter((n) =>
          n.endsWith(".json"),
        ).length,
        1,
      );
    }));
  it("rejects requests whose repoKey fails the charset check, and records the reason", () =>
    withStore(async (store) => {
      writeInboxRequest(
        store,
        { op: "add", repoKey: "../x", title: "t", body: "b", reader: "codex" },
        new Date(),
      );
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.rejected, 1);
      ok(
        readFileSync(
          join(storePaths(store).rejected, "reasons.log"),
          "utf8",
        ).includes('"reason":"invalid repoKey"'),
      );
    }));
  it("rejects forged requestId or reader, keeps unknown schemaVersion in the inbox", () =>
    withStore(async (store) => {
      const { inbox } = storePaths(store);
      writeFileSync(
        join(inbox, "1-R-000000000001.json"),
        JSON.stringify({
          schemaVersion: 1,
          requestId: "R-zzz",
          requestedAt: "x",
          op: "add",
          repoKey: KEY,
          title: "t",
          body: "b",
          reader: "codex",
        }),
      );
      writeFileSync(
        join(inbox, "2-R-000000000002.json"),
        JSON.stringify({
          schemaVersion: 1,
          requestId: "R-000000000002",
          requestedAt: "x",
          op: "add",
          repoKey: KEY,
          title: "t",
          body: "b",
          reader: "evil\nx",
        }),
      );
      writeFileSync(
        join(inbox, "3-R-000000000003.json"),
        JSON.stringify({ schemaVersion: 2, requestId: "R-000000000003" }),
      );
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.rejected, 2);
      strictEqual(r.unknownVersion, 1);
      ok(existsSync(join(inbox, "3-R-000000000003.json")));
    }));
  it("ignores names that are not request files, such as temp files", () =>
    withStore(async (store) => {
      writeFileSync(
        join(storePaths(store).inbox, "5-R-000000000005.json.tmp.123"),
        "{",
      );
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.rejected, 0);
    }));
  it("refuses to run when inbox is a symlink, leaving the target untouched", () =>
    withStore(async (store) => {
      const { inbox } = storePaths(store);
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), "agent-learnings-outside-")),
      );
      try {
        writeFileSync(join(outside, "9-R-000000000009.json"), "not json");
        rmSync(inbox, { recursive: true });
        symlinkSync(outside, inbox);
        const r = await drainInbox(store, {
          today: "2026-10-15",
          runGit,
          waitMs: 0,
          extraRedact: [],
        });
        strictEqual(r.unsafe, true);
        ok(existsSync(join(outside, "9-R-000000000009.json")));
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }));
  it("rejects a FIFO and an oversized file without blocking", () =>
    withStore(async (store) => {
      const { inbox } = storePaths(store);
      execFileSync("mkfifo", [join(inbox, "6-R-000000000006.json")]);
      writeFileSync(join(inbox, "7-R-000000000007.json"), "x".repeat(9000));
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.rejected, 2);
    }));
  it("does not let unknown-version files starve valid requests", () =>
    withStore(async (store) => {
      const { inbox } = storePaths(store);
      for (let i = 0; i < 51; i++) {
        const id = `R-${i.toString(16).padStart(12, "0")}`;
        writeFileSync(
          join(inbox, `0${i.toString().padStart(3, "0")}-${id}.json`),
          JSON.stringify({ schemaVersion: 2, requestId: id }),
        );
      }
      writeInboxRequest(
        store,
        { op: "add", repoKey: KEY, title: "valid", body: "b", reader: "codex" },
        new Date(9_999),
      );
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.applied, 1);
      strictEqual(r.unknownVersion, 51);
    }));
  it("processes at most 50 requests per drain", () =>
    withStore(async (store) => {
      for (let i = 0; i < 55; i++) {
        writeInboxRequest(
          store,
          {
            op: "add",
            repoKey: KEY,
            title: `t${i}`,
            body: "b",
            reader: "codex",
          },
          new Date(1_000 + i),
        );
      }
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.applied, 50);
      strictEqual(readdirSync(storePaths(store).inbox).length, 5);
    }));
  it("applies a remove request", () =>
    withStore(async (store) => {
      writeInboxRequest(
        store,
        { op: "add", repoKey: KEY, title: "t", body: "b", reader: "codex" },
        new Date(1),
      );
      await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      const file = readLearnings(store, KEY);
      ok(file.ok);
      const id = file.value.entries[0]?.id ?? "";
      writeInboxRequest(
        store,
        { op: "remove", repoKey: KEY, id, reader: "codex" },
        new Date(2),
      );
      const r = await drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
      strictEqual(r.applied, 1);
    }));
  describe("on", () => {
    const drain = (store: string) =>
      drainInbox(store, {
        today: "2026-10-15",
        runGit,
        waitMs: 0,
        extraRedact: [],
      });
    const send = (store: string, on?: string[]) =>
      writeInboxRequest(
        store,
        {
          op: "add",
          repoKey: KEY,
          title: "t",
          body: "b",
          reader: "codex",
          ...(on === undefined ? {} : { on }),
        },
        new Date(),
      );
    const reasons = (store: string): string =>
      readFileSync(join(storePaths(store).rejected, "reasons.log"), "utf8");
    const entries = (store: string) => {
      const file = readLearnings(store, KEY);
      ok(file.ok);
      return file.value.entries;
    };

    it("takes a request with a two-word cmd", () =>
      withStore(async (store) => {
        send(store, ["cmd:git commit"]);
        strictEqual((await drain(store)).applied, 1);
        deepStrictEqual(entries(store)[0]?.extra, [["on", "cmd:git commit"]]);
      }));
    it("takes a request with a broad on and records it in the commit body", () =>
      withStore(async (store) => {
        send(store, ["path:vite.config.ts", "cmd:git"]);
        strictEqual((await drain(store)).applied, 1);
        deepStrictEqual(entries(store)[0]?.extra, [
          ["on", "path:vite.config.ts/,cmd:git"],
        ]);
        const body = execFileSync(
          "git",
          ["-C", store, "log", "-1", "--format=%B"],
          {
            encoding: "utf8",
          },
        );
        ok(body.includes("on: path:vite.config.ts/,cmd:git"), body);
      }));
    it("never writes the value of a bad on into reasons.log", () =>
      withStore(async (store) => {
        send(store, ["\u001b[31mx"]);
        strictEqual((await drain(store)).rejected, 1);
        const log = reasons(store);
        ok(log.includes("bad-grammar"));
        ok(!log.includes("31mx") && !log.includes("u001b"));
      }));
    it("still takes a request without on", () =>
      withStore(async (store) => {
        send(store);
        strictEqual((await drain(store)).applied, 1);
        deepStrictEqual(entries(store)[0]?.extra, []);
      }));
  });
});
