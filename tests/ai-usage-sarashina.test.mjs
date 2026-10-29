import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fetchSarashinaUsage } from "../home/dot_local/share/ai-usage/providers/sarashina.ts";

const main = new URL(
  "../home/dot_local/share/ai-usage/main.ts",
  import.meta.url,
).pathname;
// Low-entropy on purpose so the secret scanner does not flag the fixture.
const KEY = "fixture".repeat(3);
const OPTS = { timeoutMs: 5000, verbose: false, details: false };
const MODELS = {
  data: [{ id: "sarashina3.2-mini-thinking" }, { id: "other" }],
};

// A local stub plays api.sarashina.ai; the base URL is a function argument.
let server;
let base;
let handler;
let requests;
before(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// The key comes from opencode's stored credentials (HOME/.local/share/opencode/opencode.db).
function writeCredentialDb(home, rows, { createTable = true } = {}) {
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "opencode.db"));
  if (createTable) {
    db.exec(
      "CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)",
    );
    const insert = db.prepare(
      "INSERT INTO credential (integration_id, value, active, time_updated) VALUES (?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id ?? "sarashina",
        typeof r.value === "string" ? r.value : JSON.stringify(r.value),
        r.active ?? 1,
        r.t ?? 1,
      );
    }
  }
  db.close();
}
const keyRow = (key, extra = {}) => ({ value: { key }, ...extra });

let savedHome;
let savedKey;
let fakeHome;
beforeEach(() => {
  requests = [];
  savedHome = process.env.HOME;
  savedKey = process.env.SARASHINA_API_KEY;
  delete process.env.SARASHINA_API_KEY;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "sarashina-home-")));
  process.env.HOME = fakeHome;
  writeCredentialDb(fakeHome, [keyRow(KEY)]);
});
afterEach(() => {
  process.env.HOME = savedHome;
  if (savedKey === undefined) delete process.env.SARASHINA_API_KEY;
  else process.env.SARASHINA_API_KEY = savedKey;
  rmSync(fakeHome, { recursive: true, force: true });
});
const resetDb = (rows, opts) => {
  rmSync(join(fakeHome, ".local", "share", "opencode"), {
    recursive: true,
    force: true,
  });
  writeCredentialDb(fakeHome, rows, opts);
};

const json =
  (status, body, headers = {}) =>
  (req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
const rejection = async (opts = OPTS, url = `${base}/v1/models`) => {
  try {
    await fetchSarashinaUsage(opts, url);
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
};

describe("fetchSarashinaUsage", () => {
  it("no usable key: configured false, no request", async () => {
    const cases = [
      [],
      [keyRow(KEY, { active: 0 })],
      [{ value: "not json" }],
      [{ value: { key: 7 } }],
      [{ id: "other", value: { key: KEY } }],
    ];
    for (const rows of cases) {
      resetDb(rows);
      assert.deepEqual(await fetchSarashinaUsage(OPTS, `${base}/v1/models`), {
        configured: false,
      });
    }
    rmSync(join(fakeHome, ".local"), { recursive: true });
    assert.deepEqual(await fetchSarashinaUsage(OPTS, `${base}/v1/models`), {
      configured: false,
    });
    assert.equal(requests.length, 0);
  });

  it("the env SARASHINA_API_KEY is not read", async () => {
    resetDb([]);
    process.env.SARASHINA_API_KEY = KEY;
    assert.deepEqual(await fetchSarashinaUsage(OPTS, `${base}/v1/models`), {
      configured: false,
    });
    assert.equal(requests.length, 0);
  });

  it("the newest active row wins", async () => {
    resetDb([keyRow("old" + KEY, { t: 1 }), keyRow("new" + KEY, { t: 3 })]);
    handler = json(200, MODELS);
    await fetchSarashinaUsage(OPTS, `${base}/v1/models`);
    assert.equal(requests[0].auth, `Bearer new${KEY}`);
  });

  it("a credential table that is missing is a fixed-message failure", async () => {
    resetDb([], { createTable: false });
    const error = await rejection();
    assert.equal(error.message, "opencode credential store unreadable");
    assert.equal(error.message.includes(fakeHome), false);
  });

  it("an unusable value never appears in an error", async () => {
    resetDb([{ value: "secret-not-json" }]);
    assert.deepEqual(await fetchSarashinaUsage(OPTS, base), {
      configured: false,
    });
  });

  it("200: sends the key as a bearer and reports whether the model is listed", async () => {
    handler = json(200, MODELS);
    assert.deepEqual(await fetchSarashinaUsage(OPTS, `${base}/v1/models`), {
      configured: true,
      status: 200,
      hasModel: true,
    });
    assert.equal(requests[0].auth, `Bearer ${KEY}`);
    for (const data of [
      [{ id: "sarashina3.2-mini-thinking-x" }],
      [{ id: "Sarashina3.2-mini-thinking" }],
      [],
    ]) {
      handler = json(200, { data });
      const r = await fetchSarashinaUsage(OPTS, `${base}/v1/models`);
      assert.equal(r.hasModel, false);
    }
    handler = json(200, { data: "x" });
    assert.equal((await fetchSarashinaUsage(OPTS, base)).hasModel, false);
  });

  it("the payload never carries the key", async () => {
    handler = json(200, MODELS);
    const r = await fetchSarashinaUsage(OPTS, `${base}/v1/models`);
    assert.equal(JSON.stringify(r).includes(KEY), false);
  });

  it("429: Retry-After only as a whole number of seconds in 0..86400", async () => {
    const retry = async (value) => {
      handler = json(429, {}, value === null ? {} : { "retry-after": value });
      return (await fetchSarashinaUsage(OPTS, base)).retryAfter;
    };
    assert.equal(await retry("12"), 12);
    assert.equal(await retry("0"), 0);
    assert.equal(await retry("86400"), 86_400);
    for (const bad of [
      "-1",
      "1e9",
      "99999999999",
      "86401",
      "1.5",
      "Wed, 21 Oct 2026 07:28:00 GMT",
      "",
      null,
    ]) {
      assert.equal(await retry(bad), null, String(bad));
    }
    handler = json(429, {});
    const r = await fetchSarashinaUsage(OPTS, base);
    assert.equal(r.status, 429);
    assert.equal(r.configured, true);
  });

  it("other statuses throw a message without the body", async () => {
    for (const status of [401, 403, 500]) {
      handler = json(status, "secret-body");
      const error = await rejection();
      assert.equal(error.message, `sarashina HTTP ${status}`);
      assert.equal(error.message.includes("secret-body"), false);
    }
  });

  it("connection refused: the error name only", async () => {
    const error = await rejection(OPTS, "http://127.0.0.1:1/v1/models");
    assert.equal(error.message, "sarashina request failed: TypeError");
  });

  it("timeout: TimeoutError", async () => {
    handler = () => {};
    const error = await rejection({ ...OPTS, timeoutMs: 200 });
    assert.equal(error.message, "sarashina request failed: TimeoutError");
  });

  it("a redirect is not followed", async () => {
    const hits = [];
    const target = createServer((req, res) => {
      hits.push(req.headers.authorization);
      res.end("{}");
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    try {
      const to = `http://127.0.0.1:${target.address().port}/steal`;
      handler = (req, res) => {
        res.writeHead(302, { location: to });
        res.end();
      };
      const error = await rejection();
      assert.match(error.message, /^sarashina request failed: /);
      assert.deepEqual(hits, []);
    } finally {
      target.close();
    }
  });

  it("an oversized body is rejected, with and without Content-Length", async () => {
    const big = JSON.stringify({ data: [], pad: "x".repeat(2 * 1024 * 1024) });
    handler = json(200, big);
    assert.equal((await rejection()).message, "sarashina invalid response");
    handler = (req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      const chunk = "x".repeat(256 * 1024);
      let sent = 0;
      const write = () => {
        if (res.destroyed || sent >= 12) return res.end();
        sent += 1;
        res.write(chunk, write);
      };
      write();
    };
    assert.equal((await rejection()).message, "sarashina invalid response");
  });

  it("a body that is not JSON", async () => {
    handler = json(200, "<html>");
    assert.equal((await rejection()).message, "sarashina invalid response");
  });

  it("a key with a bad shape is refused without being quoted", async () => {
    handler = json(200, MODELS);
    for (const bad of [
      "k\nsecret",
      "k\tsecret",
      "k secret",
      "kあsecret",
      "x".repeat(513),
    ]) {
      resetDb([keyRow(bad)]);
      const error = await rejection();
      assert.equal(error.message, "invalid sarashina credential format");
      assert.equal(error.message.includes("secret"), false);
    }
    assert.equal(requests.length, 0);
  });
});

describe("ai-usage process: the key never leaves through output", () => {
  let home;
  before(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ai-usage-sarashina-")));
  });
  after(() => rmSync(home, { recursive: true }));

  // Only keys that fail the shape check are used: a valid key would make the
  // process call the real api.sarashina.ai.
  const run = (args, key) => {
    const env = { PATH: process.env.PATH, HOME: home };
    rmSync(join(home, ".local"), { recursive: true, force: true });
    if (key !== undefined) writeCredentialDb(home, [keyRow(key)]);
    return spawnSync(process.execPath, [main, ...args], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
  };
  const keys = ["k\nsecret", "k\tsecret", `secret${"x".repeat(520)}`];

  for (const args of [["sarashina", "--summary"], ["sarashina"]]) {
    it(`ai-usage ${args.join(" ")}`, () => {
      for (const key of keys) {
        const r = run(args, key);
        assert.equal(r.status, 1);
        const seen = `${r.stdout}\n${r.stderr}`;
        assert.equal(seen.includes("secret"), false, seen);
        assert.match(seen, /invalid sarashina credential format/);
      }
    });
  }

  it("ai-usage with no provider", () => {
    for (const key of keys) {
      const r = run(["--timeout", "3"], key);
      const seen = `${r.stdout}\n${r.stderr}`;
      assert.equal(seen.includes("secret"), false, seen);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.providers.sarashina.ok, false);
    }
  });

  it("a stored key never reaches output", () => {
    const r = run(["sarashina"], "k\nsecret");
    assert.equal(`${r.stdout}${r.stderr}`.includes("secret"), false);
  });

  it("no key: ok, exit 0, no windows and no unmetered", () => {
    const r = run(["sarashina", "--summary"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).providers.sarashina, {
      ok: true,
      fiveHour: null,
      weekly: null,
      exhausted: false,
    });
    const bare = run(["sarashina"]);
    assert.equal(bare.status, 0);
    assert.deepEqual(JSON.parse(bare.stdout), { configured: false });
  });

  it("a key-less ai-usage with every provider: sarashina is not the failure", () => {
    const r = run(["--summary", "--timeout", "3"]);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.providers.sarashina.ok, true);
    assert.doesNotMatch(r.stderr, /ai-usage: sarashina:/);
  });
});
