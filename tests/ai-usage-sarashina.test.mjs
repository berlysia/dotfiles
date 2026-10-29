import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

let savedKey;
beforeEach(() => {
  requests = [];
  savedKey = process.env.SARASHINA_API_KEY;
  process.env.SARASHINA_API_KEY = KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.SARASHINA_API_KEY;
  else process.env.SARASHINA_API_KEY = savedKey;
});

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
  it("no key: configured false, no request", async () => {
    for (const value of [undefined, "", "  \n"]) {
      if (value === undefined) delete process.env.SARASHINA_API_KEY;
      else process.env.SARASHINA_API_KEY = value;
      assert.deepEqual(await fetchSarashinaUsage(OPTS, `${base}/v1/models`), {
        configured: false,
      });
    }
    assert.equal(requests.length, 0);
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
      process.env.SARASHINA_API_KEY = bad;
      const error = await rejection();
      assert.equal(error.message, "invalid SARASHINA_API_KEY format");
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
    if (key !== undefined) env.SARASHINA_API_KEY = key;
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
        assert.match(seen, /invalid SARASHINA_API_KEY format/);
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
