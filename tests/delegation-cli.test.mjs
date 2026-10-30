import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import {
  groupsForCell,
  lapseGroups,
} from "../home/dot_local/share/delegation/aggregate.ts";
import { captureBash } from "../home/dot_local/share/delegation/capture.ts";
import {
  appendLedger,
  createPending,
  foldLedger,
  listPending,
  openStore,
  readLedger,
  readPending,
} from "../home/dot_local/share/delegation/store.ts";
import {
  buildVerifiedRecord,
  writeVerifiedRecord,
} from "../home/dot_local/share/delegation/offload.ts";

const main = new URL(
  "../home/dot_local/share/delegation/main.ts",
  import.meta.url,
).pathname;

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delegation-cli-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const env = {
    HOME: home,
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    PATH: bin,
  };
  for (const path of [
    home,
    bin,
    ...Object.values(env).filter(
      (v) => v !== bin && v !== home && v !== env.XDG_DATA_HOME,
    ),
  ]) {
    mkdirSync(path, {
      recursive: true,
      mode: path === env.XDG_RUNTIME_DIR ? 0o700 : 0o755,
    });
  }
  const T0 = "2026-10-29T00:00:00.000Z";
  const run = (args, { input, now = T0, extraEnv = {} } = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [main, ...args], {
        env: {
          ...env,
          DELEGATION_NOW: now,
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
  const open = (payload, opts) =>
    run(["open"], { input: JSON.stringify({ v: 1, ...payload }), ...opts });
  const store = () => openStore(env, { retryDelayMs: 0 });
  return {
    root,
    env,
    run,
    open,
    store,
    done: () => rmSync(root, { recursive: true }),
  };
}

function addHostExecutable(sb, name) {
  const source = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path) && (statSync(path).mode & 0o111) !== 0);
  if (source === undefined) return false;
  accessSync(source, fsConstants.X_OK);
  symlinkSync(realpathSync(source), join(sb.env.PATH, name));
  return true;
}

function seedVerifiedOpencode(sb, models) {
  const configDir = join(sb.env.HOME, ".config", "opencode");
  const authDir = join(sb.env.HOME, ".local", "share", "opencode");
  const config = join(configDir, "opencode.jsonc");
  const executable = join(sb.env.PATH, "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  chmodSync(authDir, 0o700);
  writeFileSync(config, "{}\n");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);

  const sha256 = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const inputs = {
    realpath: realpathSync(executable),
    executableSha256: sha256(executable),
    targetSha256: {},
    configSha256: sha256(config),
    foundConfigPaths: [],
    record: { kind: "missing" },
    authFile: { kind: "missing" },
    authDb: { kind: "missing" },
    authFiles: [],
    authDir: { mode: 0o700, ownedBySelf: true, symlink: false },
  };
  const record = buildVerifiedRecord({
    inputs,
    version: "test",
    models,
    targets: [],
    now: new Date("2026-10-29T00:00:00.000Z"),
  });
  writeVerifiedRecord(sb.env, record);
}

const agent = (extra = {}) => ({
  tool: "Agent",
  tool_use_id: "tu1",
  sessionId: "s1",
  model: "sonnet",
  effort: "high",
  ...extra,
});
const ID_RE = /^d-[0-9a-f]{12}$/;
const idOf = (r) => r.stdout.trim().split(" ")[0];
const REC = ["--kind", "impl", "--size", "M", "--verdict", "adopted"];
const routeWindow = (usedPercent, resetsAt) => ({ usedPercent, resetsAt });
const routeUsageEntry = (weekly, extra = {}) => ({
  ok: true,
  fiveHour: routeWindow(10, "2026-10-29T03:00:00.000Z"),
  weekly: routeWindow(weekly, "2026-11-04T00:00:00.000Z"),
  exhausted: false,
  ...extra,
});
function seedRouteUsage(sb, providers) {
  const usageBin = join(sb.root, "ai-usage");
  const usage = { fetchedAt: "2026-10-29T00:00:00.000Z", providers };
  writeFileSync(
    usageBin,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(usage)}'\n`,
  );
  chmodSync(usageBin, 0o755);
  return usageBin;
}

// Each test owns its sandbox, so process-launching tests can overlap.
describe("delegation cli (process)", { concurrency: 4 }, () => {
  it("open: Agent sonnet/high", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open(agent());
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /^d-[0-9a-f]{12} claude-code-agent sonnet high\n$/,
      );
    } finally {
      sb.done();
    }
  });

  it("open: codex-rescue Agent is codex-cli with unknown model and effort", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open(agent({ subagent_type: "codex:codex-rescue" }));
      assert.match(r.stdout, /^d-[0-9a-f]{12} codex-cli unknown unknown\n$/);
    } finally {
      sb.done();
    }
  });

  it("open: Bash opencode run reads -m and --variant", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open({
        tool: "Bash",
        tool_use_id: "tu2",
        sessionId: "s1",
        command:
          'cd x && opencode run -m zai-coding-plan/glm-5.3 --variant high "do it"',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /^d-[0-9a-f]{12} opencode zai-coding-plan\/glm-5\.3 high\n$/,
      );
    } finally {
      sb.done();
    }
  });

  it("open: delegation offload becomes an opencode pending that record accepts", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open({
        tool: "Bash",
        tool_use_id: "tu-off",
        sessionId: "s1",
        command:
          "delegation offload --exposure external-ok --model opencode/glm-5.3-flash-free --brief-file /x/b.md --write",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /^d-[0-9a-f]{12} opencode opencode\/glm-5\.3-flash-free unknown\n$/,
      );
      const id = idOf(r);
      const rec = await sb.run([
        "record",
        id,
        "--verdict",
        "adopted",
        "--kind",
        "mechanical",
        "--size",
        "S",
      ]);
      assert.equal(rec.status, 0, rec.stderr);
      const row = foldLedger(readLedger(sb.store()).rows).delegations[0];
      assert.equal(row.kind, "mechanical");
      assert.equal(row.size, "S");
      assert.deepEqual(row.invocation, [
        "delegation offload",
        "opencode:--agent=worktree-edit",
      ]);
    } finally {
      sb.done();
    }
  });

  it("a lapsed offload pending counts as a lapse, not in the adoption denominator, and old rows still load", async () => {
    const sb = sandbox();
    try {
      const old = idOf(
        await sb.open({
          tool: "Bash",
          tool_use_id: "tu-old",
          sessionId: "s1",
          command: 'opencode run -m zai-coding-plan/glm-5.3 "x"',
        }),
      );
      assert.equal((await sb.run(["record", old, ...REC])).status, 0);
      const id = idOf(
        await sb.open({
          tool: "Bash",
          tool_use_id: "tu-new",
          sessionId: "s1",
          command:
            "delegation offload --exposure external-ok --model zai-coding-plan/glm-5.3 --brief-file /x/b.md",
        }),
      );
      assert.equal((await sb.run(["lapse", id])).status, 0);
      const folded = foldLedger(readLedger(sb.store()).rows);
      assert.equal(folded.delegations.length, 1);
      assert.equal(folded.lapses.length, 1);
      const groups = groupsForCell(
        folded,
        "impl",
        "M",
        new Date("2026-10-29T00:00:00.000Z"),
        30,
      );
      assert.equal(
        groups.reduce((n, g) => n + g.n, 0),
        1,
      );
      const lapsed = lapseGroups(
        folded,
        new Date("2026-10-29T00:00:00.000Z"),
        30,
      );
      assert.equal(
        lapsed.reduce((n, g) => n + g.lapses, 0),
        1,
      );
    } finally {
      sb.done();
    }
  });

  it("open: codex exec and reviewer-codex-run are codex-cli", async () => {
    const sb = sandbox();
    try {
      const a = await sb.open({
        tool: "Bash",
        tool_use_id: "tu3",
        sessionId: "s1",
        command:
          "codex exec -m gpt-6.1-terra -c model_reasoning_effort=high -s read-only x",
      });
      assert.match(a.stdout, /codex-cli gpt-6\.1-terra high\n$/);
      const b = await sb.open({
        tool: "Bash",
        tool_use_id: "tu4",
        sessionId: "s1",
        command: "bun ~/.claude/hooks/reviewer-codex-run.ts plan.md",
      });
      assert.match(b.stdout, /codex-cli unknown unknown\n$/);
      const p = readPending(sb.store(), idOf(a));
      assert.deepEqual(p.invocation, ["codex exec", "sandbox:read-only"]);
    } finally {
      sb.done();
    }
  });

  it("capture reads the launch line written in the real agent definition", () => {
    const text = readFileSync(
      new URL("../home/dot_claude/agents/logic-validator.md", import.meta.url),
      "utf8",
    );
    const template =
      /`(bun ~\/\.claude\/scripts\/reviewer-codex-run\.ts [^`]+)`/.exec(
        text,
      )?.[1];
    assert.ok(template, "launch template not found in agent definition");
    const filled = template
      .replace("<model の値>", "gpt-6.1-terra")
      .replace("<effort の値>", "high")
      .replace("<brief の値>", "/a")
      .replace("<root の値>", "/b");
    const c = captureBash(filled);
    assert.equal(c.harness, "codex-cli");
    assert.equal(c.model, "gpt-6.1-terra");
    assert.equal(c.effort, "high");
    assert.equal(c.invocation[0], "reviewer-codex-run");
  });

  it("open: non-target Bash is refused", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open({
        tool: "Bash",
        tool_use_id: "tu5",
        sessionId: "s1",
        command: "echo hi",
      });
      assert.equal(r.status, 1);
    } finally {
      sb.done();
    }
  });

  it("review --help prints usage, exits 0 and adds no ledger line", async () => {
    const sb = sandbox();
    try {
      for (const args of [
        ["review", "--help"],
        ["review", "--since", "7", "--help"],
        ["review", "-h"],
      ]) {
        const r = await sb.run(args);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Usage: delegation/);
        assert.equal(r.stderr, "");
      }
      assert.equal(readLedger(sb.store()).rows.length, 0);
    } finally {
      sb.done();
    }
  });

  it("offload is dispatched and documented; a refusal leaves the ledger alone", async () => {
    const sb = sandbox();
    try {
      const help = await sb.run(["--help"]);
      assert.match(help.stdout, /^\s*offload --exposure external-ok/m);
      const r = await sb.run(["offload"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /拒否（args）/);
      assert.equal(readLedger(sb.store()).rows.length, 0);
    } finally {
      sb.done();
    }
  });

  it("a --help consumed as a flag value is not a help request", async () => {
    const sb = sandbox();
    try {
      const r = await sb.run(["review", "--since", "--help"]);
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stdout, /Usage: delegation/);
    } finally {
      sb.done();
    }
  });

  it("route without --kind still exits 1", async () => {
    const sb = sandbox();
    try {
      assert.equal((await sb.run(["route", "--size", "M"])).status, 1);
    } finally {
      sb.done();
    }
  });

  it("non-route commands keep ignoring route-only --exclude", async () => {
    const sb = sandbox();
    try {
      const plain = await sb.run(["review"]);
      const withExclude = await sb.run(["review", "--exclude", "codex"]);
      assert.equal(plain.status, withExclude.status);
      assert.equal(plain.stdout, withExclude.stdout);
      assert.equal(plain.stderr, withExclude.stderr);
    } finally {
      sb.done();
    }
  });

  it("route --exclude accepts repeatable provider and destination names", async () => {
    const sb = sandbox();
    try {
      seedVerifiedOpencode(sb, ["zai-coding-plan/glm-5.3"]);
      const usageBin = seedRouteUsage(sb, {
        claude: routeUsageEntry(10),
        codex: routeUsageEntry(0),
        opencode: routeUsageEntry(4),
      });
      const env = { extraEnv: { DELEGATION_AI_USAGE_BIN: usageBin } };
      const codex = await sb.run(
        [
          "route",
          "--kind",
          "impl",
          "--size",
          "M",
          "--exposure",
          "external-ok",
          "--exclude",
          "codex",
        ],
        env,
      );
      assert.equal(codex.status, 0, codex.stderr);
      const codexRecommendation = codex.stdout
        .split("\n")
        .find((line) => line.startsWith("推奨:"));
      assert.match(codexRecommendation, /^推奨: opencode /);
      assert.doesNotMatch(codexRecommendation, /codex/);

      const both = await sb.run(
        [
          "route",
          "--kind",
          "impl",
          "--size",
          "M",
          "--exposure",
          "external-ok",
          "--exclude",
          "codex",
          "--exclude",
          "opencode",
        ],
        env,
      );
      assert.equal(both.status, 0, both.stderr);
      const bothRecommendation = both.stdout
        .split("\n")
        .find((line) => line.startsWith("推奨:"));
      assert.match(bothRecommendation, /^推奨: sonnet /);
      assert.doesNotMatch(bothRecommendation, /codex|opencode/);

      const luna = await sb.run(
        ["route", "--kind", "impl", "--size", "M", "--exclude=codex-luna-max"],
        env,
      );
      assert.equal(luna.status, 0, luna.stderr);
      const lunaRecommendation = luna.stdout
        .split("\n")
        .find((line) => line.startsWith("推奨:"));
      assert.match(lunaRecommendation, /^推奨: codex Terra /);
      assert.doesNotMatch(lunaRecommendation, /Luna max/);

      const free = await sb.run(
        [
          "route",
          "--kind",
          "impl",
          "--size",
          "M",
          "--exclude=opencode-free-glm",
        ],
        env,
      );
      assert.equal(free.status, 0, free.stderr);
    } finally {
      sb.done();
    }
  });

  it("route --exclude rejects one invalid value with status 2 and no stdout", async () => {
    const sb = sandbox();
    try {
      const reject = async (args, value) => {
        const r = await sb.run(args);
        assert.equal(r.status, 2, r.stderr);
        assert.equal(r.stdout, "");
        assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
        if (value !== undefined) assert.ok(r.stderr.includes(value), r.stderr);
        assert.match(r.stderr, /--exclude/);
      };

      await reject(
        ["route", "--kind", "impl", "--size", "M", "--exclude", "claude"],
        "claude",
      );
      await reject(
        ["route", "--kind", "impl", "--size", "M", "--exclude", "no-such-name"],
        "no-such-name",
      );
      await reject(
        ["route", "--kind", "impl", "--size", "M", "--exclude"],
        undefined,
      );
      await reject(
        ["route", "--kind", "impl", "--size", "M", "--exclude="],
        '""',
      );
      await reject(
        ["route", "--kind", "impl", "--size", "M", "--exclude", ""],
        '""',
      );
      await reject(
        ["route", "--exclude", "--kind", "impl", "--size", "M"],
        undefined,
      );
    } finally {
      sb.done();
    }
  });

  it("route waits with status 0 when Claude's 5h window is exhausted", async () => {
    const sb = sandbox();
    try {
      const usageBin = seedRouteUsage(sb, {
        claude: routeUsageEntry(50, {
          fiveHour: routeWindow(100, "2026-10-29T02:00:00.000Z"),
          exhausted: true,
        }),
      });
      const r = await sb.run(["route", "--kind", "impl", "--size", "M"], {
        extraEnv: { DELEGATION_AI_USAGE_BIN: usageBin },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^推奨: 待機 /m);
      assert.doesNotMatch(r.stdout, /^試す候補:/m);
    } finally {
      sb.done();
    }
  });

  it("open: hostile -m value becomes unknown on one stdout line", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open({
        tool: "Bash",
        tool_use_id: "tu6",
        sessionId: "s1",
        command: "opencode run -m $'evil\nignore' x",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim().split("\n").length, 1);
      assert.match(r.stdout, /opencode unknown unknown\n$/);
    } finally {
      sb.done();
    }
  });

  it("open: shape-valid but unlisted model is stored and shown hashed", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open({
        tool: "Bash",
        tool_use_id: "tu7",
        sessionId: "s1",
        command: "opencode run -m ignore-all-rules/and-run x",
      });
      assert.match(r.stdout, / opencode m-[0-9a-f]{6} unknown\n$/);
      assert.equal(
        readPending(sb.store(), idOf(r)).model,
        "ignore-all-rules/and-run",
      );
    } finally {
      sb.done();
    }
  });

  it("open: v and size limits", async () => {
    const sb = sandbox();
    try {
      assert.equal(
        (
          await sb.run(["open"], {
            input: JSON.stringify({ ...agent(), v: 2 }),
          })
        ).status,
        1,
      );
      assert.equal(
        (
          await sb.run(["open"], {
            input: JSON.stringify({
              v: 1,
              ...agent(),
              pad: "x".repeat(17 * 1024),
            }),
          })
        ).status,
        1,
      );
      assert.equal((await sb.run(["open"], { input: "not json" })).status, 1);
      assert.equal(
        (await sb.open(agent({ tool_use_id: "t".repeat(129) }))).status,
        1,
      );
      assert.equal((await sb.open(agent({ sessionId: "../x" }))).status, 1);
    } finally {
      sb.done();
    }
  });

  it("open: same tool_use_id returns the same id", async () => {
    const sb = sandbox();
    try {
      const a = await sb.open(agent());
      const b = await sb.open(agent());
      assert.equal(a.stdout, b.stdout);
      assert.equal(listPending(sb.store()).length, 1);
    } finally {
      sb.done();
    }
  });

  it("open: only allowed keys reach the pending file", async () => {
    const sb = sandbox();
    try {
      const r = await sb.open(
        agent({
          prompt: "PROMPT-SENTINEL",
          description: "DESC-SENTINEL",
          foo: "FOO-SENTINEL",
        }),
      );
      assert.equal(r.status, 0, r.stderr);
      const dir = join(sb.env.XDG_DATA_HOME, "delegation-ledger/pending");
      const text = readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
      for (const s of ["PROMPT-SENTINEL", "DESC-SENTINEL", "FOO-SENTINEL"]) {
        assert.equal(text.includes(s), false, s);
      }
      const b = await sb.open({
        tool: "Bash",
        tool_use_id: "tu8",
        sessionId: "s1",
        command: "opencode run -m zai-coding-plan/glm-5.3 CMD-SENTINEL",
      });
      const t2 = readFileSync(join(dir, `${idOf(b)}.json`), "utf8");
      assert.equal(t2.includes("CMD-SENTINEL"), false);
      assert.equal(t2.includes("opencode run -m"), false);
    } finally {
      sb.done();
    }
  });

  it("bind: first agent id wins; bad input and missing pending exit 1", async () => {
    const sb = sandbox();
    try {
      const id = idOf(await sb.open(agent()));
      assert.equal((await sb.run(["bind", id, "--agent-id", "ag1"])).status, 0);
      assert.equal((await sb.run(["bind", id, "--agent-id", "ag2"])).status, 0);
      assert.equal(readPending(sb.store(), id).agentId, "ag1");
      assert.equal(
        (await sb.run(["bind", "d-000000000000", "--agent-id", "a"])).status,
        1,
      );
      assert.equal(
        (await sb.run(["bind", id, "--agent-id", "../x"])).status,
        1,
      );
    } finally {
      sb.done();
    }
  });

  it("close: first close wins; unknown values degrade to null", async () => {
    const sb = sandbox();
    try {
      const id = idOf(await sb.open(agent()));
      assert.equal(
        (
          await sb.run([
            "close",
            id,
            "--reason",
            "answer",
            "--duration-ms",
            "1000",
          ])
        ).status,
        0,
      );
      await sb.run(["close", id, "--reason", "error", "--duration-ms", "5"], {
        now: "2026-10-29T05:00:00.000Z",
      });
      const p = readPending(sb.store(), id);
      assert.equal(p.endReason, "answer");
      assert.equal(p.durationMs, 1000);
      assert.equal(p.closedAt, "2026-10-29T00:00:00.000Z");

      const id2 = idOf(await sb.open(agent({ tool_use_id: "tu-b" })));
      const r = await sb.run([
        "close",
        id2,
        "--reason",
        "weird",
        "--duration-ms",
        "86400001",
      ]);
      assert.equal(r.status, 0);
      const p2 = readPending(sb.store(), id2);
      assert.equal(p2.endReason, null);
      assert.equal(p2.durationMs, null);
      assert.notEqual(p2.closedAt, null);
    } finally {
      sb.done();
    }
  });

  it("close --agent-id: no match is a quiet success", async () => {
    const sb = sandbox();
    try {
      const a = idOf(await sb.open(agent({ tool_use_id: "ta" })));
      await sb.run(["bind", a, "--agent-id", "one"]);
      const before = JSON.stringify(listPending(sb.store()));
      assert.equal(
        (await sb.run(["close", "--agent-id", "nomatch", "--reason", "answer"]))
          .status,
        0,
      );
      assert.equal(JSON.stringify(listPending(sb.store())), before);
    } finally {
      sb.done();
    }
  });

  it("close --agent-id: two matches fail without changes", async () => {
    const sb = sandbox();
    try {
      const a = idOf(await sb.open(agent({ tool_use_id: "ta" })));
      const b = idOf(await sb.open(agent({ tool_use_id: "tb" })));
      await sb.run(["bind", a, "--agent-id", "same"]);
      await sb.run(["bind", b, "--agent-id", "same"]);
      const before = JSON.stringify(listPending(sb.store()));
      assert.equal(
        (await sb.run(["close", "--agent-id", "same", "--reason", "answer"]))
          .status,
        1,
      );
      assert.equal(JSON.stringify(listPending(sb.store())), before);
    } finally {
      sb.done();
    }
  });

  it("record: twice is idempotent and prints the stored verdict", async () => {
    const sb = sandbox();
    try {
      const id = idOf(await sb.open(agent()));
      assert.equal((await sb.run(["record", id, ...REC])).status, 0);
      const again = await sb.run([
        "record",
        id,
        "--kind",
        "impl",
        "--size",
        "M",
        "--verdict",
        "discarded",
      ]);
      assert.equal(again.status, 0);
      assert.match(again.stdout, /adopted/);
      assert.equal(readLedger(sb.store()).rows.length, 1);
      assert.equal(listPending(sb.store()).length, 0);
    } finally {
      sb.done();
    }
  });

  it("record: durationMs, endReason and at come from the pending", async () => {
    const sb = sandbox();
    try {
      const id = idOf(
        await sb.open(agent(), { now: "2026-10-29T00:00:00.000Z" }),
      );
      await sb.run(
        ["close", id, "--duration-ms", "3600000", "--reason", "answer"],
        {
          now: "2026-10-29T01:00:00.000Z",
        },
      );
      await sb.run(["record", id, ...REC], { now: "2026-10-29T02:00:00.000Z" });
      const row = readLedger(sb.store()).rows[0];
      assert.equal(row.durationMs, 3600000);
      assert.equal(row.endReason, "answer");
      assert.equal(row.at, "2026-10-29T00:00:00.000Z");

      const id2 = idOf(await sb.open(agent({ tool_use_id: "tu-c" })));
      await sb.run(["record", id2, ...REC]);
      const row2 = readLedger(sb.store()).rows[1];
      assert.equal(row2.durationMs, null);
      assert.equal(row2.endReason, null);
    } finally {
      sb.done();
    }
  });

  it("record: bad enums, bad id and missing ids exit 1 without touching files", async () => {
    const sb = sandbox();
    try {
      const id = idOf(await sb.open(agent()));
      assert.equal(
        (
          await sb.run([
            "record",
            id,
            "--kind",
            "nope",
            "--size",
            "M",
            "--verdict",
            "adopted",
          ])
        ).status,
        1,
      );
      assert.equal((await sb.run(["record", "../x", ...REC])).status, 1);
      assert.equal(
        (await sb.run(["record", "d-000000000000", ...REC])).status,
        1,
      );
      assert.equal(readLedger(sb.store()).rows.length, 0);
      assert.notEqual(readPending(sb.store(), id), null);
    } finally {
      sb.done();
    }
  });

  it("lapse then record writes a delegation row and clears the lapse", async () => {
    const sb = sandbox();
    try {
      const id = idOf(await sb.open(agent()));
      assert.equal((await sb.run(["lapse", id])).status, 0);
      assert.equal(foldLedger(readLedger(sb.store()).rows).lapses.length, 1);
      assert.equal((await sb.run(["record", id, ...REC])).status, 0);
      const folded = foldLedger(readLedger(sb.store()).rows);
      assert.equal(folded.lapses.length, 0);
      assert.equal(folded.delegations.length, 1);
      assert.equal(folded.delegations[0].model, "sonnet");
    } finally {
      sb.done();
    }
  });

  it("lapse and close on a missing pending", async () => {
    const sb = sandbox();
    try {
      assert.equal((await sb.run(["lapse", "d-000000000000"])).status, 1);
      assert.equal((await sb.run(["close", "d-000000000000"])).status, 0);
    } finally {
      sb.done();
    }
  });

  it("record after a crash between append and delete only removes the pending", async () => {
    const sb = sandbox();
    try {
      const id = idOf(await sb.open(agent()));
      await sb.run(["record", id, ...REC]);
      createPending(sb.store(), {
        v: 1,
        id,
        openedAt: "2026-10-29T00:00:00.000Z",
        sessionId: "s1",
        toolUseId: "tu1",
        harness: "claude-code-agent",
        invocation: [],
        model: "sonnet",
        effort: "high",
        agentId: null,
        closedAt: null,
        endReason: null,
        durationMs: null,
      });
      assert.equal((await sb.run(["record", id, ...REC])).status, 0);
      assert.equal(readLedger(sb.store()).rows.length, 1);
      assert.equal(readPending(sb.store(), id), null);
    } finally {
      sb.done();
    }
  });

  it("record --manual", async () => {
    const sb = sandbox();
    try {
      const r = await sb.run([
        "record",
        "--manual",
        "--harness",
        "cursor",
        "--model",
        "composer-2",
        "--effort",
        "unknown",
        ...REC,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const row = readLedger(sb.store()).rows[0];
      assert.match(row.id, ID_RE);
      assert.equal(row.manual, true);
      assert.equal(row.sessionId, null);
      assert.equal(row.harness, "cursor");
      assert.deepEqual(row.invocation, ["manual"]);
      const bad = await sb.run([
        "record",
        "--manual",
        "--harness",
        "cursor",
        "--size",
        "M",
        "--verdict",
        "adopted",
      ]);
      assert.equal(bad.status, 1);
    } finally {
      sb.done();
    }
  });

  it("amend", async () => {
    const sb = sandbox();
    try {
      const id = idOf(await sb.open(agent()));
      await sb.run(["record", id, ...REC]);
      assert.equal(
        (await sb.run(["amend", "d-000000000000", "--rework"])).status,
        1,
      );
      assert.equal((await sb.run(["amend", id])).status, 1);
      assert.equal(
        (await sb.run(["amend", id, "--rework", "--later-defect", "ci"]))
          .status,
        1,
      );
      assert.equal(
        (await sb.run(["amend", id, "--later-defect", "bogus"])).status,
        1,
      );
      assert.equal(
        (await sb.run(["amend", id, "--later-defect", "ci"])).status,
        0,
      );
      assert.equal((await sb.run(["amend", id, "--rework"])).status, 0);
      const d = foldLedger(readLedger(sb.store()).rows).delegations[0];
      assert.equal(d.reworks, 1);
      assert.deepEqual(d.laterDefects, ["ci"]);
    } finally {
      sb.done();
    }
  });

  it("open at 200 pendings lapses the oldest and stays at 200", async () => {
    const sb = sandbox();
    try {
      const store = sb.store();
      for (let i = 0; i < 200; i++) {
        const hex = i.toString(16).padStart(12, "0");
        createPending(store, {
          v: 1,
          id: `d-${hex}`,
          openedAt: new Date(Date.UTC(2026, 9, 28, 0, 0, i)).toISOString(),
          sessionId: "s1",
          toolUseId: `seed-${i}`,
          harness: "claude-code-agent",
          invocation: [],
          model: "sonnet",
          effort: "high",
          agentId: null,
          closedAt: null,
          endReason: null,
          durationMs: null,
        });
      }
      const r = await sb.open(agent({ tool_use_id: "fresh" }));
      assert.equal(r.status, 0, r.stderr);
      const ids = listPending(store).map((p) => p.id);
      assert.equal(ids.length, 200);
      assert.equal(ids.includes("d-000000000000"), false);
      const folded = foldLedger(readLedger(store).rows);
      assert.deepEqual(
        folded.lapses.map((l) => l.id),
        ["d-000000000000"],
      );
    } finally {
      sb.done();
    }
  });

  it("a symlinked data dir exits 1", async () => {
    const sb = sandbox();
    try {
      const target = join(sb.root, "elsewhere");
      mkdirSync(target);
      mkdirSync(sb.env.XDG_DATA_HOME);
      symlinkSync(
        target,
        join(sb.env.XDG_DATA_HOME, "delegation-ledger"),
        "dir",
      );
      assert.equal((await sb.open(agent())).status, 1);
      assert.equal(existsSync(join(target, "pending")), false);
    } finally {
      sb.done();
    }
  });

  it("record prompts for a review at the 10th record since the last one", async () => {
    const sb = sandbox();
    try {
      const store = sb.store();
      for (let i = 0; i < 8; i++) {
        appendLedger(store, {
          v: 1,
          type: "delegation",
          id: `d-${i.toString(16).padStart(12, "0")}`,
          at: "2026-10-28T00:00:00.000Z",
          harness: "claude-code-agent",
          invocation: [],
          model: "sonnet",
          effort: "high",
          kind: "impl",
          size: "M",
          sessionId: "s",
          manual: false,
          durationMs: null,
          endReason: null,
          verdict: "adopted",
        });
      }
      const first = idOf(await sb.open(agent({ tool_use_id: "r1" })));
      const r9 = await sb.run(["record", first, ...REC]);
      assert.doesNotMatch(r9.stdout, /delegation review/);
      const second = idOf(await sb.open(agent({ tool_use_id: "r2" })));
      const r10 = await sb.run(["record", second, ...REC]);
      assert.match(r10.stdout, /delegation review/);
    } finally {
      sb.done();
    }
  });

  it("the bun entrypoint works too", async (t) => {
    const sb = sandbox();
    try {
      if (!addHostExecutable(sb, "bun")) return t.skip("bun not on PATH");
      const r = spawnSync("bun", ["run", "--silent", main, "open"], {
        encoding: "utf8",
        input: JSON.stringify({ v: 1, ...agent() }),
        env: sb.env,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /^d-[0-9a-f]{12} claude-code-agent sonnet high\n$/,
      );
    } finally {
      sb.done();
    }
  });
});

// Agent definitions decide the model when the call carries none. Only the
// entrypoint wiring is exercised here; the parsing boundaries are in
// delegation-capture.test.mjs.
describe("delegation cli: model from the agent definition", () => {
  const noModel = (extra = {}) => ({
    tool: "Agent",
    tool_use_id: "tu1",
    sessionId: "s1",
    subagent_type: "logic-validator",
    ...extra,
  });
  const withDefs = (files = { "logic-validator": "model: sonnet" }) => {
    const sb = sandbox();
    const dir = join(sb.root, "agents");
    mkdirSync(dir);
    for (const [name, line] of Object.entries(files)) {
      writeFileSync(join(dir, `${name}.md`), `---\n${line}\n---\nbody\n`);
    }
    const open = (payload, extraEnv = { DELEGATION_AGENTS_DIR: dir }) =>
      sb.open(payload, { extraEnv });
    return { sb, dir, open };
  };
  const refused = (r) => {
    assert.equal(r.status, 1);
    assert.equal(r.stderr, "");
  };

  it("sonnet from the definition; same id twice is one pending; a removed definition then exits 1", async () => {
    const { sb, dir, open } = withDefs();
    try {
      const r = await open(noModel({ effort: "high" }));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, "");
      const [p] = listPending(sb.store());
      assert.equal(p.model, "sonnet");
      assert.equal(p.effort, "high");
      assert.deepEqual(p.invocation, ["subagent:logic-validator"]);
      assert.equal((await open(noModel({ effort: "high" }))).status, 0);
      assert.equal(listPending(sb.store()).length, 1);
      rmSync(join(dir, "logic-validator.md"));
      refused(await open(noModel({ effort: "high" })));
      assert.equal(listPending(sb.store()).length, 1);
    } finally {
      sb.done();
    }
  });

  it("without DELEGATION_AGENTS_DIR it reads HOME/.claude/agents", async () => {
    const sb = sandbox();
    try {
      const dir = join(sb.env.HOME, ".claude", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "x.md"), "---\nmodel: haiku\n---\n");
      const r = await sb.open(noModel({ subagent_type: "x" }));
      assert.equal(r.status, 0, r.stderr);
      const [p] = listPending(sb.store());
      assert.equal(p.model, "haiku");
      assert.equal(p.effort, "unknown");
    } finally {
      sb.done();
    }
  });

  it("no model and no subagent_type exits 1 silently", async () => {
    const { sb, open } = withDefs();
    try {
      refused(
        await open({ tool: "Agent", tool_use_id: "tu1", sessionId: "s1" }),
      );
      assert.equal(listPending(sb.store()).length, 0);
    } finally {
      sb.done();
    }
  });

  it("a malformed DELEGATION_AGENTS_DIR does not fall back to HOME", async () => {
    const sb = sandbox();
    try {
      const dir = join(sb.env.HOME, ".claude", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "logic-validator.md"),
        "---\nmodel: sonnet\n---\n",
      );
      refused(
        await sb.open(noModel(), {
          extraEnv: { DELEGATION_AGENTS_DIR: "rel" },
        }),
      );
      assert.equal(listPending(sb.store()).length, 0);
    } finally {
      sb.done();
    }
  });

  it("a FIFO definition exits 1 silently without hanging", async () => {
    const { sb, dir, open } = withDefs({});
    try {
      assert.equal(addHostExecutable(sb, "mkfifo"), true);
      assert.equal(
        spawnSync("mkfifo", [join(dir, "fifo.md")], { env: sb.env }).status,
        0,
      );
      const t0 = Date.now();
      refused(await open(noModel({ subagent_type: "fifo" })));
      assert.ok(Date.now() - t0 < 3000);
      assert.equal(listPending(sb.store()).length, 0);
    } finally {
      sb.done();
    }
  });

  it("a model on the call means the definition is not read", async () => {
    const { sb, open } = withDefs();
    try {
      const r = await open(noModel({ model: "sonnet", subagent_type: "../x" }));
      assert.equal(r.status, 0, r.stderr);
      const [p] = listPending(sb.store());
      assert.equal(p.model, "sonnet");
      assert.deepEqual(p.invocation, []);
    } finally {
      sb.done();
    }
  });

  it("a non-string model counts as absent, so the definition answers", async () => {
    const { sb, open } = withDefs();
    try {
      const r = await open(noModel({ model: 3 }));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(listPending(sb.store())[0].model, "sonnet");
    } finally {
      sb.done();
    }
  });

  describe("argument refusals", () => {
    const ROUTE = ["route", "--kind", "impl", "--size", "M"];
    const refused = async (args, ...needles) => {
      const sb = sandbox();
      try {
        const r = await sb.run(args);
        assert.equal(r.status, 1, r.stderr);
        for (const n of needles) assert.match(r.stderr, new RegExp(n));
      } finally {
        sb.done();
      }
    };

    it("--exposure without a value", () =>
      refused([...ROUTE, "--exposure"], "exposure"));
    it("--exposure with an unknown value", async () => {
      await refused(
        [...ROUTE, "--exposure", "public"],
        "closed",
        "external-ok",
      );
      await refused(
        [...ROUTE, "--exposure", "Closed"],
        "closed",
        "external-ok",
      );
    });
    it("--exposure twice", () =>
      refused(
        [...ROUTE, "--exposure", "closed", "--exposure", "external-ok"],
        "exposure",
        "duplicate|重複",
      ));
    it("--exposure with an empty value", async () => {
      await refused([...ROUTE, "--exposure="], "exposure");
      await refused([...ROUTE, "--exposure", ""], "exposure");
    });
    it("offload flags: missing and duplicate", async () => {
      await refused(["offload", "--brief-file"], "brief-file");
      await refused(["offload", "--dir", "a", "--dir", "b"], "dir");
      await refused(["offload", "--plan", "x", "--plan", "y"], "plan");
    });
    it("refusal comes before the unknown-command exit", () =>
      refused(["foo", "--dir", "a", "--dir", "b"], "dir"));
    it("--kind twice keeps last-wins and is refused as an unknown kind", () =>
      refused([
        ...ROUTE.slice(0, 1),
        "--kind",
        "a",
        "--kind",
        "b",
        "--size",
        "M",
      ]));
    it("external-ok without opencode reports the failed verification", async () => {
      const sb = sandbox();
      try {
        const r = await sb.run([
          "route",
          "--kind",
          "impl",
          "--size",
          "M",
          "--exposure=external-ok",
        ]);
        assert.equal(r.status, 0, r.stderr);
        const lines = r.stdout.split("\n");
        assert.ok(
          lines.some((line) =>
            line.startsWith(
              "区分: external-ok (確認済みでない model の委譲先を除いた:",
            ),
          ),
          r.stdout,
        );
        assert.ok(
          lines.some((line) => line.includes("理由: PATH に opencode が無い")),
        );
        assert.ok(lines.some((line) => line.includes("recovery:")));
        assert.equal(
          lines.some((line) => line.includes("delegation offload")),
          false,
        );
      } finally {
        sb.done();
      }
    });
    it("verified external-ok route exposes only the recorded model", async () => {
      const sb = sandbox();
      try {
        seedVerifiedOpencode(sb, ["zai-coding-plan/glm-5.3"]);
        const usageBin = join(sb.root, "ai-usage");
        const usage = {
          fetchedAt: "2026-10-29T00:00:00.000Z",
          providers: {
            claude: {
              ok: true,
              fiveHour: {
                usedPercent: 10,
                resetsAt: "2026-10-29T05:00:00.000Z",
              },
              weekly: {
                usedPercent: 80,
                resetsAt: "2026-11-05T00:00:00.000Z",
              },
              exhausted: false,
            },
            opencode: {
              ok: true,
              fiveHour: {
                usedPercent: 10,
                resetsAt: "2026-10-29T05:00:00.000Z",
              },
              weekly: {
                usedPercent: 5,
                resetsAt: "2026-11-05T00:00:00.000Z",
              },
              exhausted: false,
            },
          },
        };
        writeFileSync(
          usageBin,
          `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(usage)}'\n`,
        );
        chmodSync(usageBin, 0o755);

        const r = await sb.run(
          [
            "route",
            "--kind",
            "mechanical",
            "--size",
            "M",
            "--exposure",
            "external-ok",
          ],
          { extraEnv: { DELEGATION_AI_USAGE_BIN: usageBin } },
        );
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /claude 5h=under week=ahead/);
        assert.match(r.stdout, /opencode 5h=under week=under/);
        const lines = r.stdout.split("\n");
        const classification = lines.find((line) =>
          line.startsWith(
            "区分: external-ok (確認済みでない model の委譲先を除いた:",
          ),
        );
        assert.ok(classification, r.stdout);
        assert.match(classification, /sarashina/);
        assert.match(classification, /opencode free deepseek/);
        assert.match(classification, /opencode free glm/);
        assert.ok(
          lines.some((line) =>
            line.includes("--model zai-coding-plan/glm-5.3"),
          ),
          r.stdout,
        );
      } finally {
        sb.done();
      }
    });
    it("omitted exposure and closed have identical route output", async () => {
      const sb = sandbox();
      try {
        const omitted = await sb.run(ROUTE);
        const closed = await sb.run([...ROUTE, "--exposure", "closed"]);
        assert.equal(omitted.status, 0, omitted.stderr);
        assert.equal(closed.status, 0, closed.stderr);
        assert.equal(omitted.stdout, closed.stdout);
        assert.ok(
          omitted.stdout
            .split("\n")
            .some((line) =>
              line.startsWith("区分: closed (外部へ送る委譲先を除いた:"),
            ),
          omitted.stdout,
        );
      } finally {
        sb.done();
      }
    });
    it("review remains closed with external-ok", async () => {
      const sb = sandbox();
      try {
        const r = await sb.run([
          "route",
          "--kind",
          "review",
          "--size",
          "S",
          "--exposure",
          "external-ok",
        ]);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(
          r.stdout
            .split("\n")
            .some((line) => line === "区分: closed (review は外部へ送らない)"),
          r.stdout,
        );
      } finally {
        sb.done();
      }
    });
    it("review --since --help is still refused without usage", async () => {
      const sb = sandbox();
      try {
        const r = await sb.run(["review", "--since", "--help"]);
        assert.equal(r.status, 1);
        assert.doesNotMatch(r.stdout, /Usage/);
      } finally {
        sb.done();
      }
    });
    it("--exposure --help takes --help as the value", async () => {
      const sb = sandbox();
      try {
        const r = await sb.run([...ROUTE, "--exposure", "--help"]);
        assert.equal(r.status, 1);
        assert.doesNotMatch(r.stdout, /Usage/);
        assert.match(r.stderr, /closed/);
        assert.match(r.stderr, /external-ok/);
      } finally {
        sb.done();
      }
    });
  });
});
