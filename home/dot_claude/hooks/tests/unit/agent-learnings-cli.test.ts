import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  runLearningsCli,
  type RunLearningsCliDeps,
} from "../../cli/learnings.ts";
import type { RunGit } from "../../lib/run-git.ts";
import {
  formatFeedbackLine,
  formatInjectionLine,
  type FeedbackLine,
  type InjectionLine,
} from "../../lib/agent-learnings/core/metrics.ts";
import {
  defaultStoreDir,
  ensureStateDirs,
  LOG_HARD_MAX_BYTES,
  LOG_MAX_BYTES,
  storePaths,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

// 実 git は使わない（unit は CLAUDE_TEST_FORBID_GIT=1）。repoKey は cwd ごとの偽の origin から決める
const NOW = new Date("2026-10-22T00:00:00.000Z");
const REPO = "github.com/foo/bar";
const OTHER = "github.com/foo/other";
const ID = "L-000000000001";
const DAY = 24 * 60 * 60 * 1000;

const origins: Record<string, string> = {
  "/work/bar": "https://github.com/foo/bar.git",
  "/work/other": "https://github.com/foo/other.git",
};
const storeLog: { stdout: string; ok: boolean } = { stdout: "", ok: true };
const fakeGit: RunGit = (args, cwd) => {
  if (args.includes("log")) {
    return storeLog.ok
      ? { ok: true, stdout: storeLog.stdout }
      : { ok: false, status: 128 };
  }
  if (args[0] === "rev-parse") return { ok: true, stdout: `${cwd}/.git` };
  if (args[0] === "config") {
    const url = origins[cwd];
    return url === undefined
      ? { ok: false, status: 1 }
      : { ok: true, stdout: url };
  }
  return { ok: true, stdout: "" };
};

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function setup(over: Partial<RunLearningsCliDeps> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "al-cli-unit-")));
  roots.push(home);
  const store = defaultStoreDir(home);
  mkdirSync(join(store, ".git"), { recursive: true });
  mkdirSync(join(store, "repos"), { mode: 0o700 });
  ensureStateDirs(store);
  mkdirSync(storePaths(store).codex, { recursive: true });
  storeLog.stdout = "";
  storeLog.ok = true;
  const deps: RunLearningsCliDeps = {
    cwd: "/work/bar",
    home,
    now: NOW,
    readerEnv: undefined,
    isTty: false,
    agentEnv: true,
    feedbackReader: "claude",
    lockWaitMs: 100,
    runGit: fakeGit,
    confirm: async () => false,
    ...over,
  };
  return { deps, store, paths: storePaths(store) };
}

const injection = (over: Partial<InjectionLine> = {}): InjectionLine => ({
  v: 1,
  at: new Date(NOW.getTime() - 3_600_000).toISOString(),
  repoKey: REPO,
  id: ID,
  kind: "pre",
  trigger: "cmd:git commit",
  ...over,
});
const feedbackLine = (over: Partial<FeedbackLine> = {}): FeedbackLine => ({
  v: 1,
  at: new Date(NOW.getTime() - 1_800_000).toISOString(),
  reader: "claude",
  repoKey: REPO,
  id: ID,
  verdict: "mistimed",
  kind: "pre",
  trigger: "cmd:git commit",
  ...over,
});
const put = (path: string, ...lines: string[]) =>
  appendFileSync(path, lines.join(""));
const read = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : "";

describe("agent-learnings show --on=session", () => {
  it("tells how many scene-only learnings were left out", async () => {
    const { deps, store } = setup();
    ok(
      writeLearnings(store, {
        format: 1,
        key: REPO,
        readOnly: false,
        entries: [
          {
            id: ID,
            title: "scene only",
            body: "b",
            seen: 1,
            repos: [REPO],
            updated: "2026-10-01",
            extra: [["on", "cmd:git commit"]],
          },
        ],
      }).ok,
    );
    const r = await runLearningsCli(["show", "--on=session"], deps);
    strictEqual(r.exitCode, 0);
    ok(
      r.stdout.includes("他に 1 件は、コマンドやファイルの場面で出る"),
      r.stdout,
    );
    ok(!r.stdout.includes("scene only"));
  });
});

describe("agent-learnings feedback", () => {
  it("accepts a recorded (repo, id, kind) and writes reader and the recorded trigger", async () => {
    const { deps, paths } = setup();
    put(paths.injectionsLog, formatInjectionLine(injection()));
    const r = await runLearningsCli(
      ["feedback", ID, "mistimed", "--at=pre"],
      deps,
    );
    strictEqual(r.exitCode, 0);
    strictEqual(r.stdout, `記録した: ${ID} mistimed --at=pre\n`);
    const lines = read(paths.feedbackLog).split("\n").filter(Boolean);
    strictEqual(lines.length, 1);
    const written = JSON.parse(lines[0] as string) as Record<string, unknown>;
    strictEqual(written["reader"], "claude");
    strictEqual(written["trigger"], "cmd:git commit");
    strictEqual(written["repoKey"], REPO);
    strictEqual(written["verdict"], "mistimed");
  });
  it("rejects a codex feedback whose only injection record is claude's, and accepts codex's", async () => {
    const { deps, paths } = setup({ feedbackReader: "codex" });
    put(
      paths.injectionsLog,
      formatInjectionLine(injection({ reader: "claude" })),
    );
    const rejected = await runLearningsCli(
      ["feedback", ID, "helpful", "--at=pre"],
      deps,
    );
    strictEqual(rejected.exitCode, 1);
    put(
      paths.injectionsLog,
      formatInjectionLine(injection({ reader: "codex" })),
    );
    const accepted = await runLearningsCli(
      ["feedback", ID, "helpful", "--at=pre"],
      deps,
    );
    strictEqual(accepted.exitCode, 0);
    ok(read(paths.codexFeedbackLog).includes('"reader":"codex"'));
  });
  it("tells codex that session and fail are not recorded, before matching", async () => {
    for (const at of ["session", "fail"]) {
      const { deps, paths } = setup({ feedbackReader: "codex" });
      put(
        paths.injectionsLog,
        formatInjectionLine(injection({ kind: at as "session" | "fail" })),
      );
      const r = await runLearningsCli(
        ["feedback", ID, "helpful", `--at=${at}`],
        deps,
      );
      strictEqual(r.exitCode, 1);
      ok(
        r.stderr.includes("Codex の開始時と失敗の直後は記録していない"),
        r.stderr,
      );
      ok(!r.stderr.includes("注入の記録が無い"));
      strictEqual(read(paths.codexFeedbackLog), "");
    }
  });
  it("rejects a kind that has no injection record, and writes nothing", async () => {
    const { deps, paths } = setup();
    put(paths.injectionsLog, formatInjectionLine(injection()));
    const r = await runLearningsCli(
      ["feedback", ID, "mistimed", "--at=fail"],
      deps,
    );
    strictEqual(r.exitCode, 1);
    ok(r.stderr.includes("注入の記録が無い"));
    strictEqual(existsSync(paths.feedbackLog), false);
  });
  it("rejects the same id from another repo", async () => {
    const { deps, paths } = setup({ cwd: "/work/other" });
    put(paths.injectionsLog, formatInjectionLine(injection()));
    const r = await runLearningsCli(
      ["feedback", ID, "helpful", "--at=pre"],
      deps,
    );
    strictEqual(r.exitCode, 1);
    strictEqual(existsSync(paths.feedbackLog), false);
  });
  it("writes to codex/feedback.log for the codex reader", async () => {
    const { deps, paths } = setup({ feedbackReader: "codex" });
    put(paths.injectionsLog, formatInjectionLine(injection()));
    const r = await runLearningsCli(
      ["feedback", ID, "wrong", "--at=pre"],
      deps,
    );
    strictEqual(r.exitCode, 0);
    ok(read(paths.codexFeedbackLog).includes('"reader":"codex"'));
    strictEqual(existsSync(paths.feedbackLog), false);
  });
  it("accepts an unknown reader into the claude-side log", async () => {
    const { deps, paths } = setup({ feedbackReader: "unknown" });
    put(paths.injectionsLog, formatInjectionLine(injection()));
    strictEqual(
      (await runLearningsCli(["feedback", ID, "helpful", "--at=pre"], deps))
        .exitCode,
      0,
    );
    ok(read(paths.feedbackLog).includes('"reader":"unknown"'));
  });
  it("accepts a session record whose trigger is untagged", async () => {
    const { deps, paths } = setup();
    put(
      paths.injectionsLog,
      formatInjectionLine(injection({ kind: "session", trigger: "untagged" })),
    );
    strictEqual(
      (await runLearningsCli(["feedback", ID, "helpful", "--at=session"], deps))
        .exitCode,
      0,
    );
    ok(read(paths.feedbackLog).includes('"trigger":"untagged"'));
  });

  describe("bad arguments", () => {
    const cases: Array<[string, string[], string]> = [
      ["verdict", ["feedback", ID, "ZZverdict", "--at=pre"], "ZZverdict"],
      ["at value", ["feedback", ID, "helpful", "--at=ZZat"], "ZZat"],
      ["id", ["feedback", "L-ZZid", "helpful", "--at=pre"], "L-ZZid"],
      [
        "three positionals",
        ["feedback", ID, "helpful", "ZZextra", "--at=pre"],
        "ZZextra",
      ],
      ["empty --at", ["feedback", ID, "helpful", "--at="], "unused"],
      [
        "two --at",
        ["feedback", ID, "helpful", "--at=pre", "--at=ZZsecond"],
        "ZZsecond",
      ],
      [
        "--reader",
        ["feedback", ID, "helpful", "--at=pre", "--reader", "ZZreader"],
        "ZZreader",
      ],
      [
        "unknown option",
        ["feedback", ID, "helpful", "--at=pre", "--ZZopt=1"],
        "ZZopt",
      ],
      [
        "word after --",
        ["feedback", ID, "helpful", "--at=pre", "--", "ZZafter"],
        "ZZafter",
      ],
      ["missing --at", ["feedback", ID, "helpful"], "unused"],
    ];
    for (const [name, argv, secret] of cases) {
      it(`exits 1 without echoing the value: ${name}`, async () => {
        const { deps, paths } = setup();
        put(paths.injectionsLog, formatInjectionLine(injection()));
        const r = await runLearningsCli(argv, deps);
        strictEqual(r.exitCode, 1);
        ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
        strictEqual(existsSync(paths.feedbackLog), false);
      });
    }
    it("prints usage for --help and exits 0", async () => {
      const { deps } = setup();
      const r = await runLearningsCli(["feedback", "--help"], deps);
      strictEqual(r.exitCode, 0);
      ok(r.stdout.includes("feedback <id>"));
    });
  });

  it("rejects an injection older than 14 days, and mentions .1 only when it exists", async () => {
    const { deps, paths } = setup();
    put(
      paths.injectionsLog,
      formatInjectionLine(
        injection({ at: new Date(NOW.getTime() - 16 * DAY).toISOString() }),
      ),
    );
    const argv = ["feedback", ID, "helpful", "--at=pre"];
    const without = await runLearningsCli(argv, deps);
    strictEqual(without.exitCode, 1);
    ok(!without.stderr.includes("直近の回転で記録が .1 に移った可能性がある"));
    writeFileSync(`${paths.injectionsLog}.1`, "");
    const withRotated = await runLearningsCli(argv, deps);
    strictEqual(withRotated.exitCode, 1);
    ok(
      withRotated.stderr.includes("直近の回転で記録が .1 に移った可能性がある"),
    );
  });
  it("refuses to write when feedback.log is full", async () => {
    const { deps, paths } = setup();
    put(paths.injectionsLog, formatInjectionLine(injection()));
    writeFileSync(paths.feedbackLog, "");
    truncateSync(paths.feedbackLog, LOG_HARD_MAX_BYTES + 1);
    const r = await runLearningsCli(
      ["feedback", ID, "helpful", "--at=pre"],
      deps,
    );
    strictEqual(r.exitCode, 1);
    ok(r.stderr.includes("記録のログが上限に達している"));
  });
  it("exits 1 when the store does not exist or the repo cannot be resolved", async () => {
    const { deps } = setup();
    const noStore = {
      ...deps,
      home: realpathSync(mkdtempSync(join(tmpdir(), "al-empty-"))),
    };
    roots.push(noStore.home);
    strictEqual(
      (await runLearningsCli(["feedback", ID, "helpful", "--at=pre"], noStore))
        .exitCode,
      1,
    );
    strictEqual(
      (
        await runLearningsCli(["feedback", ID, "helpful", "--at=pre"], {
          ...deps,
          cwd: "/nowhere",
          runGit: () => ({ ok: false, status: 128 }),
        })
      ).exitCode,
      1,
    );
  });
});

describe("agent-learnings status (metrics)", () => {
  const reviewSetup = () => {
    const ctx = setup();
    put(
      ctx.paths.injectionsLog,
      formatInjectionLine(injection({ trigger: "cmd:git commit" })),
      formatInjectionLine(injection({ trigger: "cmd:git commit" })),
      formatInjectionLine(injection({ trigger: "cmd:git" })),
    );
    put(
      ctx.paths.feedbackLog,
      formatFeedbackLine(feedbackLine()),
      formatFeedbackLine(feedbackLine()),
    );
    return ctx;
  };
  it("prints the injection and feedback counts and the review line", async () => {
    const { deps } = reviewSetup();
    const r = await runLearningsCli(["status"], deps);
    strictEqual(r.exitCode, 0);
    const lines = r.stdout.split("\n");
    ok(lines.includes("injections (14d): session 0 pre 3 fail 0 path 0"));
    ok(lines.includes("feedback (14d): helpful 0 mistimed 2 wrong 0"));
    ok(
      lines.includes(
        `review: ${ID}（mistimed 2 wrong 0 / 3 pre; cmd:git commit 2, cmd:git 1）${REPO}`,
      ),
    );
    ok(!r.stdout.includes("unknown 1"));
  });
  it("appends unknown counts for lines that fail validation", async () => {
    const { deps, paths } = setup();
    put(
      paths.injectionsLog,
      formatInjectionLine(injection()),
      `${JSON.stringify({ ...injection(), v: 2 })}\n`,
    );
    put(paths.feedbackLog, `${JSON.stringify({ ...feedbackLine(), v: 2 })}\n`);
    const out = (await runLearningsCli(["status"], deps)).stdout;
    ok(
      out.includes("injections (14d): session 0 pre 1 fail 0 path 0 unknown 1"),
    );
    ok(out.includes("feedback (14d): helpful 0 mistimed 0 wrong 0 unknown 1"));
  });
  it("adds the claude and codex feedback logs together", async () => {
    const { deps, paths } = setup();
    put(
      paths.injectionsLog,
      formatInjectionLine(injection()),
      formatInjectionLine(injection()),
    );
    put(paths.feedbackLog, formatFeedbackLine(feedbackLine()));
    put(
      paths.codexFeedbackLog,
      formatFeedbackLine(feedbackLine({ reader: "codex" })),
    );
    const out = (await runLearningsCli(["status"], deps)).stdout;
    ok(out.includes("feedback (14d): helpful 0 mistimed 2 wrong 0"));
  });
  it("counts retag and untag lines from the store git log, and shows ? on failure", async () => {
    const { deps } = setup();
    storeLog.stdout = [
      "learnings: retag",
      "",
      `retag ${ID}: cmd:git -> cmd:git commit`,
      `retag L-000000000002: (none) -> session`,
      "",
      `untag L-000000000003: cmd:git`,
    ].join("\n");
    ok(
      (await runLearningsCli(["status"], deps)).stdout
        .split("\n")
        .includes("retag (14d): 2 untag (14d): 1"),
    );
    storeLog.ok = false;
    ok(
      (await runLearningsCli(["status"], deps)).stdout
        .split("\n")
        .includes("retag (14d): ?"),
    );
  });
  it("announces a full log with a fix= line carrying absolute paths", async () => {
    const { deps, paths } = setup();
    writeFileSync(paths.feedbackLog, "");
    truncateSync(paths.feedbackLog, LOG_HARD_MAX_BYTES);
    writeFileSync(paths.codexFeedbackLog, "");
    truncateSync(paths.codexFeedbackLog, LOG_HARD_MAX_BYTES);
    const lines = (await runLearningsCli(["status"], deps)).stdout.split("\n");
    ok(
      lines.includes(
        `log full: feedback.log fix=mv ${paths.feedbackLog} ${paths.feedbackLog}.1`,
      ),
    );
    ok(
      lines.includes(
        `log full: codex/feedback.log fix=mv ${paths.codexFeedbackLog} ${paths.codexFeedbackLog}.1`,
      ),
    );
    ok(lines.some((l) => l.startsWith("log full: ") && l.includes(deps.home)));
  });
  it("adds (covers Nd) only when the tail was cut and the oldest line is newer than 14 days", async () => {
    const five = new Date(NOW.getTime() - 5 * DAY).toISOString();
    const big = setup();
    // 1MB を超える注入の記録。末尾 1MB の最古の行が 5 日前になるようにする
    const filler = formatInjectionLine(injection({ at: five }));
    const count = Math.ceil((LOG_MAX_BYTES + 4096) / Buffer.byteLength(filler));
    writeFileSync(big.paths.injectionsLog, filler.repeat(count));
    ok(
      (await runLearningsCli(["status"], big.deps)).stdout.includes(
        "(covers 5d)",
      ),
    );
    const small = setup();
    put(small.paths.injectionsLog, filler);
    ok(
      !(await runLearningsCli(["status"], small.deps)).stdout.includes(
        "covers",
      ),
    );
  });
  it(
    "finishes at once and still prints the other lines when injections.log is a FIFO",
    { timeout: 1000 },
    async () => {
      const { deps, paths } = setup();
      execFileSync("mkfifo", [paths.injectionsLog]);
      const r = await runLearningsCli(["status"], deps);
      strictEqual(r.exitCode, 0);
      const lines = r.stdout.split("\n");
      ok(lines.includes("injections (14d): session 0 pre 0 fail 0 path 0"));
      ok(lines.some((l) => l.startsWith("queue: ")));
    },
  );
  it("lists at most 10 review lines and counts the rest", async () => {
    const { deps, paths } = setup();
    for (let n = 1; n <= 12; n++) {
      const id = `L-${n.toString(16).padStart(12, "0")}`;
      put(
        paths.injectionsLog,
        ...[1, 2, 3].map(() => formatInjectionLine(injection({ id }))),
      );
      put(
        paths.feedbackLog,
        ...[1, 2].map(() => formatFeedbackLine(feedbackLine({ id }))),
      );
    }
    const lines = (await runLearningsCli(["status"], deps)).stdout.split("\n");
    strictEqual(lines.filter((l) => /^review: L-/.test(l)).length, 10);
    ok(lines.includes("review: 他 2 件"));
  });
});

describe("feedback hint wiring", () => {
  it("keeps the USAGE line for feedback", async () => {
    const { deps } = setup();
    const r = await runLearningsCli(["help"], deps);
    ok(
      r.stdout.includes(
        "feedback <id> <helpful|mistimed|wrong> --at=<session|pre|fail|path>",
      ),
    );
    deepStrictEqual(r.exitCode, 0);
  });
});
